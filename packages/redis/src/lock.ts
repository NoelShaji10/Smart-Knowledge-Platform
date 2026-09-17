import crypto from 'crypto';
import { getRedisClient } from './client';

export class LockLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockLostError';
  }
}

export interface LockOptions {
  ttlMs?: number;
  renewalIntervalMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
}

export interface LockContext {
  lockId: string;
  resourceKey: string;
  isLockValid(): boolean;
  assertLockValid(): void;
  verifyOwnership(): Promise<void>;
  signal: AbortSignal;
}

export const DEFAULT_TTL_MS = 5000;
export const DEFAULT_RENEWAL_INTERVAL_MS = 1500;
export const DEFAULT_RETRY_DELAY_MS = 50;
export const DEFAULT_MAX_RETRIES = 200; // ~10 seconds total wait time

export const RENEW_LUA_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

export const RELEASE_LUA_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

type MutexEntry = {
  resolve: () => void;
};

export class AsyncKeyedMutex {
  private queues = new Map<string, MutexEntry[]>();
  private running = new Set<string>();

  async acquire(key: string): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      let queue = this.queues.get(key);
      if (!queue) {
        queue = [];
        this.queues.set(key, queue);
      }

      const tryRunNext = () => {
        if (!this.running.has(key)) {
          const next = queue!.shift();
          if (next) {
            this.running.add(key);
            next.resolve();
          } else {
            this.queues.delete(key);
          }
        }
      };

      const release = () => {
        this.running.delete(key);
        tryRunNext();
      };

      queue.push({
        resolve: () => resolve(release),
      });

      tryRunNext();
    });
  }
}

const localMutex = new AsyncKeyedMutex();

export interface DistributedLockHandle {
  resourceKey: string;
  redisKey: string;
  lockId: string;
  ttlMs: number;
}

/**
 * Acquire a distributed lock in Redis with ownership tracking.
 * Strictly fails closed if Redis is unavailable or if lock acquisition times out.
 */
export async function acquireRedisLock(
  resourceKey: string,
  options: LockOptions = {}
): Promise<DistributedLockHandle> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  const lockId = crypto.randomUUID();
  const redisKey = `lock:${resourceKey}`;

  let redis: any;
  try {
    redis = getRedisClient();
    if (!redis) {
      throw new Error('Redis client instance is null or undefined');
    }
  } catch (err: any) {
    throw new Error(`Failed to acquire distributed lock for ${resourceKey}: Redis client error: ${err?.message}`);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // SET key lockId PX ttlMs NX
      const res = await redis.set(redisKey, lockId, 'PX', ttlMs, 'NX');
      if (res === 'OK') {
        return {
          resourceKey,
          redisKey,
          lockId,
          ttlMs,
        };
      }
    } catch (err: any) {
      // Fail closed: do NOT silently downgrade to local-only locking
      throw new Error(`Failed to acquire distributed lock for ${resourceKey}: Redis error: ${err?.message}`);
    }

    if (attempt < maxRetries) {
      const jitter = Math.floor(Math.random() * 20);
      await new Promise((r) => setTimeout(r, retryDelayMs + jitter));
    }
  }

  throw new Error(`Timeout acquiring distributed lock for resource: ${resourceKey}`);
}

/**
 * Periodically renew a distributed lock in Redis.
 * Uses atomic Lua script verifying key value == lockId before extending TTL with pexpire.
 * Returns true if renewed, false if ownership was lost or Redis threw error.
 */
export async function renewRedisLock(
  handle: DistributedLockHandle,
  ttlMs: number
): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const result = await redis.eval(RENEW_LUA_SCRIPT, 1, handle.redisKey, handle.lockId, ttlMs);
    return result === 1;
  } catch (err: any) {
    // If Redis is unreachable or errors, ownership cannot be verified
    return false;
  }
}

/**
 * Release a distributed lock in Redis.
 * Uses atomic Lua script ensuring only the current lock owner can delete the key.
 */
