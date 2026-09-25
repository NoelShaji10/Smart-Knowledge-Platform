import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { StaleFencingTokenError } from '@knowledge/redis';
import { getEnv } from '@knowledge/config';
import * as database from '@knowledge/database';
import { createCollabServer } from '../server';
import * as roomManager from '../room-manager';

describe('Task 6: Collaboration and Persistence Failure Semantics', () => {
  const docId = '11111111-1111-1111-1111-111111111111';
  const workspaceId = '22222222-2222-2222-2222-222222222222';
  const userId = '33333333-3333-3333-3333-333333333333';
  const internalKey = getEnv().INTERNAL_SERVICE_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();

    // Mock database context chaining to allow verifyUserCanEditDocument to succeed for our test user/doc
    vi.spyOn(database, 'withSystemContext').mockImplementation(async (fn: any) => {
      const queryBuilder = (table: string) => {
        const q: any = {
          where: () => q,
          select: () => q,
          executeTakeFirst: async () => {
            if (table === 'users') {
              return { id: userId };
            }
            if (table === 'documents') {
              return { workspace_id: workspaceId, is_archived: false };
            }
            if (table === 'workspace_members') {
              return { role: 'editor' };
            }
            if (table === 'document_permissions') {
              return null;
            }
            return null;
          },
        };
        return q;
      };

      const mockSystemDb = {
        selectFrom: (table: string) => queryBuilder(table),
      };
      return fn(mockSystemDb);
    });
  });

  it('restore endpoint returns HTTP 404 when version is not found', async () => {
    vi.spyOn(roomManager, 'restoreDocument').mockRejectedValue(
      new Error('Version not found'),
    );

    const { server } = createCollabServer();

    const res = await request(server)
      .post(`/internal/documents/${docId}/restore`)
      .set('x-internal-key', internalKey)
      .send({ versionNumber: 999, userId });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Version not found');
  });

  it('restore endpoint returns HTTP 409 when StaleFencingTokenError occurs', async () => {
    vi.spyOn(roomManager, 'restoreDocument').mockRejectedValue(
      new StaleFencingTokenError('Stale token: generation superseded'),
    );

    const { server } = createCollabServer();

    const res = await request(server)
      .post(`/internal/documents/${docId}/restore`)
      .set('x-internal-key', internalKey)
      .send({ versionNumber: 2, userId });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Stale token');
  });

  it('restore endpoint redacts raw SQL/database error to HTTP 500 Internal server error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(roomManager, 'restoreDocument').mockRejectedValue(
      new Error('raw postgres error: syntax error at or near SELECT pg_sleep(10) in table "documents"'),
    );

    const { server } = createCollabServer();

    const res = await request(server)
      .post(`/internal/documents/${docId}/restore`)
      .set('x-internal-key', internalKey)
      .send({ versionNumber: 1, userId });

    expect(res.status).toBe(500);
    // Security check: client receives safe message, no SQL/postgres leakage
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.error).not.toContain('postgres');
    expect(res.body.error).not.toContain('SELECT');

    consoleSpy.mockRestore();
  });

  it('checkpoint endpoint returns HTTP 400 for archived document', async () => {
    vi.spyOn(roomManager, 'createDocumentCheckpoint').mockRejectedValue(
      new Error('Cannot create version checkpoint for an archived document'),
    );

    const { server } = createCollabServer();

    const res = await request(server)
      .post(`/internal/documents/${docId}/checkpoint`)
      .set('x-internal-key', internalKey)
      .send({ workspaceId, userId });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot create version checkpoint for an archived document');
  });

  it('checkpoint endpoint returns HTTP 409 for StaleFencingTokenError', async () => {
    vi.spyOn(roomManager, 'createDocumentCheckpoint').mockRejectedValue(
      new StaleFencingTokenError('Stale token: superseded checkpoint'),
    );

    const { server } = createCollabServer();

    const res = await request(server)
      .post(`/internal/documents/${docId}/checkpoint`)
      .set('x-internal-key', internalKey)
      .send({ workspaceId, userId });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Stale token');
  });

  it('checkpoint endpoint redacts raw server exceptions to HTTP 500 Internal server error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    vi.spyOn(roomManager, 'createDocumentCheckpoint').mockRejectedValue(
      new Error('MinIO connection refused on s3.internal:9000 secretKey=abc123xyz'),
    );

    const { server } = createCollabServer();

    const res = await request(server)
      .post(`/internal/documents/${docId}/checkpoint`)
      .set('x-internal-key', internalKey)
      .send({ workspaceId, userId });

    expect(res.status).toBe(500);
    // Security check: MinIO connection/secret details redacted from client
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.error).not.toContain('MinIO');
    expect(res.body.error).not.toContain('secretKey');

    consoleSpy.mockRestore();
  });
});
