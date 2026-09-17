import crypto from 'crypto';
import { getRedisClient } from './client';

export interface LockOptions {
  ttlMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
}

const DEFAULT_TTL_MS = 15000;
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_MAX_RETRIES = 200; // 10 seconds total wait time

const RELEASE_LUA_SCRIPT = `
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
}

export async function acquireRedisLock(
  resourceKey: string,
  options: LockOptions = {}
): Promise<DistributedLockHandle | null> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  const lockId = crypto.randomUUID();
  const redisKey = `lock:${resourceKey}`;

  let redis: any;
  try {
    redis = getRedisClient();
  } catch {
    return null;
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
        };
      }
    } catch (err: any) {
      // If Redis connection fails or is offline, fall back gracefully
      console.warn(`[redis-lock] Redis error during lock acquisition for ${resourceKey}: ${err?.message}`);
      return null;
    }

    if (attempt < maxRetries) {
      const jitter = Math.floor(Math.random() * 20);
      await new Promise((r) => setTimeout(r, retryDelayMs + jitter));
    }
  }

  throw new Error(`Timeout acquiring distributed lock for resource: ${resourceKey}`);
}

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
 * Execute a critical section serialized by both a local async mutex (for same-process coordination)
 * and a distributed Redis lock (for multi-instance cluster coordination).
 */
export async function withDistributedLock<T>(
  resourceKey: string,
  fn: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const releaseLocal = await localMutex.acquire(resourceKey);
  let redisLock: DistributedLockHandle | null = null;

  try {
    redisLock = await acquireRedisLock(resourceKey, options);
    return await fn();
  } finally {
    if (redisLock) {
      try {
        await releaseRedisLock(redisLock);
      } catch {
        // Safe exception handling
      }
    }
    releaseLocal();
  }
}
