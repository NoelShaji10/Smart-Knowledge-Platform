import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  api,
  ApiError,
  setAccessToken,
  getAccessToken,
  refreshAccessTokenSingleFlight,
} from '../lib/api';

describe('API Client & Single-Flight Token Refresh', () => {
  beforeEach(() => {
    setAccessToken(null);
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('manages access token in memory', () => {
    expect(getAccessToken()).toBeNull();
    setAccessToken('test-jwt-token');
    expect(getAccessToken()).toBe('test-jwt-token');
  });

  it('performs single-flight token refresh when multiple requests receive 401', async () => {
    let refreshCallCount = 0;

    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/v1/auth/refresh')) {
        refreshCallCount++;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ accessToken: 'new-refreshed-token' }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });
    });

    const promise1 = refreshAccessTokenSingleFlight();
    const promise2 = refreshAccessTokenSingleFlight();
    const promise3 = refreshAccessTokenSingleFlight();

    const results = await Promise.all([promise1, promise2, promise3]);

    expect(results).toEqual(['new-refreshed-token', 'new-refreshed-token', 'new-refreshed-token']);
    expect(refreshCallCount).toBe(1);
    expect(getAccessToken()).toBe('new-refreshed-token');
  });

  it('normalizes network errors into ApiError with status 0', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(api.getWorkspaces()).rejects.toThrow('Network error or server unavailable');
  });
});
