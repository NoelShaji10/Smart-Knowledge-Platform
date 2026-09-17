import crypto from 'crypto';
import { StaleFencingTokenError } from '@knowledge/types';
import { getRedisClient } from './client';

export { StaleFencingTokenError };

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
  minFencingToken?: number;
  skipLocalMutex?: boolean;
}

export interface LockContext {
  lockId: string;
  resourceKey: string;
  fencingToken: number;
  isLockValid(): boolean;
  assertLockValid(): void;
  verifyOwnership(): Promise<void>;
  signal: AbortSignal;
}

export const DEFAULT_TTL_MS = 5000;
export const DEFAULT_RENEWAL_INTERVAL_MS = 1500;
export const DEFAULT_RETRY_DELAY_MS = 50;
export const DEFAULT_MAX_RETRIES = 200; // ~10 seconds total wait time

/**
 * Atomic acquire script:
 * Sets lock key if not exists (NX) with expiration (PX).
 * If acquired, ensures fence key is at least minFencingToken and atomically increments it,
 * returning the new monotonically increasing fencing token.
 */
export const ACQUIRE_LOCK_LUA_SCRIPT = `
if redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2], "NX") then
  local minToken = tonumber(ARGV[3] or "0")
  local currentToken = tonumber(redis.call("get", KEYS[2]) or "0")
  if currentToken < minToken then
    redis.call("set", KEYS[2], minToken)
  end
  local token = redis.call("incr", KEYS[2])
  return token
else
  return nil
end
`;

/**
 * Atomic renew script:
 * Verifies key value == lockId AND fence token has not been superseded before extending TTL.
 */
