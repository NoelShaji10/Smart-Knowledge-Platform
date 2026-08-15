import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb, withSystemContext } from '@knowledge/database';
import { registerUser, loginUser } from '@knowledge/auth';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';

describe('HIGH 4: RBAC Admin-to-Admin Escalation Prevention', () => {
  const app = createApiApp();
  let isDbConnected = false;

  let ownerToken: string;
  let admin1_id: string;
  let admin1_token: string;
  let admin2_id: string;
  let admin2_token: string;
  let workspaceId: string;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;

      const systemDb = getSystemDb();

      const owner = await registerUser(systemDb, { email: `esc_owner_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Esc Owner' });
      const admin1 = await registerUser(systemDb, { email: `esc_admin1_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Esc Admin 1' });
      const admin2 = await registerUser(systemDb, { email: `esc_admin2_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Esc Admin 2' });

      admin1_id = admin1.id;
      admin2_id = admin2.id;

      const ws = await withSystemContext(async (db) => createWorkspace(db, owner.id, 'Escalation Test Workspace'));
      workspaceId = ws.id;

      await withSystemContext(async (db) => {
        await db.insertInto('workspace_members').values([
          { workspace_id: workspaceId, user_id: admin1_id, role: 'admin' },
          { workspace_id: workspaceId, user_id: admin2_id, role: 'admin' },
        ]).execute();
      });

      ownerToken = (await loginUser(systemDb, { email: owner.email, password: 'Password123!' })).accessToken;
      admin1_token = (await loginUser(systemDb, { email: admin1.email, password: 'Password123!' })).accessToken;
      admin2_token = (await loginUser(systemDb, { email: admin2.email, password: 'Password123!' })).accessToken;
    } catch {
      isDbConnected = false;
    }
  });

  it('rejects Admin 1 attempting to demote Admin 2', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}/members/${admin2_id}`)
      .set('Authorization', `Bearer ${admin1_token}`)
      .send({ role: 'editor' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Only the workspace owner can modify or assign admin memberships');
  });

  it('rejects Admin 1 attempting to remove Admin 2', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .delete(`/api/v1/workspaces/${workspaceId}/members/${admin2_id}`)
      .set('Authorization', `Bearer ${admin1_token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Only the workspace owner can remove an admin');
  });

  it('allows Workspace Owner to demote Admin 2', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}/members/${admin2_id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'editor' });

    expect(res.status).toBe(200);
    expect(res.body.member.role).toBe('editor');
  });

  it('allows Workspace Owner to remove Admin 1', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .delete(`/api/v1/workspaces/${workspaceId}/members/${admin1_id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
