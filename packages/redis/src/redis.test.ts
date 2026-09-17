import { describe, it, expect, vi, afterEach } from 'vitest';
import { getDocChannel } from './pubsub';
import {
  AsyncKeyedMutex,
  withDistributedLock,
  acquireRedisLock,
  renewRedisLock,
  releaseRedisLock,
  LockLostError,
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
    const setSpy = vi.spyOn(redis, 'set').mockRejectedValue(new Error('ECONNREFUSED'));

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
      setSpy.mockRestore();
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
});


