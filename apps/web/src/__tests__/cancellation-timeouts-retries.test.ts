import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  apiRequest,
  ApiError,
  isAbortError,
  isRetryableError,
  withRetry,
} from '../lib/api';

describe('Task 3: Cancellation, Timeouts, and Retries', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('correctly identifies AbortError with isAbortError', () => {
    const abortErr = new Error('The user aborted a request.');
    abortErr.name = 'AbortError';
    expect(isAbortError(abortErr)).toBe(true);

    const normalErr = new Error('Generic error');
    expect(isAbortError(normalErr)).toBe(false);

    const apiErr = new ApiError('Not found', 404);
    expect(isAbortError(apiErr)).toBe(false);
  });

  it('preserves native AbortError on cancellation without converting to ApiError(0)', async () => {
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError);

    const controller = new AbortController();
    controller.abort();

    await expect(
      apiRequest('/api/v1/workspaces', { signal: controller.signal }),
    ).rejects.toSatisfy((err) => {
      return (
        err instanceof Error &&
        err.name === 'AbortError' &&
        !(err instanceof ApiError)
      );
    });
  });

  it('enforces request timeout when timeoutMs is exceeded, throwing ApiError(408)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, options) => {
      return new Promise((_resolve, reject) => {
        // Listen to the signal attached by apiRequest timeout
        options?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    await expect(
      apiRequest('/api/v1/workspaces', { timeoutMs: 50 }),
    ).rejects.toSatisfy((err) => {
      return (
        err instanceof ApiError &&
        err.status === 408 &&
        err.message.includes('timed out')
      );
    });
  });

  it('distinguishes retryable vs non-retryable errors correctly', () => {
    // Retryable: network offline (0), timeout (408), rate limit (429), gateway (502), unavailable (503), gateway timeout (504)
    expect(isRetryableError(new ApiError('Offline', 0))).toBe(true);
    expect(isRetryableError(new ApiError('Timeout', 408))).toBe(true);
    expect(isRetryableError(new ApiError('Rate limit', 429))).toBe(true);
    expect(isRetryableError(new ApiError('Bad Gateway', 502))).toBe(true);
    expect(isRetryableError(new ApiError('Unavailable', 503))).toBe(true);

    // Non-retryable: validation (400), auth (401), forbidden (403), missing (404), conflict (409), unprocessable (422)
    expect(isRetryableError(new ApiError('Bad Request', 400))).toBe(false);
    expect(isRetryableError(new ApiError('Unauthorized', 401))).toBe(false);
    expect(isRetryableError(new ApiError('Forbidden', 403))).toBe(false);
    expect(isRetryableError(new ApiError('Not Found', 404))).toBe(false);
    expect(isRetryableError(new ApiError('Conflict', 409))).toBe(false);
    expect(isRetryableError(new ApiError('Unprocessable', 422))).toBe(false);
  });

  it('withRetry retries retryable failures up to maxRetries and throws truthful error on exhaustion', async () => {
    let callCount = 0;
    const failingOp = vi.fn(async () => {
      callCount++;
      throw new ApiError('Service unavailable', 503);
    });

    await expect(
      withRetry(failingOp, { maxRetries: 2, initialDelayMs: 10, maxDelayMs: 20 }),
    ).rejects.toSatisfy((err) => {
      return err instanceof ApiError && err.status === 503;
    });

    // 1 initial attempt + 2 retries = 3 calls total
    expect(callCount).toBe(3);
  });

  it('withRetry fails fast and does NOT retry non-retryable client errors (400, 403, 404, 409)', async () => {
    let callCount = 0;
    const nonRetryableOp = vi.fn(async () => {
      callCount++;
      throw new ApiError('Document not found', 404);
    });

    await expect(
      withRetry(nonRetryableOp, { maxRetries: 3, initialDelayMs: 10 }),
    ).rejects.toSatisfy((err) => {
      return err instanceof ApiError && err.status === 404;
    });

    // Exactly 1 call: no retry on 404
    expect(callCount).toBe(1);
  });

  it('withRetry stops immediately on AbortError without retrying', async () => {
    let callCount = 0;
    const abortedOp = vi.fn(async () => {
      callCount++;
      const abortErr = new Error('Aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    });

    await expect(
      withRetry(abortedOp, { maxRetries: 3, initialDelayMs: 10 }),
    ).rejects.toSatisfy((err) => {
      return (err as Error).name === 'AbortError';
    });

    expect(callCount).toBe(1);
  });
});
