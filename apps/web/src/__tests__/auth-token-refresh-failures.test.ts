import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  apiRequest,
  api,
  ApiError,
  setAccessToken,
  getAccessToken,
  onAuthFailure,
  refreshAccessTokenSingleFlight,
} from '../lib/api';

describe('Task 5: Authentication and Token Refresh Failures', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setAccessToken(null);
  });

  it('coalesces multiple concurrent 401 requests into exactly ONE refresh request (single-flight)', async () => {
    setAccessToken('stale-token');
    let refreshCallCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/v1/auth/refresh')) {
        refreshCallCount++;
        // Return refreshed token
        return new Response(JSON.stringify({ accessToken: 'new-valid-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (urlStr.includes('/api/v1/protected')) {
        // If request has new token, return success; otherwise return 401
        return new Response(JSON.stringify({ data: 'secret' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(null, { status: 404 });
    });

    // Fire 5 concurrent requests to refreshAccessTokenSingleFlight
    const promises = [
      refreshAccessTokenSingleFlight(),
      refreshAccessTokenSingleFlight(),
      refreshAccessTokenSingleFlight(),
      refreshAccessTokenSingleFlight(),
      refreshAccessTokenSingleFlight(),
    ];

    const results = await Promise.all(promises);

    expect(results).toEqual([
      'new-valid-token',
      'new-valid-token',
      'new-valid-token',
      'new-valid-token',
      'new-valid-token',
    ]);
    expect(refreshCallCount).toBe(1);
    expect(getAccessToken()).toBe('new-valid-token');
  });

  it('handles expired/revoked refresh token (401): invalidates token and calls auth failure listener', async () => {
    setAccessToken('expired-token');
    const authFailureListener = vi.fn();
    const unsub = onAuthFailure(authFailureListener);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid refresh token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(refreshAccessTokenSingleFlight()).rejects.toSatisfy((err) => {
      return err instanceof ApiError && err.status === 401 && err.message === 'Invalid refresh token';
    });

    expect(getAccessToken()).toBeNull();
    expect(authFailureListener).toHaveBeenCalledTimes(1);

    unsub();
  });

  it('network error on refresh does not trigger onAuthFailure (preserves offline session state)', async () => {
    setAccessToken('saved-token');
    const authFailureListener = vi.fn();
    const unsub = onAuthFailure(authFailureListener);

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Failed to fetch'));

    await expect(refreshAccessTokenSingleFlight()).rejects.toSatisfy((err) => {
      return err instanceof ApiError && err.status === 0;
    });

    // Access token is cleared in memory to prevent invalid queries, but auth failure (logout) is NOT fired
    expect(getAccessToken()).toBeNull();
    expect(authFailureListener).not.toHaveBeenCalled();

    unsub();
  });

  it('prevents infinite refresh loop when retry still receives 401', async () => {
    setAccessToken('token-1');
    let refreshCalls = 0;
    let requestCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/v1/auth/refresh')) {
        refreshCalls++;
        return new Response(JSON.stringify({ accessToken: 'token-2' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      requestCalls++;
      // Server always rejects endpoint with 401
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await expect(apiRequest('/api/v1/protected')).rejects.toSatisfy((err) => {
      return err instanceof ApiError && err.status === 401;
    });

    // Initial attempt (1) + 1 refresh (1) + 1 retry with new token (1) = 2 endpoint calls, 1 refresh call total
    expect(requestCalls).toBe(2);
    expect(refreshCalls).toBe(1);
  });

  it('api.logout always clears accessToken even if backend responds with 500 error', async () => {
    setAccessToken('valid-token');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    // Should not throw or crash
    await api.logout();

    expect(getAccessToken()).toBeNull();
  });

  it('api.logoutAll returns { ok: true, remoteRevoked: true } and clears accessToken when backend succeeds', async () => {
    setAccessToken('valid-token');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await api.logoutAll();

    expect(result).toEqual({ ok: true, remoteRevoked: true });
    expect(getAccessToken()).toBeNull();
  });

  it('api.logoutAll returns { ok: true, remoteRevoked: false } and unconditionally clears accessToken when backend fails with 500', async () => {
    setAccessToken('valid-token');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Database unreachable' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await api.logoutAll();

    // Client session must be cleared to prevent lock-in, but remoteRevoked must be false
    expect(result).toEqual({ ok: true, remoteRevoked: false });
    expect(getAccessToken()).toBeNull();
  });

  it('api.logoutAll returns { ok: true, remoteRevoked: false } and unconditionally clears accessToken when network drops', async () => {
    setAccessToken('valid-token');

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network offline or DNS failure'));

    const result = await api.logoutAll();

    expect(result).toEqual({ ok: true, remoteRevoked: false });
    expect(getAccessToken()).toBeNull();
  });
});

