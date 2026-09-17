import { describe, it, expect, vi, afterEach } from 'vitest';
import { getDocChannel } from './pubsub';
import {
  AsyncKeyedMutex,
  withDistributedLock,
  acquireRedisLock,
  renewRedisLock,
  releaseRedisLock,
  LockLostError,
  StaleFencingTokenError,
  getFencingToken,
  validateFencingToken,
  assertFencingTokenValid,
} from './lock';
import { getRedisClient } from './client';

describe('redis pubsub channel helpers', () => {
  it('formats document channel names correctly', () => {
    expect(getDocChannel('doc-123')).toBe('doc:doc-123');
  });
});

describe('AsyncKeyedMutex (in-process ordering)', () => {
  it('serializes concurrent executions for the same key', async () => {
    const mutex = new AsyncKeyedMutex();
    const executionOrder: number[] = [];

    const op1 = async () => {
      const release = await mutex.acquire('key1');
      await new Promise((r) => setTimeout(r, 50));
      executionOrder.push(1);
      release();
    };

    const op2 = async () => {
      const release = await mutex.acquire('key1');
      executionOrder.push(2);
      release();
    };

    await Promise.all([op1(), op2()]);
    expect(executionOrder).toEqual([1, 2]);
  });

  it('allows parallel executions for different keys', async () => {
    const mutex = new AsyncKeyedMutex();
    const executionOrder: string[] = [];

    const opA = async () => {
      const release = await mutex.acquire('keyA');
      await new Promise((r) => setTimeout(r, 30));
      executionOrder.push('A');
      release();
    };

    const opB = async () => {
      const release = await mutex.acquire('keyB');
      executionOrder.push('B');
      release();
    };

    await Promise.all([opA(), opB()]);
    expect(executionOrder).toEqual(['B', 'A']);
  });
});

