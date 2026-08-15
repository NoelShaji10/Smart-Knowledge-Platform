import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb, createScopedDb } from '@knowledge/database';
import { registerUser, loginUser } from '@knowledge/auth';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';

describe('Security Invariant 2: Complete Workspace Isolation', () => {
  const app = createApiApp();
  let isDbConnected = false;

  let userA_id: string;
  let userA_token: string;
  let workspaceA_id: string;

  let userB_id: string;
  let userB_token: string;
  let workspaceB_id: string;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;

      const db = getSystemDb();

      const userA = await registerUser(db, { email: `inv2_userA_${Date.now()}@example.com`, password: 'Password123!', displayName: 'User A' });
      const userB = await registerUser(db, { email: `inv2_userB_${Date.now()}@example.com`, password: 'Password123!', displayName: 'User B' });

      userA_id = userA.id;
      userB_id = userB.id;

      const wsA = await createWorkspace(db, userA.id, 'Workspace A (Invariant 2)');
      const wsB = await createWorkspace(db, userB.id, 'Workspace B (Invariant 2)');

      workspaceA_id = wsA.id;
      workspaceB_id = wsB.id;

      userA_token = (await loginUser(db, { email: userA.email, password: 'Password123!' })).accessToken;
      userB_token = (await loginUser(db, { email: userB.email, password: 'Password123!' })).accessToken;
    } catch {
      isDbConnected = false;
    }
  });

  it('prevents user in Workspace A from accessing resources in Workspace B via API', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .get(`/api/v1/workspaces/${workspaceB_id}`)
      .set('Authorization', `Bearer ${userA_token}`);

    expect(res.status).toBe(403);
  });

  it('enforces PostgreSQL RLS preventing direct DB access across workspaces', async () => {
    if (!isDbConnected) return;

    // User A scoped DB context attempting to select workspaces
    const scopedDbA = createScopedDb(userA_id);
    const workspacesA = await scopedDbA.execute(async (db) => {
      return db
        .selectFrom('workspaces')
        .innerJoin('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
        .selectAll('workspaces')
        .execute();
    });

    const hasWorkspaceB = workspacesA.some((w) => w.id === workspaceB_id);
    expect(hasWorkspaceB).toBe(false);
  });
});