export const RENEW_LUA_SCRIPT = `
local currentLock = redis.call("get", KEYS[1])
local currentFence = tonumber(redis.call("get", KEYS[2]) or "0")
local myToken = tonumber(ARGV[3] or "0")
if currentLock == ARGV[1] and (myToken == 0 or currentFence <= myToken) then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

/**
 * Atomic release script:
 * Ensures only the current lock owner can delete the lock key.
 * Does NOT delete the fence counter so monotonic ordering persists.
 */
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
  fenceKey: string;
  lockId: string;
  fencingToken: number;
  ttlMs: number;
}

/**
 * Acquire a distributed lock in Redis with ownership tracking and monotonic fencing token allocation.
 * Strictly fails closed if Redis is unavailable or if lock acquisition times out.
 */
export async function acquireRedisLock(
  resourceKey: string,
  options: LockOptions = {}
): Promise<DistributedLockHandle> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const minFencingToken = options.minFencingToken ?? 0;

  const lockId = crypto.randomUUID();
  const redisKey = `lock:${resourceKey}`;
  const fenceKey = `fence:${resourceKey}`;

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
      const res = await redis.eval(
        ACQUIRE_LOCK_LUA_SCRIPT,
        2,
        redisKey,
        fenceKey,
        lockId,
        ttlMs,
        minFencingToken
      );

      if (res !== null && res !== undefined) {
        return {
          resourceKey,
          redisKey,
          fenceKey,
          lockId,
          fencingToken: Number(res),
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
 * Uses atomic Lua script verifying key value == lockId AND fencing token has not been superseded.
 * Returns true if renewed, false if ownership was lost, token was superseded, or Redis threw error.
 */
export async function renewRedisLock(
  handle: DistributedLockHandle,
  ttlMs: number
): Promise<boolean> {
  try {
    const redis = getRedisClient();
    const result = await redis.eval(
      RENEW_LUA_SCRIPT,
      2,
      handle.redisKey,
      handle.fenceKey,
      handle.lockId,
      ttlMs,
      handle.fencingToken
    );
    return result === 1;
  } catch (err: any) {
    // If Redis is unreachable or errors, ownership cannot be verified
    return false;
  }
}

/**
 * Release a distributed lock in Redis.
 * Uses atomic Lua script ensuring only the current lock owner can delete the lock key.
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
 * Retrieve the current highest fencing token for a given resource from Redis.
 */
export async function getFencingToken(resourceKey: string): Promise<number> {
  const redis = getRedisClient();
  const val = await redis.get(`fence:${resourceKey}`);
  return val ? parseInt(val, 10) : 0;
}

/**
 * Validate whether a given fencing token is still current and has not been superseded.
 */
export async function validateFencingToken(
  resourceKey: string,
  fencingToken: number
): Promise<boolean> {
  const currentToken = await getFencingToken(resourceKey);
  return currentToken <= fencingToken;
}

/**
 * Assert that a fencing token is still current. Throws StaleFencingTokenError if superseded.
 */
export async function assertFencingTokenValid(
  resourceKey: string,
  fencingToken: number
): Promise<void> {
  const isValid = await validateFencingToken(resourceKey, fencingToken);
  if (!isValid) {
    const current = await getFencingToken(resourceKey);
    throw new StaleFencingTokenError(
      `Fencing token ${fencingToken} for resource ${resourceKey} has been superseded by token ${current}`
    );
  }
}

/**
 * Execute a critical section with a distributed Redis lease, monotonic fencing token, and in-process ordering mutex.
 * - Enforces fail-closed semantics: throws if Redis is unavailable or lock acquisition times out.
 * - Monotonically increments and assigns a fencing token on acquisition.
 * - Runs a periodic background heartbeat renewing the lock atomically via Lua.
 * - Detects lock ownership loss or token supersession and immediately aborts the critical section with LockLostError / StaleFencingTokenError.
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

  // In-process serialization: queues concurrent requests within this process unless skipLocalMutex is requested (for cross-instance testing)
  const releaseLocal = options.skipLocalMutex
    ? () => {}
    : await localMutex.acquire(resourceKey);

  let redisLock: DistributedLockHandle | null = null;
  let isLockActive = false;
  let isLoopActive = false;
  let loopTimeout: NodeJS.Timeout | null = null;
  let lockLostError: Error | null = null;

  const abortController = new AbortController();

  const handleLockLoss = (error: Error) => {
    if (isLockActive) {
      isLockActive = false;
      lockLostError = error;
      abortController.abort(error);
    }
  };

  const lockContext: LockContext = {
    get lockId() {
      return redisLock ? redisLock.lockId : '';
    },
    resourceKey,
    get fencingToken() {
      return redisLock ? redisLock.fencingToken : 0;
    },
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
        // Check if loss was due to fencing token supersession
        const currentToken = await getFencingToken(resourceKey).catch(() => 0);
        let err: Error;
        if (currentToken > redisLock.fencingToken) {
          err = new StaleFencingTokenError(
            `Lock fencing token ${redisLock.fencingToken} for resource ${resourceKey} was superseded by token ${currentToken}`
          );
        } else {
          err = new LockLostError(`Lock ownership lost for resource: ${resourceKey}`);
        }
        handleLockLoss(err);
        throw err;
      }
    },
    signal: abortController.signal,
  };

  // Sequential renewal loop: renew -> complete -> wait renewalIntervalMs -> renew
  let cancelSleep: (() => void) | null = null;

  const cancellableSleep = (ms: number): Promise<void> => {
    return new Promise<void>((resolve) => {
      cancelSleep = resolve;
      loopTimeout = setTimeout(() => {
        cancelSleep = null;
        resolve();
      }, ms);
    });
  };

  const wakeSleep = () => {
    if (loopTimeout) {
      clearTimeout(loopTimeout);
      loopTimeout = null;
    }
    if (cancelSleep) {
      const cb = cancelSleep;
      cancelSleep = null;
      cb();
    }
  };

  let renewalLoopPromise: Promise<void> | null = null;
  const startRenewalLoop = () => {
    isLoopActive = true;
    renewalLoopPromise = (async () => {
      while (isLoopActive && isLockActive && redisLock) {
        // Wait renewalIntervalMs before next renewal attempt
        await cancellableSleep(renewalIntervalMs);

        if (!isLoopActive || !isLockActive || !redisLock) break;

        try {
          const renewed = await renewRedisLock(redisLock, ttlMs);
          if (!renewed) {
            const currentToken = await getFencingToken(resourceKey).catch(() => 0);
            let err: Error;
            if (currentToken > redisLock.fencingToken) {
              err = new StaleFencingTokenError(
                `Lock fencing token ${redisLock.fencingToken} for resource ${resourceKey} was superseded by token ${currentToken}`
              );
            } else {
              err = new LockLostError(`Lock ownership lost for resource: ${resourceKey}`);
            }
            handleLockLoss(err);
            break;
          }
        } catch (err: any) {
          handleLockLoss(
            new LockLostError(`Lock renewal failed for resource: ${resourceKey} (${err?.message})`)
          );
          break;
        }
      }
    })();
  };

  try {
    // 1. Acquire distributed lock with atomic fencing token allocation (fails closed if Redis down or times out)
    redisLock = await acquireRedisLock(resourceKey, options);
    isLockActive = true;

    // 2. Start sequential lease renewal heartbeat
    startRenewalLoop();

    // 3. Await fn(lockContext) directly to ensure it settles before releaseLocal is called!
    let fnResult: T | undefined;
    let fnError: any = null;
    let fnThrew = false;

    try {
      fnResult = await fn(lockContext);
    } catch (err) {
      fnThrew = true;
      fnError = err;
    }

    // 4. Verify lock validity after execution
    if (lockLostError || !isLockActive || abortController.signal.aborted) {
      throw lockLostError || new LockLostError(`Lock ownership lost for resource: ${resourceKey}`);
    }

    if (fnThrew) {
      throw fnError;
    }

    return fnResult as T;
  } finally {
    // Stop renewal loop
    isLoopActive = false;
    wakeSleep();
    if (renewalLoopPromise) {
      try {
        await renewalLoopPromise;
      } catch {
        // Safe handling
      }
    }
    isLockActive = false;

    // Release Redis lock via Lua (only deletes if current value == lockId)
    if (redisLock) {
      try {
        await releaseRedisLock(redisLock);
      } catch {
        // Safe exception handling during release
      }
    }

    // Release in-process mutex ONLY AFTER fn has completely settled!
    releaseLocal();
  }
}
