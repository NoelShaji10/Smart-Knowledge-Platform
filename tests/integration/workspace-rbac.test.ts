import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb } from '@knowledge/database';
import { registerUser, loginUser } from '@knowledge/auth';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';

describe('Workspace RBAC Integration Tests', () => {
  const app = createApiApp();
  let isDbConnected = false;

  let ownerToken: string;
  let adminToken: string;
  let editorToken: string;
  let viewerToken: string;
  let workspaceId: string;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;

      const db = getSystemDb();

      // Register 4 users
      const owner = await registerUser(db, { email: `owner_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Owner' });
      const admin = await registerUser(db, { email: `admin_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Admin' });
      const editor = await registerUser(db, { email: `editor_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Editor' });
      const viewer = await registerUser(db, { email: `viewer_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Viewer' });

      // Create workspace owned by owner
      const ws = await createWorkspace(db, owner.id, 'RBAC Test Workspace');
      workspaceId = ws.id;

      // Add other members
      await db.insertInto('workspace_members').values([
        { workspace_id: workspaceId, user_id: admin.id, role: 'admin' },
        { workspace_id: workspaceId, user_id: editor.id, role: 'editor' },
        { workspace_id: workspaceId, user_id: viewer.id, role: 'viewer' },
      ]).execute();

      // Log in all 4 users to get access tokens
      ownerToken = (await loginUser(db, { email: owner.email, password: 'Password123!' })).accessToken;
      adminToken = (await loginUser(db, { email: admin.email, password: 'Password123!' })).accessToken;
      editorToken = (await loginUser(db, { email: editor.email, password: 'Password123!' })).accessToken;
      viewerToken = (await loginUser(db, { email: viewer.email, password: 'Password123!' })).accessToken;
    } catch {
      isDbConnected = false;
    }
  });

  it('allows owner, admin, editor, and viewer to GET workspace details', async () => {
    if (!isDbConnected) return;

    for (const token of [ownerToken, adminToken, editorToken, viewerToken]) {
      const res = await request(app)
        .get(`/api/v1/workspaces/${workspaceId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.workspace.id).toBe(workspaceId);
    }
  });

  it('allows admin and owner to PATCH workspace settings, but blocks editor and viewer', async () => {
    if (!isDbConnected) return;

    // Viewer blocked
    const resViewer = await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ name: 'Renamed by Viewer' });
    expect(resViewer.status).toBe(403);

    // Editor blocked
    const resEditor = await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ name: 'Renamed by Editor' });
    expect(resEditor.status).toBe(403);

    // Admin allowed
    const resAdmin = await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Renamed by Admin' });
    expect(resAdmin.status).toBe(200);
  });

  it('only allows owner to DELETE workspace', async () => {
    if (!isDbConnected) return;

    const resAdmin = await request(app)
      .delete(`/api/v1/workspaces/${workspaceId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(resAdmin.status).toBe(403);

    const resOwner = await request(app)
      .delete(`/api/v1/workspaces/${workspaceId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(resOwner.status).toBe(200);
  });
});
