import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError, Workspace, Document } from '../lib/api';

describe('Frontend Fallback Remediation Tests', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Successful workspace loading displays real API data', async () => {
    const realWorkspaces: Workspace[] = [
      {
        id: 'ws-real-123',
        name: 'Real PostgreSQL Workspace',
        slug: 'real-postgres-workspace',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ workspaces: realWorkspaces }),
    });

    const res = await api.getWorkspaces();
    expect(res.workspaces).toHaveLength(1);
    expect(res.workspaces[0].id).toBe('ws-real-123');
    expect(res.workspaces[0].name).toBe('Real PostgreSQL Workspace');
    expect(res.workspaces[0].id).not.toBe('demo-workspace-1');
  });

  it('2. Workspace 500 throws ApiError and does NOT return demo-workspace-1', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal Server Error' }),
    });

    try {
      await api.getWorkspaces();
      expect.unreachable('Should have thrown ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(500);
      expect(apiErr.message).not.toContain('demo-workspace-1');
    }
  });

  it('3. Workspace network failure (status 0) throws ApiError with status 0 and does NOT produce demo-workspace-1', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    try {
      await api.getWorkspaces();
      expect.unreachable('Should have thrown ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(0);
      expect(apiErr.message).toBe('Network error or server unavailable');
    }
  });

  it('4. Workspace Retry attempts the request again', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ error: 'Database Temporary Error' }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          workspaces: [
            {
              id: 'ws-retry-success',
              name: 'Retry Succeeded Workspace',
              slug: 'retry-succeeded-workspace',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    // Attempt 1: Fails with 500
    await expect(api.getWorkspaces()).rejects.toThrow();
    expect(callCount).toBe(1);

    // Attempt 2 (Retry): Succeeds
    const retryRes = await api.getWorkspaces();
    expect(callCount).toBe(2);
    expect(retryRes.workspaces[0].id).toBe('ws-retry-success');
  });

  it('5. Successful document loading displays real API data', async () => {
    const realDoc: Document = {
      id: 'doc-real-456',
      workspace_id: 'ws-123',
      parent_id: null,
      title: 'Real Persisted Title',
      content_text: '<p>Real Persisted Content</p>',
      snapshot_version: 3,
      is_archived: false,
      created_by: 'usr-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        document: realDoc,
        capabilities: { canRead: true, canEdit: true },
      }),
    });

    const res = await api.getDocument('ws-123', 'doc-real-456');
    expect(res.document.id).toBe('doc-real-456');
    expect(res.document.title).toBe('Real Persisted Title');
    expect(res.document.content_text).toBe('<p>Real Persisted Content</p>');
  });

  it('6. Document 500 throws ApiError status 500 and does NOT produce default "Untitled Document"', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal Database Error' }),
    });

    try {
      await api.getDocument('ws-123', 'doc-real-456');
      expect.unreachable('Should have thrown ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(500);
    }
  });

  it('7. Document network failure (status 0) throws ApiError status 0 and does NOT produce default template content', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    try {
      await api.getDocument('ws-123', 'doc-real-456');
      expect.unreachable('Should have thrown ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(0);
    }
  });

  it('8. Document Retry attempts the request again', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: async () => ({ error: 'Service Unavailable' }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          document: {
            id: 'doc-real-456',
            workspace_id: 'ws-123',
            parent_id: null,
            title: 'Retried Document Title',
            content_text: '<p>Retried Document Content</p>',
            snapshot_version: 1,
            is_archived: false,
            created_by: 'usr-1',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          capabilities: { canRead: true, canEdit: true },
        }),
      });
    });

    // Attempt 1: Fails with 503
    await expect(api.getDocument('ws-123', 'doc-real-456')).rejects.toThrow();
    expect(callCount).toBe(1);

    // Attempt 2 (Retry): Succeeds
    const res = await api.getDocument('ws-123', 'doc-real-456');
    expect(callCount).toBe(2);
    expect(res.document.title).toBe('Retried Document Title');
  });

  it('9. Existing 401/403/404 behavior remains correct', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/v1/auth/refresh')) {
        return Promise.resolve({ ok: false, status: 401, json: async () => ({ error: 'Invalid refresh token' }) });
      }
      if (url.includes('doc-401')) {
        return Promise.resolve({ ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) });
      }
      if (url.includes('doc-403')) {
        return Promise.resolve({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: 'Not Found' }) });
    });

    await expect(api.getDocument('ws-123', 'doc-401')).rejects.toThrow();
    await expect(api.getDocument('ws-123', 'doc-403')).rejects.toThrow('Forbidden');
    await expect(api.getDocument('ws-123', 'doc-404')).rejects.toThrow('Not Found');
  });
});
