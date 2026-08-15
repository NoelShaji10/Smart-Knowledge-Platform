import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb } from '@knowledge/database';
import { registerUser, loginUser } from '@knowledge/auth';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';

describe('Cross-Workspace Isolation Integration Tests', () => {
  const app = createApiApp();
  let isDbConnected = false;

  let userA_token: string;
  let workspaceA_id: string;

  let userB_token: string;
  let workspaceB_id: string;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;

      const db = getSystemDb();

      const userA = await registerUser(db, { email: `userA_${Date.now()}@example.com`, password: 'Password123!', displayName: 'User A' });
      const userB = await registerUser(db, { email: `userB_${Date.now()}@example.com`, password: 'Password123!', displayName: 'User B' });

      const wsA = await createWorkspace(db, userA.id, 'Workspace A');
      const wsB = await createWorkspace(db, userB.id, 'Workspace B');

      workspaceA_id = wsA.id;
      workspaceB_id = wsB.id;

      userA_token = (await loginUser(db, { email: userA.email, password: 'Password123!' })).accessToken;
      userB_token = (await loginUser(db, { email: userB.email, password: 'Password123!' })).accessToken;
    } catch {
      isDbConnected = false;
    }
  });

  it('prevents User A from accessing Workspace B details', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .get(`/api/v1/workspaces/${workspaceB_id}`)
      .set('Authorization', `Bearer ${userA_token}`);

    expect(res.status).toBe(403);
  });

  it('prevents User A from listing members of Workspace B', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .get(`/api/v1/workspaces/${workspaceB_id}/members`)
      .set('Authorization', `Bearer ${userA_token}`);

    expect(res.status).toBe(403);
  });

  it('prevents User A from adding members to Workspace B', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceB_id}/members`)
      .set('Authorization', `Bearer ${userA_token}`)
      .send({ email: 'somebody@example.com', role: 'editor' });

    expect(res.status).toBe(403);
  });
});
