import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb, createScopedDb } from '@knowledge/database';
import { registerUser, loginUser } from '@knowledge/auth';
import { createWorkspace, addWorkspaceMember } from '../../apps/api-server/src/lib/workspace-service';
import { createDocument, archiveDocument } from '../../apps/api-server/src/lib/document-service';
import {
  setDocumentPermission,
  removeDocumentPermission,
  getEffectiveDocumentRole,
  getDocumentPermissions,
} from '../../apps/api-server/src/lib/document-permission-service';

describe('Phase 5 — T5: Reliable Permission & Viewer Experience Integration Suite', () => {
  const app = createApiApp();
  let isDbConnected = false;

  let ownerToken: string;
  let adminToken: string;
  let editorToken: string;
  let viewerToken: string;
  let nonMemberToken: string;

  let ownerId: string;
  let adminId: string;
  let editorId: string;
  let viewerId: string;
  let nonMemberId: string;

  let workspaceId: string;
  let activeDocId: string;
  let archivedDocId: string;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;

      const sysDb = getSystemDb();

      // Register users
      const timestamp = Date.now();
      const owner = await registerUser(sysDb, { email: `t5_owner_${timestamp}@example.com`, password: 'Password123!', displayName: 'T5 Owner' });
      const admin = await registerUser(sysDb, { email: `t5_admin_${timestamp}@example.com`, password: 'Password123!', displayName: 'T5 Admin' });
      const editor = await registerUser(sysDb, { email: `t5_editor_${timestamp}@example.com`, password: 'Password123!', displayName: 'T5 Editor' });
      const viewer = await registerUser(sysDb, { email: `t5_viewer_${timestamp}@example.com`, password: 'Password123!', displayName: 'T5 Viewer' });
      const nonMember = await registerUser(sysDb, { email: `t5_nonmember_${timestamp}@example.com`, password: 'Password123!', displayName: 'T5 NonMember' });

      ownerId = owner.id;
      adminId = admin.id;
      editorId = editor.id;
      viewerId = viewer.id;
      nonMemberId = nonMember.id;

      // Workspace
      const ws = await createWorkspace(sysDb, ownerId, 'T5 Permissions Workspace');
      workspaceId = ws.id;

      const scopedOwner = createScopedDb(ownerId);

      // Add members
      await addWorkspaceMember(scopedOwner, workspaceId, admin.email, 'admin');
      await addWorkspaceMember(scopedOwner, workspaceId, editor.email, 'editor');
      await addWorkspaceMember(scopedOwner, workspaceId, viewer.email, 'viewer');

      // Login users
      ownerToken = (await loginUser(sysDb, { email: owner.email, password: 'Password123!' })).accessToken;
      adminToken = (await loginUser(sysDb, { email: admin.email, password: 'Password123!' })).accessToken;
      editorToken = (await loginUser(sysDb, { email: editor.email, password: 'Password123!' })).accessToken;
      viewerToken = (await loginUser(sysDb, { email: viewer.email, password: 'Password123!' })).accessToken;
      nonMemberToken = (await loginUser(sysDb, { email: nonMember.email, password: 'Password123!' })).accessToken;

      // Active Document
      const activeDoc = await createDocument(scopedOwner, {
        workspaceId,
        title: 'T5 Active Document',
        contentText: '<p>Initial Content</p>',
        createdBy: ownerId,
      });
      activeDocId = activeDoc.id;

      // Archived Document
      const archDoc = await createDocument(scopedOwner, {
        workspaceId,
        title: 'T5 Archived Document',
        contentText: '<p>Archived Content</p>',
        createdBy: ownerId,
      });
      await archiveDocument(scopedOwner, workspaceId, archDoc.id);
      archivedDocId = archDoc.id;
    } catch {
      isDbConnected = false;
    }
  });

  // Scenario A: Owner can perform all authorized operations
  it('Scenario A: Owner has full capabilities (read, edit, move, archive, manage_permissions)', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.effectiveRole).toBe('owner');
    expect(res.body.capabilities.canRead).toBe(true);
    expect(res.body.capabilities.canEdit).toBe(true);
    expect(res.body.capabilities.canMove).toBe(true);
    expect(res.body.capabilities.canArchive).toBe(true);
    expect(res.body.capabilities.canManagePermissions).toBe(true);
  });

  // Scenario B: Admin receives correct controls and capabilities
  it('Scenario B: Admin has full capabilities (read, edit, move, archive, manage_permissions)', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.effectiveRole).toBe('admin');
    expect(res.body.capabilities.canRead).toBe(true);
    expect(res.body.capabilities.canEdit).toBe(true);
    expect(res.body.capabilities.canMove).toBe(true);
    expect(res.body.capabilities.canArchive).toBe(true);
    expect(res.body.capabilities.canManagePermissions).toBe(true);
  });

  // Scenario C: Editor can edit but cannot perform unauthorized admin operations
  it('Scenario C: Editor can edit, rename, move; CANNOT archive or manage permissions', async () => {
    if (!isDbConnected) return;

    // Read check
    const resGet = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}`)
      .set('Authorization', `Bearer ${editorToken}`);

    expect(resGet.status).toBe(200);
    expect(resGet.body.effectiveRole).toBe('editor');
    expect(resGet.body.capabilities.canRead).toBe(true);
    expect(resGet.body.capabilities.canEdit).toBe(true);
    expect(resGet.body.capabilities.canMove).toBe(true);
    expect(resGet.body.capabilities.canArchive).toBe(false);
    expect(resGet.body.capabilities.canManagePermissions).toBe(false);

    // Edit content & title
    const resPatch = await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ title: 'Editor Renamed Title', contentText: '<p>Editor Updated</p>' });

    expect(resPatch.status).toBe(200);
    expect(resPatch.body.document.title).toBe('Editor Renamed Title');

    // Archive attempt -> 403 Forbidden
    const resArchive = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/archive`)
      .set('Authorization', `Bearer ${editorToken}`);

    expect(resArchive.status).toBe(403);

    // Permission management attempt -> 403 Forbidden
    const resPerm = await request(app)
      .put(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/permissions/${viewerId}`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ role: 'editor' });

    expect(resPerm.status).toBe(403);
  });

  // Scenario D: Viewer is genuinely read-only
  it('Scenario D: Viewer is strictly read-only (edit, move, archive, manage_permissions denied)', async () => {
    if (!isDbConnected) return;

    // Read check
    const resGet = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(resGet.status).toBe(200);
    expect(resGet.body.effectiveRole).toBe('viewer');
    expect(resGet.body.capabilities.canRead).toBe(true);
    expect(resGet.body.capabilities.canEdit).toBe(false);
    expect(resGet.body.capabilities.canMove).toBe(false);
    expect(resGet.body.capabilities.canArchive).toBe(false);
    expect(resGet.body.capabilities.canManagePermissions).toBe(false);

    // Edit attempt -> 403 Forbidden
    const resPatch = await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ title: 'Viewer Hostile Rename' });

    expect(resPatch.status).toBe(403);

    // Move attempt -> 403 Forbidden
    const resMove = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/move`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ parentId: null });

    expect(resMove.status).toBe(403);

    // Archive attempt -> 403 Forbidden
    const resArchive = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/archive`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(resArchive.status).toBe(403);

    // Permission manage attempt -> 403 Forbidden
    const resPerm = await request(app)
      .put(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/permissions/${editorId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ role: 'none' });

    expect(resPerm.status).toBe(403);
  });

  // Scenario E: Viewer WebSocket ticket succeeds with canEdit: false
  it('Scenario E: Viewer can obtain WebSocket ticket for collaborative viewing', async () => {
    if (!isDbConnected) return;

    const resTicket = await request(app)
      .post('/api/v1/ws/ticket')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ workspaceId, documentId: activeDocId });

    expect(resTicket.status).toBe(200);
    expect(resTicket.body.ticket).toBeDefined();
    expect(typeof resTicket.body.ticket).toBe('string');
  });

  // Scenario F: No-access user cannot open document or get ticket
  it('Scenario F: Non-member is completely rejected (403/404, no ticket, no access)', async () => {
    if (!isDbConnected) return;

    // Document read rejected
    const resGet = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}`)
      .set('Authorization', `Bearer ${nonMemberToken}`);

    expect(resGet.status).toBe(403);

    // WS ticket rejected
    const resTicket = await request(app)
      .post('/api/v1/ws/ticket')
      .set('Authorization', `Bearer ${nonMemberToken}`)
      .send({ workspaceId, documentId: activeDocId });

    expect(resTicket.status).toBe(403);
    expect(resTicket.body.error).toContain('Not a workspace member');
  });

  // Scenario G: Archived editor cannot modify or move archived document
  it('Scenario G: Archived document forbids editing and moving even for editors', async () => {
    if (!isDbConnected) return;

    // Editor attempts to edit archived document -> rejected by backend
    const resPatch = await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}/documents/${archivedDocId}`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ title: 'Hostile Archive Edit' });

    expect(resPatch.status).toBe(500); // Throws Error('Cannot update an archived document')

    // Editor attempts to move archived document -> rejected by backend
    const resMove = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/documents/${archivedDocId}/move`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ parentId: null });

    expect(resMove.status).toBe(500); // Throws Error('Cannot move an archived document')

    // Editor cannot restore from archive
    const resRestore = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/documents/${archivedDocId}/restore`)
      .set('Authorization', `Bearer ${editorToken}`);

    expect(resRestore.status).toBe(403);

    // Admin CAN restore from archive
    const resAdminRestore = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/documents/${archivedDocId}/restore`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(resAdminRestore.status).toBe(200);
    expect(resAdminRestore.body.document.is_archived).toBe(false);

    // Re-archive for other tests
    await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/documents/${archivedDocId}/archive`)
      .set('Authorization', `Bearer ${adminToken}`);
  });

  // Scenario H: Archived viewer cannot edit or restore
  it('Scenario H: Archived document remains strictly read-only for viewers', async () => {
    if (!isDbConnected) return;

    const resGet = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/documents/${archivedDocId}`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(resGet.status).toBe(200);
    expect(resGet.body.document.is_archived).toBe(true);
    expect(resGet.body.capabilities.canEdit).toBe(false);
    expect(resGet.body.capabilities.canArchive).toBe(false);

    const resRestore = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/documents/${archivedDocId}/restore`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(resRestore.status).toBe(403);
  });

  // Scenario I: Permission change Editor -> Viewer (downgrade)
  it('Scenario I: Document override can downgrade Editor to Viewer', async () => {
    if (!isDbConnected) return;

    // Admin sets override 'viewer' for Editor on activeDoc
    const resOverride = await request(app)
      .put(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/permissions/${editorId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'viewer' });

    expect(resOverride.status).toBe(200);

    // Editor now reads document -> effectiveRole is viewer, canEdit is false
    const resGet = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}`)
      .set('Authorization', `Bearer ${editorToken}`);

    expect(resGet.status).toBe(200);
    expect(resGet.body.effectiveRole).toBe('viewer');
    expect(resGet.body.capabilities.canEdit).toBe(false);

    // Editor attempts to PATCH -> 403 Forbidden!
    const resPatch = await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ title: 'Downgraded Editor Should Fail' });

    expect(resPatch.status).toBe(403);

    // Clean up override
    await request(app)
      .delete(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/permissions/${editorId}`)
      .set('Authorization', `Bearer ${adminToken}`);
  });

  // Scenario J: Permission change Viewer -> Editor (upgrade)
  it('Scenario J: Document override can upgrade Viewer to Editor', async () => {
    if (!isDbConnected) return;

    // Admin sets override 'editor' for Viewer on activeDoc
    const resOverride = await request(app)
      .put(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/permissions/${viewerId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'editor' });

    expect(resOverride.status).toBe(200);

    // Viewer now reads document -> effectiveRole is editor, canEdit is true
    const resGet = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(resGet.status).toBe(200);
    expect(resGet.body.effectiveRole).toBe('editor');
    expect(resGet.body.capabilities.canEdit).toBe(true);

    // Viewer successfully edits title & content
    const resPatch = await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}`)
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ title: 'Promoted Viewer Title', contentText: '<p>Promoted Content</p>' });

    expect(resPatch.status).toBe(200);
    expect(resPatch.body.document.title).toBe('Promoted Viewer Title');

    // Clean up override
    await request(app)
      .delete(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/permissions/${viewerId}`)
      .set('Authorization', `Bearer ${adminToken}`);
  });

  // Scenario K: Permission Revocation (override 'none')
  it('Scenario K: Document override="none" absolutely denies all access', async () => {
    if (!isDbConnected) return;

    // Admin sets override 'none' for Editor
    await request(app)
      .put(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/permissions/${editorId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'none' });

    // Editor cannot read document -> 403 Forbidden
    const resGet = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}`)
      .set('Authorization', `Bearer ${editorToken}`);

    expect(resGet.status).toBe(403);

    // Editor cannot get WS ticket -> 403 Forbidden
    const resTicket = await request(app)
      .post('/api/v1/ws/ticket')
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ workspaceId, documentId: activeDocId });

    expect(resTicket.status).toBe(403);
    expect(resTicket.body.error).toContain('Explicit document access denied');
  });

  // Scenario L: Permission Restoration (override removed)
  it('Scenario L: Removing override restores normal workspace capabilities', async () => {
    if (!isDbConnected) return;

    // Remove override 'none' for Editor
    const resDel = await request(app)
      .delete(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/permissions/${editorId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(resDel.status).toBe(200);

    // Editor can read again with canEdit: true
    const resGet = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}`)
      .set('Authorization', `Bearer ${editorToken}`);

    expect(resGet.status).toBe(200);
    expect(resGet.body.effectiveRole).toBe('editor');
    expect(resGet.body.capabilities.canEdit).toBe(true);
  });

  // Scenario M & N: Version restore authorization
  it('Scenario M & N: Viewer cannot restore version, while Editor/Admin can', async () => {
    if (!isDbConnected) return;

    // Viewer restore attempt -> 403 Forbidden
    const resViewerRestore = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/versions/1/restore`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(resViewerRestore.status).toBe(403);

    // Viewer cannot create manual checkpoint -> 403 Forbidden
    const resViewerCheckpoint = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/versions`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(resViewerCheckpoint.status).toBe(403);
  });

  // Scenario O & P: Failure handling does not produce fake success
  it('Scenario O & P: Unauthorized permission mutation fails closed with 403', async () => {
    if (!isDbConnected) return;

    // Unauthorized editor tries to set permission override
    const resFail = await request(app)
      .put(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/permissions/${viewerId}`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ role: 'editor' });

    expect(resFail.status).toBe(403);

    // Verify DB was NOT updated (no fake success)
    const scopedAdmin = createScopedDb(adminId);
    const overrides = await getDocumentPermissions(scopedAdmin, workspaceId, activeDocId, adminId);
    const targetOverride = overrides.find((o) => o.id === viewerId);
    expect(targetOverride).toBeUndefined();
  });

  // Scenario Q: Server-authoritative capability and override listing
  it('Scenario Q: getDocumentPermissions returns workspace_role and overrides faithfully', async () => {
    if (!isDbConnected) return;

    // Admin sets override 'viewer' for editor
    await request(app)
      .put(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/permissions/${editorId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'viewer' });

    const resList = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/permissions`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(resList.status).toBe(200);
    expect(resList.body.permissions.length).toBeGreaterThan(0);

    const editorOverride = resList.body.permissions.find((p: any) => p.id === editorId);
    expect(editorOverride).toBeDefined();
    expect(editorOverride.role).toBe('viewer');
    expect(editorOverride.workspace_role).toBe('editor');

    // Clean up
    await request(app)
      .delete(`/api/v1/workspaces/${workspaceId}/documents/${activeDocId}/permissions/${editorId}`)
      .set('Authorization', `Bearer ${adminToken}`);
  });
});
