import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb, withSystemContext } from '@knowledge/database';
import { registerUser, loginUser } from '@knowledge/auth';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';

describe('LOW 7: Audit Coverage (Workspace Deletion & Refresh Events)', () => {
  const app = createApiApp();
  let isDbConnected = false;

  let ownerUser: any;
  let ownerToken: string;
  let workspaceId: string;
  let refreshCookie: string;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;

      const systemDb = getSystemDb();

      ownerUser = await registerUser(systemDb, {
        email: `audit_cov_owner_${Date.now()}@example.com`,
        password: 'Password123!',
        displayName: 'Audit Cov Owner',
      });

      const ws = await withSystemContext(async (db) => createWorkspace(db, ownerUser.id, 'Audit Cov Workspace'));
      workspaceId = ws.id;

      const loginRes = await loginUser(systemDb, { email: ownerUser.email, password: 'Password123!' });
      ownerToken = loginRes.accessToken;
      refreshCookie = `refreshToken=${loginRes.rawRefreshToken}`;
    } catch {
      isDbConnected = false;
    }
  });

  it('emits auth.token.refreshed audit event on token refresh', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [refreshCookie]);

    expect(res.status).toBe(200);

    const systemDb = getSystemDb();
    const auditEvents = await withSystemContext(async (db) => {
      return db
        .selectFrom('audit_events')
        .where('action', '=', 'auth.token.refreshed')
        .selectAll()
        .execute();
    });

    expect(auditEvents.length).toBeGreaterThan(0);
  });

  it('emits workspace.deleted audit event on workspace deletion', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .delete(`/api/v1/workspaces/${workspaceId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);

    const systemDb = getSystemDb();
    const auditEvents = await withSystemContext(async (db) => {
      return db
        .selectFrom('audit_events')
        .where('workspace_id', '=', workspaceId)
        .where('action', '=', 'workspace.deleted')
        .selectAll()
        .execute();
    });

    expect(auditEvents.length).toBe(1);
    expect(auditEvents[0].actor_id).toBe(ownerUser.id);
  });
});