describe('Production Redis Distributed Lease & Lock Semantics', () => {
  const redis = getRedisClient();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. renews lock periodically while critical section runs longer than initial TTL', async () => {
    const key = `renew-test-${Date.now()}`;
    let checkedTtlDuringExecution = 0;
    let checkedValueDuringExecution: string | null = null;

    // Initial TTL: 300ms, renewal every 100ms. Execution lasts 600ms (2x TTL).
    const result = await withDistributedLock(
      key,
      async (ctx) => {
        expect(ctx.isLockValid()).toBe(true);

        // Sleep past initial 300ms TTL
        await new Promise((r) => setTimeout(r, 450));

        // Verify key in real Redis is still alive and owned by us
        const redisKey = `lock:${key}`;
        checkedValueDuringExecution = await redis.get(redisKey);
        checkedTtlDuringExecution = await redis.pttl(redisKey);

        expect(ctx.isLockValid()).toBe(true);
        return 'done';
      },
      { ttlMs: 300, renewalIntervalMs: 100 }
    );

    expect(result).toBe('done');
    expect(checkedValueDuringExecution).toBeTruthy();
    expect(checkedTtlDuringExecution).toBeGreaterThan(0);

    // After release, key is cleanly deleted
    const finalVal = await redis.get(`lock:${key}`);
    expect(finalVal).toBeNull();
  });

  it('2. prevents another process from acquiring lock while renewal is keeping it active', async () => {
    const key = `contention-test-${Date.now()}`;

    let holderActive = false;
    let competitorBlocked = false;

    const holderPromise = withDistributedLock(
      key,
      async (ctx) => {
        holderActive = true;
        // Hold lock for 400ms with 200ms TTL (requires renewal)
        await new Promise((r) => setTimeout(r, 400));
        ctx.assertLockValid();
        holderActive = false;
        return 'holder-done';
      },
      { ttlMs: 200, renewalIntervalMs: 70 }
    );

    // Competitor attempts to acquire the same lock while holder is running past initial TTL
    const competitorPromise = (async () => {
      // Wait until holder is in critical section past initial TTL
      await new Promise((r) => setTimeout(r, 250));
      // Try to acquire directly via Redis without local mutex
      try {
        await acquireRedisLock(key, { ttlMs: 200, maxRetries: 3, retryDelayMs: 20 });
        return 'acquired';
      } catch (err: any) {
        competitorBlocked = true;
        return 'timed-out';
      }
    })();

    const [holderRes, compRes] = await Promise.all([holderPromise, competitorPromise]);
    expect(holderRes).toBe('holder-done');
    expect(compRes).toBe('timed-out');
    expect(competitorBlocked).toBe(true);
  });

  it('3. renewal verifies ownership via Lua and cannot extend another owner lock', async () => {
    const key = `hijack-test-${Date.now()}`;
    const handle = await acquireRedisLock(key, { ttlMs: 1000 });

    try {
      // Another process hijacks or takes over key
      await redis.set(`lock:${key}`, 'other-owner-uuid', 'PX', 2000);

      // Attempt renewal with handle's original lockId
      const renewed = await renewRedisLock(handle, 3000);
      expect(renewed).toBe(false);

      // Key still belongs to other-owner-uuid and was not renewed to 3000ms
      const val = await redis.get(`lock:${key}`);
      expect(val).toBe('other-owner-uuid');
    } finally {
      await redis.del(`lock:${key}`);
    }
  });

  it('4. detects lock ownership loss when key is deleted and fails closed with LockLostError', async () => {
    const key = `loss-test-${Date.now()}`;
    let executedToTheEnd = false;

    const promise = withDistributedLock(
      key,
      async (ctx) => {
        // Sleep a bit, then delete key externally
        await new Promise((r) => setTimeout(r, 100));
        await redis.del(`lock:${key}`);

        // Wait for renewal interval to trigger and detect loss
        await new Promise((r) => setTimeout(r, 200));
        ctx.assertLockValid();
        executedToTheEnd = true;
      },
      { ttlMs: 400, renewalIntervalMs: 50 }
    );

    await expect(promise).rejects.toThrow(LockLostError);
    expect(executedToTheEnd).toBe(false);
  });

  it('5. detects Redis renewal failure / disconnection and aborts critical section', async () => {
    const key = `err-loss-test-${Date.now()}`;
    let executedToTheEnd = false;

    const evalSpy = vi.spyOn(redis, 'eval').mockImplementation(async (script: any, ...args: any[]) => {
      // If it's the renewal script, simulate network connection lost
      if (typeof script === 'string' && script.includes('pexpire')) {
        throw new Error('Connection lost to Redis cluster');
      }
      return 1;
    });

    try {
      const promise = withDistributedLock(
        key,
        async (ctx) => {
          await new Promise((r) => setTimeout(r, 250));
          ctx.assertLockValid();
          executedToTheEnd = true;
        },
        { ttlMs: 500, renewalIntervalMs: 50 }
      );

      await expect(promise).rejects.toThrow(LockLostError);
      expect(executedToTheEnd).toBe(false);
    } finally {
      evalSpy.mockRestore();
    }
  });

  it('6. fails closed when Redis is unavailable before acquisition (no silent local downgrade)', async () => {
    const key = `fail-closed-test-${Date.now()}`;
    const evalSpy = vi.spyOn(redis, 'eval').mockRejectedValue(new Error('ECONNREFUSED'));

    let callbackExecuted = false;

    try {
      await expect(
        withDistributedLock(key, async () => {
          callbackExecuted = true;
          return 'should-not-run';
        })
      ).rejects.toThrow(/Failed to acquire distributed lock/);

      expect(callbackExecuted).toBe(false);
    } finally {
      evalSpy.mockRestore();
    }
  });

  it('7. release script cannot delete another owner lock', async () => {
    const key = `safe-release-test-${Date.now()}`;
    const handle = await acquireRedisLock(key, { ttlMs: 1000 });

    try {
      // Overwrite with owner B
      await redis.set(`lock:${key}`, 'owner-b-id', 'PX', 5000);

      // Handle A tries to release
      const released = await releaseRedisLock(handle);
      expect(released).toBe(false);

      // Key still belongs to owner B!
      const current = await redis.get(`lock:${key}`);
      expect(current).toBe('owner-b-id');
    } finally {
      await redis.del(`lock:${key}`);
    }
  });

  it('8. multiple independent instances (separate lock handles) maintain strict mutual exclusion', async () => {
    const key = `multi-instance-${Date.now()}`;
    const activeInstances: number[] = [];
    let overlapDetected = false;

    // Simulate 2 independent collab instances with separate lock requests
    const runInstance = async (id: number) => {
      // Directly call acquireRedisLock to simulate separate processes (bypassing shared localMutex)
      const handle = await acquireRedisLock(key, { ttlMs: 1000, maxRetries: 100, retryDelayMs: 20 });
      try {
        activeInstances.push(id);
        if (activeInstances.length > 1) {
          overlapDetected = true;
        }
        await new Promise((r) => setTimeout(r, 60));
        activeInstances.splice(activeInstances.indexOf(id), 1);
      } finally {
        await releaseRedisLock(handle);
      }
    };

    await Promise.all([runInstance(1), runInstance(2)]);
    expect(overlapDetected).toBe(false);
    expect(activeInstances.length).toBe(0);
  });

  it('9. outer withDistributedLock promise does not settle while inner fn is still executing', async () => {
    const key = `settlement-test-${Date.now()}`;
    let innerSettled = false;
    let outerSettled = false;
    let outerSettledBeforeInner = false;

    const promise = withDistributedLock(
      key,
      async (ctx) => {
        // Sleep 40ms, then delete key
        await new Promise((r) => setTimeout(r, 40));
        await redis.del(`lock:${key}`);

        // In-flight work that takes another 160ms to settle
        await new Promise((r) => setTimeout(r, 160));
        innerSettled = true;

        ctx.assertLockValid();
      },
      { ttlMs: 400, renewalIntervalMs: 30 }
    ).catch((err) => {
      outerSettled = true;
      if (!innerSettled) {
        outerSettledBeforeInner = true;
      }
      throw err;
    });

    await expect(promise).rejects.toThrow(LockLostError);
    expect(innerSettled).toBe(true);
    expect(outerSettled).toBe(true);
    expect(outerSettledBeforeInner).toBe(false);
  });

  it('10. second owner cannot enter while unfinished work from first owner remains active', async () => {
    const key = `no-overlap-test-${Date.now()}`;
    let owner1Active = false;
    let owner2SawOwner1Active = false;

    // Owner 1 runs and loses its lock, but takes 150ms to finish its current async step
    const owner1Promise = withDistributedLock(
      key,
      async (ctx) => {
        owner1Active = true;
        await new Promise((r) => setTimeout(r, 40));
        // Simulate lock loss
        await redis.del(`lock:${key}`);
        // Slow in-flight I/O settling
        await new Promise((r) => setTimeout(r, 120));
        owner1Active = false;
        ctx.assertLockValid();
      },
      { ttlMs: 400, renewalIntervalMs: 30 }
    ).catch(() => 'owner1-failed-closed');

    // Owner 2 tries to acquire the same key
    const owner2Promise = (async () => {
      // Slight delay so Owner 1 enters first
      await new Promise((r) => setTimeout(r, 20));
      return await withDistributedLock(
        key,
        async () => {
          if (owner1Active) {
            owner2SawOwner1Active = true;
          }
          return 'owner2-done';
        },
        { ttlMs: 400, renewalIntervalMs: 50, maxRetries: 50, retryDelayMs: 20 }
      );
    })();

    const [res1, res2] = await Promise.all([owner1Promise, owner2Promise]);
    expect(res1).toBe('owner1-failed-closed');
    expect(res2).toBe('owner2-done');
    // Crucial check: Owner 2 must NEVER execute concurrently with Owner 1's unfinished work!
    expect(owner2SawOwner1Active).toBe(false);
  });

  it('11. sequential renewal loop never issues overlapping concurrent renewal calls', async () => {
    const key = `loop-concurrency-${Date.now()}`;
    let activeRenewals = 0;
    let maxConcurrentRenewals = 0;

    const evalSpy = vi.spyOn(redis, 'eval').mockImplementation(async (script: any, ...args: any[]) => {
      if (typeof script === 'string' && script.includes('pexpire')) {
        activeRenewals++;
        maxConcurrentRenewals = Math.max(maxConcurrentRenewals, activeRenewals);
        // Simulate slight network delay
        await new Promise((r) => setTimeout(r, 30));
        activeRenewals--;
        return 1;
      }
      // Release script
      return 1;
    });

    try {
      await withDistributedLock(
        key,
        async () => {
          // Wait across multiple renewal iterations
          await new Promise((r) => setTimeout(r, 200));
          return 'ok';
        },
        { ttlMs: 300, renewalIntervalMs: 30 }
      );

      expect(maxConcurrentRenewals).toBe(1);
    } finally {
      evalSpy.mockRestore();
    }
  });

  it('12. monotonically allocates strictly increasing fencing tokens across acquisitions', async () => {
    const key = `monotonic-fence-${Date.now()}`;
    const handle1 = await acquireRedisLock(key, { ttlMs: 1000 });
    expect(handle1.fencingToken).toBeGreaterThanOrEqual(1);

    await releaseRedisLock(handle1);

    const handle2 = await acquireRedisLock(key, { ttlMs: 1000 });
    expect(handle2.fencingToken).toBe(handle1.fencingToken + 1);

    await releaseRedisLock(handle2);

    const handle3 = await acquireRedisLock(key, { ttlMs: 1000 });
    expect(handle3.fencingToken).toBe(handle2.fencingToken + 1);

    await releaseRedisLock(handle3);
    await redis.del(`fence:${key}`);
  });

  it('13. detects fencing token supersession on lease renewal and rejects with StaleFencingTokenError', async () => {
    const key = `fence-supersede-${Date.now()}`;

    // Instance A acquires token N
    const handleA = await acquireRedisLock(key, { ttlMs: 2000 });
    expect(handleA.fencingToken).toBeGreaterThanOrEqual(1);

    try {
      // Simulate Instance B acquiring on another node after expiration/force-takeover
      // Force fence token to increment to N+1
      await redis.incr(`fence:${key}`);

      // Instance A attempts lease renewal with its stale token
      const renewed = await renewRedisLock(handleA, 2000);
      expect(renewed).toBe(false);

      // validateFencingToken rejects Instance A's token
      const isValid = await validateFencingToken(key, handleA.fencingToken);
      expect(isValid).toBe(false);

      await expect(assertFencingTokenValid(key, handleA.fencingToken)).rejects.toThrow(
        StaleFencingTokenError
      );
    } finally {
      await releaseRedisLock(handleA);
      await redis.del(`fence:${key}`);
    }
  });

  it('14. withDistributedLock context provides accurate fencingToken and verifyOwnership checks', async () => {
    const key = `ctx-fence-${Date.now()}`;
    let tokenObserved = 0;

    await withDistributedLock(key, async (ctx) => {
      tokenObserved = ctx.fencingToken;
      expect(ctx.fencingToken).toBeGreaterThanOrEqual(1);
      expect(ctx.isLockValid()).toBe(true);
      await ctx.verifyOwnership();
    });

    expect(tokenObserved).toBeGreaterThanOrEqual(1);
    await redis.del(`fence:${key}`);
  });

  it('15. cross-instance scenario: Instance A rejected when Instance B acquires higher token', async () => {
    const key = `cross-instance-supersede-${Date.now()}`;
    let instanceAAttemptedStaleWrite = false;
    let instanceAThrewStaleError = false;

    // Instance A runs under withDistributedLock
    const instanceAPromise = withDistributedLock(
      key,
      async (ctxA) => {
        const tokenA = ctxA.fencingToken;
        expect(tokenA).toBeGreaterThanOrEqual(1);

        // Instance A starts in-flight async work
        await new Promise((r) => setTimeout(r, 60));

        // Lease lost in Redis: lock key expires / deleted
        await redis.del(`lock:${key}`);

        // Instance B acquires lock on another instance with token N+1
        const handleB = await acquireRedisLock(key, { ttlMs: 2000 });
        expect(handleB.fencingToken).toBe(tokenA + 1);

        // Instance A's delayed work wakes up and tries verifyOwnership
        instanceAAttemptedStaleWrite = true;
        try {
          await ctxA.verifyOwnership();
        } catch (err) {
          if (err instanceof StaleFencingTokenError) {
            instanceAThrewStaleError = true;
          }
          throw err;
        } finally {
          await releaseRedisLock(handleB);
        }
      },
      { ttlMs: 500, renewalIntervalMs: 50 }
    ).catch((err) => {
      return 'instanceA-rejected';
    });

    const result = await instanceAPromise;
    expect(result).toBe('instanceA-rejected');
    expect(instanceAAttemptedStaleWrite).toBe(true);
    expect(instanceAThrewStaleError).toBe(true);

    await redis.del(`fence:${key}`);
  });
});



