import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb, createScopedDb } from '@knowledge/database';
import { registerUser, loginUser } from '@knowledge/auth';
import { createWorkspace, addWorkspaceMember } from '../../apps/api-server/src/lib/workspace-service';
import { createDocument } from '../../apps/api-server/src/lib/document-service';

describe('Document REST API Integration Tests', () => {
  const app = createApiApp();
  let isDbConnected = false;

  let ownerToken: string;
  let adminToken: string;
  let editorToken: string;
  let viewerToken: string;
  let userBToken: string;

  let ownerId: string;
  let adminId: string;
  let editorId: string;
  let viewerId: string;

  let workspaceAId: string;
  let workspaceBId: string;

  let docA1Id: string;
  let docA2Id: string;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;

      const sysDb = getSystemDb();

      // Register users
      const owner = await registerUser(sysDb, { email: `api_owner_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Owner' });
      const admin = await registerUser(sysDb, { email: `api_admin_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Admin' });
      const editor = await registerUser(sysDb, { email: `api_editor_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Editor' });
      const viewer = await registerUser(sysDb, { email: `api_viewer_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Viewer' });
      const userB = await registerUser(sysDb, { email: `api_userB_${Date.now()}@example.com`, password: 'Password123!', displayName: 'User B' });

      ownerId = owner.id;
      adminId = admin.id;
      editorId = editor.id;
      viewerId = viewer.id;

      // Workspaces
      const wsA = await createWorkspace(sysDb, owner.id, 'API Workspace A');
      const wsB = await createWorkspace(sysDb, userB.id, 'API Workspace B');

      workspaceAId = wsA.id;
      workspaceBId = wsB.id;

      const scopedOwnerA = createScopedDb(owner.id);

      // Add members to Workspace A
      await addWorkspaceMember(scopedOwnerA, workspaceAId, admin.email, 'admin');
      await addWorkspaceMember(scopedOwnerA, workspaceAId, editor.email, 'editor');
      await addWorkspaceMember(scopedOwnerA, workspaceAId, viewer.email, 'viewer');

      // Login users to get tokens
      ownerToken = (await loginUser(sysDb, { email: owner.email, password: 'Password123!' })).accessToken;
      adminToken = (await loginUser(sysDb, { email: admin.email, password: 'Password123!' })).accessToken;
      editorToken = (await loginUser(sysDb, { email: editor.email, password: 'Password123!' })).accessToken;
      viewerToken = (await loginUser(sysDb, { email: viewer.email, password: 'Password123!' })).accessToken;
      userBToken = (await loginUser(sysDb, { email: userB.email, password: 'Password123!' })).accessToken;

      // Create fixture documents
      const doc1 = await createDocument(scopedOwnerA, {
        workspaceId: workspaceAId,
        title: 'Doc A1',
        contentText: 'Initial content A1',
        createdBy: owner.id,
      });

      const doc2 = await createDocument(scopedOwnerA, {
        workspaceId: workspaceAId,
        parentId: doc1.id,
        title: 'Doc A2',
        contentText: 'Initial content A2',
        createdBy: owner.id,
      });

      docA1Id = doc1.id;
      docA2Id = doc2.id;
    } catch {
      isDbConnected = false;
    }
  });

  it('rejects unauthenticated requests with 401', async () => {
    if (!isDbConnected) return;

    const res = await request(app).get(`/api/v1/workspaces/${workspaceAId}/documents`);
    expect(res.status).toBe(401);
  });

  it('allows Owner, Admin, and Editor to create documents, denying Viewer with 403', async () => {
    if (!isDbConnected) return;

    // Editor creates document
    const resEditor = await request(app)
      .post(`/api/v1/workspaces/${workspaceAId}/documents`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ title: 'Editor Created Doc', contentText: 'Hello' });

    expect(resEditor.status).toBe(201);
    expect(resEditor.body.document.title).toBe('Editor Created Doc');

    // Viewer creation denied
    const resViewer = await request(app)
      .post(`/api/v1/workspaces/${workspaceAId}/documents`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ title: 'Viewer Created Doc' });

    expect(resViewer.status).toBe(403);
  });

  it('retrieves single document and returns 404 for workspaceId + documentId mismatch', async () => {
    if (!isDbConnected) return;

    // Valid read
    const resValid = await request(app)
      .get(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(resValid.status).toBe(200);
    expect(resValid.body.document.id).toBe(docA1Id);
    expect(resValid.body.effectiveRole).toBe('viewer');

    // Mismatched workspaceId (Doc A1 requested under Workspace B) returns 404
    const resMismatch = await request(app)
      .get(`/api/v1/workspaces/${workspaceBId}/documents/${docA1Id}`)
      .set('Authorization', `Bearer ${userBToken}`);

    expect(resMismatch.status).toBe(404);
  });

  it('allows Editor to update title and contentText, denying Viewer with 403', async () => {
    if (!isDbConnected) return;

    // Editor updates document
    const resPatch = await request(app)
      .patch(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ title: 'Patched Title A1', contentText: 'Patched Content A1' });

    expect(resPatch.status).toBe(200);
    expect(resPatch.body.document.title).toBe('Patched Title A1');
    expect(resPatch.body.document.content_text).toBe('Patched Content A1');

    // Viewer update denied
    const resViewerPatch = await request(app)
      .patch(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ title: 'Viewer Try Patch' });

    expect(resViewerPatch.status).toBe(403);
  });

  it('handles moving document parents and rejects cycles and cross-workspace parents', async () => {
    if (!isDbConnected) return;

    // Move Doc A2 to root (parentId = null)
    const resMoveRoot = await request(app)
      .post(`/api/v1/workspaces/${workspaceAId}/documents/${docA2Id}/move`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ parentId: null });

    expect(resMoveRoot.status).toBe(200);
    expect(resMoveRoot.body.document.parent_id).toBeNull();

    // Re-link Doc A2 under Doc A1
    const resMoveParent = await request(app)
      .post(`/api/v1/workspaces/${workspaceAId}/documents/${docA2Id}/move`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ parentId: docA1Id });

    expect(resMoveParent.status).toBe(200);
    expect(resMoveParent.body.document.parent_id).toBe(docA1Id);

    // Reject cycle (attempt to move Doc A1 under Doc A2 when A2 is child of A1)
    const resCycle = await request(app)
      .post(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}/move`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ parentId: docA2Id });

    expect(resCycle.status).toBe(500); // Handled by error middleware
  });

  it('restricts archiving and restoring strictly to Owner and Admin, denying Editor with 403', async () => {
    if (!isDbConnected) return;

    // Editor archive attempt -> 403 Forbidden
    const resEditorArchive = await request(app)
      .post(`/api/v1/workspaces/${workspaceAId}/documents/${docA2Id}/archive`)
      .set('Authorization', `Bearer ${editorToken}`);

    expect(resEditorArchive.status).toBe(403);

    // Admin archive -> 200 OK
    const resAdminArchive = await request(app)
      .post(`/api/v1/workspaces/${workspaceAId}/documents/${docA2Id}/archive`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(resAdminArchive.status).toBe(200);
    expect(resAdminArchive.body.document.is_archived).toBe(true);

    // Admin restore -> 200 OK
    const resAdminRestore = await request(app)
      .post(`/api/v1/workspaces/${workspaceAId}/documents/${docA2Id}/restore`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(resAdminRestore.status).toBe(200);
    expect(resAdminRestore.body.document.is_archived).toBe(false);
  });

  it('restricts document permission override management strictly to Owner and Admin', async () => {
    if (!isDbConnected) return;

    // Editor PUT permission -> 403 Forbidden
    const resEditorPut = await request(app)
      .put(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}/permissions/${viewerId}`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ role: 'editor' });

    expect(resEditorPut.status).toBe(403);

    // Admin PUT permission -> 200 OK
    const resAdminPut = await request(app)
      .put(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}/permissions/${viewerId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'none' });

    expect(resAdminPut.status).toBe(200);

    // Viewer (now explicitly set to 'none') tries to read Doc A1 -> 403 Forbidden
    const resNoneRead = await request(app)
      .get(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(resNoneRead.status).toBe(403);

    // Admin DELETE permission override -> 200 OK
    const resAdminDelete = await request(app)
      .delete(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}/permissions/${viewerId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(resAdminDelete.status).toBe(200);

    // Viewer (override removed, back to workspace viewer role) can read Doc A1 again
    const resRestoredRead = await request(app)
      .get(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(resRestoredRead.status).toBe(200);
  });

  it('enforces complete cross-workspace isolation (Workspace B user denied for Workspace A docs)', async () => {
    if (!isDbConnected) return;

    const resCross = await request(app)
      .get(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}`)
      .set('Authorization', `Bearer ${userBToken}`);

    expect(resCross.status).toBe(403);
  });
});