export async function releaseRedisLock(handle: DistributedLockHandle): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const result = await redis.eval(RELEASE_LUA_SCRIPT, 1, handle.redisKey, handle.lockId);
    return result === 1;
  } catch (err: any) {
    console.warn(`[redis-lock] Error releasing lock for ${handle.resourceKey}: ${err?.message}`);
    return false;
  }
}

/**
 * Execute a critical section with a distributed Redis lease and in-process ordering mutex.
 * - Enforces fail-closed semantics: throws if Redis is unavailable or lock acquisition times out.
 * - Runs a periodic background heartbeat renewing the lock atomically via Lua.
 * - Detects lock ownership loss (key deleted, acquired by another owner, or Redis offline)
 *   and immediately aborts the critical section with LockLostError.
 * - Releases the lock via ownership-verified Lua script on completion.
 */
export async function withDistributedLock<T>(
  resourceKey: string,
  fn: (context: LockContext) => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const renewalIntervalMs =
    options.renewalIntervalMs ?? Math.min(DEFAULT_RENEWAL_INTERVAL_MS, Math.max(10, Math.floor(ttlMs / 3)));

  // In-process serialization: queues concurrent requests within this process
  const releaseLocal = await localMutex.acquire(resourceKey);
  let redisLock: DistributedLockHandle | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  const abortController = new AbortController();
  let isLockActive = false;
  let isCompleted = false;
  let lockLostError: LockLostError | null = null;

  let rejectLockLost!: (err: LockLostError) => void;
  const lockLostPromise = new Promise<never>((_, reject) => {
    rejectLockLost = reject;
  });

  const lockContext: LockContext = {
    get lockId() {
      return redisLock ? redisLock.lockId : '';
    },
    resourceKey,
    isLockValid: () => isLockActive && !lockLostError && !abortController.signal.aborted,
    assertLockValid: () => {
      if (!isLockActive || lockLostError || abortController.signal.aborted) {
        throw lockLostError || new LockLostError(`Lock ownership lost for resource: ${resourceKey}`);
      }
    },
    verifyOwnership: async () => {
      if (!isLockActive || lockLostError || abortController.signal.aborted || !redisLock) {
        throw lockLostError || new LockLostError(`Lock ownership lost for resource: ${resourceKey}`);
      }
      const renewed = await renewRedisLock(redisLock, ttlMs);
      if (!renewed) {
        isLockActive = false;
        lockLostError = new LockLostError(`Lock ownership lost for resource: ${resourceKey}`);
        abortController.abort(lockLostError);
        rejectLockLost(lockLostError);
        throw lockLostError;
      }
    },
    signal: abortController.signal,
  };

  try {
    // 1. Acquire distributed lock (fails closed if Redis down or times out)
    redisLock = await acquireRedisLock(resourceKey, options);
    isLockActive = true;

    // 2. Start lease renewal heartbeat
    heartbeatTimer = setInterval(async () => {
      if (isCompleted || !isLockActive || !redisLock) return;

      try {
        const renewed = await renewRedisLock(redisLock, ttlMs);
        if (!renewed && !isCompleted) {
          isLockActive = false;
          lockLostError = new LockLostError(`Lock ownership lost for resource: ${resourceKey}`);
          abortController.abort(lockLostError);
          rejectLockLost(lockLostError);
        }
      } catch (err: any) {
        if (!isCompleted) {
          isLockActive = false;
          lockLostError = new LockLostError(
            `Lock renewal failed for resource: ${resourceKey} (${err?.message})`
          );
          abortController.abort(lockLostError);
          rejectLockLost(lockLostError);
        }
      }
    }, renewalIntervalMs);

    // 3. Race user execution against lock loss
    const result = await Promise.race([
      fn(lockContext),
      lockLostPromise,
    ]);

    // Ensure lock is still valid before returning
    lockContext.assertLockValid();
    return result;
  } finally {
    isCompleted = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    isLockActive = false;

    if (redisLock) {
      try {
        await releaseRedisLock(redisLock);
      } catch {
        // Safe exception handling during release
      }
    }
    releaseLocal();
  }
}
