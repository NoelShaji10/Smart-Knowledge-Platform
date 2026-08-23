import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb, withSystemContext } from '@knowledge/database';
import { registerUser, loginUser } from '@knowledge/auth';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';

describe('JWT Staleness & DB Authoritative Check Integration', () => {
  const app = createApiApp();
  let isDbConnected = false;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;
    } catch {
      isDbConnected = false;
    }
  });

  it('rejects workspace access when membership is removed in DB, even if JWT claims membership', async () => {
    if (!isDbConnected) return;

    const db = getSystemDb();

    const owner = await registerUser(db, { email: `owner_stale_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Owner' });
    const member = await registerUser(db, { email: `member_stale_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Member' });

    const ws = await createWorkspace(db, owner.id, 'Stale JWT Test Workspace');

    await withSystemContext(async (sysDb) => {
      await sysDb.insertInto('workspace_members').values({
        workspace_id: ws.id,
        user_id: member.id,
        role: 'editor',
      }).execute();
    });

    // Member logs in and gets access token claiming workspace membership
    const loginRes = await loginUser(db, { email: member.email, password: 'Password123!' });
    const staleJwtToken = loginRes.accessToken;

    // Verify token works initially
    const res1 = await request(app)
      .get(`/api/v1/workspaces/${ws.id}`)
      .set('Authorization', `Bearer ${staleJwtToken}`);

    expect(res1.status).toBe(200);

    // Remove member from DB directly
    await withSystemContext(async (sysDb) => {
      await sysDb.deleteFrom('workspace_members')
        .where('workspace_id', '=', ws.id)
        .where('user_id', '=', member.id)
        .execute();
    });

    // Subsequent request with old (stale) JWT is rejected because requireWorkspace queries DB!
    const res2 = await request(app)
      .get(`/api/v1/workspaces/${ws.id}`)
      .set('Authorization', `Bearer ${staleJwtToken}`);

    expect(res2.status).toBe(403);
  });
});
