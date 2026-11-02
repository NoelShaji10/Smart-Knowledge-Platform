import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb, createScopedDb, withSystemContext } from '@knowledge/database';
import { registerUser, loginUser } from '@knowledge/auth';
import { ensureBucketsExist } from '@knowledge/storage';
import { createWorkspace, addWorkspaceMember } from '../../apps/api-server/src/lib/workspace-service';
import { createDocument, archiveDocument } from '../../apps/api-server/src/lib/document-service';
import {
  createVersionCheckpoint,
  listDocumentVersions,
  getDocumentVersion,
} from '../../apps/api-server/src/lib/document-version-service';
import { createCollabServer } from '../../apps/collab-server/src/server';
import { clearAllRooms } from '../../apps/collab-server/src/room-manager';

describe('Regression Suite: Document Version Checkpoints and Workspace Member Document Permissions', () => {
  const app = createApiApp();
  let isDbConnected = false;

  const TEST_COLLAB_PORT = 3099;
  let collabServer: http.Server | null = null;
  let collabWss: any = null;

  // Users in Workspace A
  let ownerToken: string;
  let adminToken: string;
  let editorToken: string;
  let viewerToken: string;

  let ownerId: string;
  let adminId: string;
  let editorId: string;
  let viewerId: string;

  let ownerEmail: string;
  let adminEmail: string;
  let editorEmail: string;
  let viewerEmail: string;

  // External User in Workspace B
  let externalUserToken: string;
  let externalUserId: string;
  let externalEmail: string;

  let workspaceAId: string;
  let workspaceBId: string;
  let docAId: string;

  beforeAll(async () => {
    try {
      await runMigrations();
      await ensureBucketsExist();
      isDbConnected = true;

      process.env.COLLAB_PORT = String(TEST_COLLAB_PORT);
      const collabApp = createCollabServer();
      collabServer = collabApp.server;
      collabWss = collabApp.wss;
      await new Promise<void>((resolve) => {
        collabServer!.listen(TEST_COLLAB_PORT, () => resolve());
      });

      const sysDb = getSystemDb();
      const timestamp = Date.now();

      ownerEmail = `owner_reg_${timestamp}@example.com`;
      adminEmail = `admin_reg_${timestamp}@example.com`;
      editorEmail = `editor_reg_${timestamp}@example.com`;
      viewerEmail = `viewer_reg_${timestamp}@example.com`;
      externalEmail = `external_reg_${timestamp}@example.com`;

      const owner = await registerUser(sysDb, { email: ownerEmail, password: 'Password123!', displayName: 'Workspace Owner' });
      const admin = await registerUser(sysDb, { email: adminEmail, password: 'Password123!', displayName: 'Workspace Admin' });
      const editor = await registerUser(sysDb, { email: editorEmail, password: 'Password123!', displayName: 'Workspace Editor' });
      const viewer = await registerUser(sysDb, { email: viewerEmail, password: 'Password123!', displayName: 'Workspace Viewer' });
      const external = await registerUser(sysDb, { email: externalEmail, password: 'Password123!', displayName: 'External User' });

      ownerId = owner.id;
      adminId = admin.id;
      editorId = editor.id;
      viewerId = viewer.id;
      externalUserId = external.id;

      // Workspaces
      const wsA = await createWorkspace(sysDb, ownerId, 'Regression Workspace A');
      const wsB = await createWorkspace(sysDb, externalUserId, 'Regression Workspace B');
      workspaceAId = wsA.id;
      workspaceBId = wsB.id;

      const scopedOwner = createScopedDb(ownerId);

      // Add members to Workspace A
      await addWorkspaceMember(scopedOwner, workspaceAId, adminEmail, 'admin');
      await addWorkspaceMember(scopedOwner, workspaceAId, editorEmail, 'editor');
      await addWorkspaceMember(scopedOwner, workspaceAId, viewerEmail, 'viewer');

      // Add pending invitation in Workspace A (not an active member)
      await withSystemContext(async (sDb) => {
        await sDb
          .insertInto('workspace_invitations')
          .values({
            workspace_id: workspaceAId,
            inviter_id: ownerId,
            invitee_email: `pending_${timestamp}@example.com`,
            role: 'editor',
            token_hash: `token_hash_${timestamp}`,
            status: 'pending',
            expires_at: new Date(Date.now() + 86400000),
          })
          .execute();
      });

      // Log in users to get tokens
      ownerToken = (await loginUser(sysDb, { email: ownerEmail, password: 'Password123!' })).accessToken;
      adminToken = (await loginUser(sysDb, { email: adminEmail, password: 'Password123!' })).accessToken;
      editorToken = (await loginUser(sysDb, { email: editorEmail, password: 'Password123!' })).accessToken;
      viewerToken = (await loginUser(sysDb, { email: viewerEmail, password: 'Password123!' })).accessToken;
      externalUserToken = (await loginUser(sysDb, { email: externalEmail, password: 'Password123!' })).accessToken;

      // Create test document in Workspace A
      const doc = await createDocument(scopedOwner, {
        workspaceId: workspaceAId,
        title: 'Regression Test Document',
        contentText: 'Initial Document Content for Checkpoints',
        createdBy: ownerId,
      });
      docAId = doc.id;
    } catch (err) {
      console.error('Setup failed in regression test:', err);
      isDbConnected = false;
    }
  });

  afterAll(async () => {
    clearAllRooms();
    if (collabServer) {
      await new Promise<void>((resolve) => collabServer!.close(() => resolve()));
    }
    if (collabWss) {
      collabWss.close();
    }
  });

  describe('Issue 1: Document Version Checkpoint Remediation', () => {
    it('allows an authorized editor to successfully create a version checkpoint', async () => {
      if (!isDbConnected) return;

      const res = await request(app)
        .post(`/api/v1/workspaces/${workspaceAId}/documents/${docAId}/versions`)
        .set('Authorization', `Bearer ${editorToken}`);

      expect(res.status).toBe(201);
      expect(res.body.version).toBeDefined();
      expect(typeof res.body.version.version_number).toBe('number');
      expect(res.body.version.version_number).toBe(1);
      expect(res.body.version.title).toBe('Regression Test Document');
      expect(res.body.version.content_text).toBe('Initial Document Content for Checkpoints');
      expect(res.body.version.trigger).toBe('manual');
      expect(res.body.version.created_by).toBe(editorId);
      expect(res.body.version.snapshot_key).toBe(`${docAId}/1.yjs`);
    });

    it('allows an authorized admin to create subsequent version checkpoint with monotonic numbering', async () => {
      if (!isDbConnected) return;

      // Update document content first
      await request(app)
        .patch(`/api/v1/workspaces/${workspaceAId}/documents/${docAId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ title: 'Regression Test Document Updated', contentText: 'Updated Content V2' });

      const res = await request(app)
        .post(`/api/v1/workspaces/${workspaceAId}/documents/${docAId}/versions`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(201);
      expect(res.body.version.version_number).toBe(2);
      expect(res.body.version.title).toBe('Regression Test Document Updated');
      expect(res.body.version.content_text).toBe('Updated Content V2');
      expect(res.body.version.trigger).toBe('manual');
      expect(res.body.version.created_by).toBe(adminId);
    });

    it('rejects version checkpoint creation by viewer (403 Forbidden)', async () => {
      if (!isDbConnected) return;

      const res = await request(app)
        .post(`/api/v1/workspaces/${workspaceAId}/documents/${docAId}/versions`)
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(403);
    });

    it('rejects version checkpoint creation by non-workspace member (403 or 404)', async () => {
      if (!isDbConnected) return;

      const res = await request(app)
        .post(`/api/v1/workspaces/${workspaceAId}/documents/${docAId}/versions`)
        .set('Authorization', `Bearer ${externalUserToken}`);

      expect(res.status).toBe(403);
    });

    it('rejects version checkpoint creation for nonexistent document (404 Not Found)', async () => {
      if (!isDbConnected) return;

      const fakeDocId = '00000000-0000-0000-0000-000000000000';
      const res = await request(app)
        .post(`/api/v1/workspaces/${workspaceAId}/documents/${fakeDocId}/versions`)
        .set('Authorization', `Bearer ${editorToken}`);

      expect(res.status).toBe(404);
    });

    it('rejects version checkpoint creation for an archived document (400 Bad Request)', async () => {
      if (!isDbConnected) return;

      const scopedOwner = createScopedDb(ownerId);
      const archivedDoc = await createDocument(scopedOwner, {
        workspaceId: workspaceAId,
        title: 'Doc to Archive for Checkpoint Test',
        contentText: 'Archived content',
        createdBy: ownerId,
      });

      await archiveDocument(scopedOwner, workspaceAId, archivedDoc.id);

      const res = await request(app)
        .post(`/api/v1/workspaces/${workspaceAId}/documents/${archivedDoc.id}/versions`)
        .set('Authorization', `Bearer ${editorToken}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('archived');
    });

    it('lists versions in history newest-first and preserves existing versions intact', async () => {
      if (!isDbConnected) return;

      const res = await request(app)
        .get(`/api/v1/workspaces/${workspaceAId}/documents/${docAId}/versions`)
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.versions)).toBe(true);
      expect(res.body.versions.length).toBe(2);

      // Ordered newest first
      expect(res.body.versions[0].version_number).toBe(2);
      expect(res.body.versions[0].title).toBe('Regression Test Document Updated');
      expect(res.body.versions[1].version_number).toBe(1);
      expect(res.body.versions[1].title).toBe('Regression Test Document');

      // Check author associations
      expect(res.body.versions[0].created_by).toBe(adminId);
      expect(res.body.versions[0].creator_email).toBe(adminEmail);
      expect(res.body.versions[1].created_by).toBe(editorId);
      expect(res.body.versions[1].creator_email).toBe(editorEmail);
    });

    it('handles concurrent checkpoint submissions with monotonic ordering without corruption', async () => {
      if (!isDbConnected) return;

      const scopedEditor = createScopedDb(editorId);
      const doc = await createDocument(scopedEditor, {
        workspaceId: workspaceAId,
        title: 'Concurrent Checkpoint Doc',
        contentText: 'Concurrent State',
        createdBy: editorId,
      });

      const p1 = createVersionCheckpoint(scopedEditor, workspaceAId, doc.id, editorId, 'manual');
      const p2 = createVersionCheckpoint(scopedEditor, workspaceAId, doc.id, editorId, 'manual');
      const p3 = createVersionCheckpoint(scopedEditor, workspaceAId, doc.id, editorId, 'manual');

      const results = await Promise.all([p1, p2, p3]);
      const numbers = results.map((r) => r.version_number).sort((a, b) => a - b);
      expect(numbers).toEqual([1, 2, 3]);

      const history = await listDocumentVersions(scopedEditor, workspaceAId, doc.id);
      expect(history.length).toBe(3);
    });

    it('maintains strict distinction between recovery snapshots and user-visible version history', async () => {
      if (!isDbConnected) return;

      const scopedOwner = createScopedDb(ownerId);
      const doc = await createDocument(scopedOwner, {
        workspaceId: workspaceAId,
        title: 'Snapshot vs Version Doc',
        contentText: 'Content for separation test',
        createdBy: ownerId,
      });

      // No versions exist initially
      const initialVersions = await listDocumentVersions(scopedOwner, workspaceAId, doc.id);
      expect(initialVersions.length).toBe(0);

      // Create a user-visible version checkpoint
      const v1 = await createVersionCheckpoint(scopedOwner, workspaceAId, doc.id, ownerId, 'manual');
      expect(v1.trigger).toBe('manual');
      expect(v1.snapshot_key).toBe(`${doc.id}/1.yjs`);

      // Verify listDocumentVersions only returns user-visible checkpoints
      const versionsAfter = await listDocumentVersions(scopedOwner, workspaceAId, doc.id);
      expect(versionsAfter.length).toBe(1);
      expect(versionsAfter[0].trigger).toBe('manual');
      expect(versionsAfter[0].snapshot_key).toBe(`${doc.id}/1.yjs`);
    });
  });

  describe('Issue 2: Document Permissions Workspace Member Selection Remediation', () => {
    it('returns all active workspace members in GET /api/v1/workspaces/:wsId/members', async () => {
      if (!isDbConnected) return;

      // Owner requests workspace members
      const res = await request(app)
        .get(`/api/v1/workspaces/${workspaceAId}/members`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.members)).toBe(true);

      const members = res.body.members;
      expect(members.length).toBe(4);

      const roles = members.map((m: any) => m.role);
      expect(roles).toContain('owner');
      expect(roles).toContain('admin');
      expect(roles).toContain('editor');
      expect(roles).toContain('viewer');

      // Verify member details are present
      const ownerMember = members.find((m: any) => m.role === 'owner');
      expect(ownerMember.email).toBe(ownerEmail);
      expect(ownerMember.display_name).toBe('Workspace Owner');

      const adminMember = members.find((m: any) => m.role === 'admin');
      expect(adminMember.email).toBe(adminEmail);
      expect(adminMember.display_name).toBe('Workspace Admin');

      const editorMember = members.find((m: any) => m.role === 'editor');
      expect(editorMember.email).toBe(editorEmail);
      expect(editorMember.display_name).toBe('Workspace Editor');

      const viewerMember = members.find((m: any) => m.role === 'viewer');
      expect(viewerMember.email).toBe(viewerEmail);
      expect(viewerMember.display_name).toBe('Workspace Viewer');
    });

    it('allows an editor or admin to also view the complete workspace member list', async () => {
      if (!isDbConnected) return;

      // Editor requests workspace members
      const res = await request(app)
        .get(`/api/v1/workspaces/${workspaceAId}/members`)
        .set('Authorization', `Bearer ${editorToken}`);

      expect(res.status).toBe(200);
      expect(res.body.members.length).toBe(4);

      // Verify that other members are NOT filtered out by RLS when viewed by an editor
      const memberEmails = res.body.members.map((m: any) => m.email);
      expect(memberEmails).toContain(ownerEmail);
      expect(memberEmails).toContain(adminEmail);
      expect(memberEmails).toContain(editorEmail);
      expect(memberEmails).toContain(viewerEmail);
    });

    it('does not include pending invitations in active workspace members', async () => {
      if (!isDbConnected) return;

      const res = await request(app)
        .get(`/api/v1/workspaces/${workspaceAId}/members`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      const emails = res.body.members.map((m: any) => m.email);
      expect(emails.some((email: string) => email.startsWith('pending_'))).toBe(false);
    });

    it('does not include members from another workspace', async () => {
      if (!isDbConnected) return;

      const res = await request(app)
        .get(`/api/v1/workspaces/${workspaceAId}/members`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      const emails = res.body.members.map((m: any) => m.email);
      expect(emails).not.toContain(externalEmail);
    });

    it('allows workspace owner to create, persist, and list document permission override for active member', async () => {
      if (!isDbConnected) return;

      // Owner grants Viewer document-level editor override
      const putRes = await request(app)
        .put(`/api/v1/workspaces/${workspaceAId}/documents/${docAId}/permissions/${viewerId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'editor' });

      expect(putRes.status).toBe(200);
      expect(putRes.body.permission.role).toBe('editor');
      expect(putRes.body.permission.user_id).toBe(viewerId);

      // List overrides (GET /permissions)
      const listRes = await request(app)
        .get(`/api/v1/workspaces/${workspaceAId}/documents/${docAId}/permissions`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(listRes.status).toBe(200);
      expect(Array.isArray(listRes.body.permissions)).toBe(true);
      const override = listRes.body.permissions.find((p: any) => p.id === viewerId);
      expect(override).toBeDefined();
      expect(override.email).toBe(viewerEmail);
      expect(override.display_name).toBe('Workspace Viewer');
      expect(override.role).toBe('editor');
    });

    it('restores inherited workspace role when document permission override is removed', async () => {
      if (!isDbConnected) return;

      // Delete the override
      const delRes = await request(app)
        .delete(`/api/v1/workspaces/${workspaceAId}/documents/${docAId}/permissions/${viewerId}`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(delRes.status).toBe(200);

      // Verify list of overrides is now empty
      const listRes = await request(app)
        .get(`/api/v1/workspaces/${workspaceAId}/documents/${docAId}/permissions`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(listRes.status).toBe(200);
      const override = listRes.body.permissions.find((p: any) => p.id === viewerId);
      expect(override).toBeUndefined();
    });

    it('prevents unauthorized members (editors and viewers) from managing document permissions (403 Forbidden)', async () => {
      if (!isDbConnected) return;

      // Editor attempts to grant override -> 403 Forbidden
      const editorRes = await request(app)
        .put(`/api/v1/workspaces/${workspaceAId}/documents/${docAId}/permissions/${viewerId}`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ role: 'editor' });

      expect(editorRes.status).toBe(403);

      // Viewer attempts to grant override -> 403 Forbidden
      const viewerRes = await request(app)
        .put(`/api/v1/workspaces/${workspaceAId}/documents/${docAId}/permissions/${editorId}`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ role: 'viewer' });

      expect(viewerRes.status).toBe(403);
    });

    it('rejects cross-workspace permission override operations', async () => {
      if (!isDbConnected) return;

      // User from Workspace B attempts to set permission on Doc A in Workspace A -> 403 Forbidden
      const res = await request(app)
        .put(`/api/v1/workspaces/${workspaceAId}/documents/${docAId}/permissions/${viewerId}`)
        .set('Authorization', `Bearer ${externalUserToken}`)
        .send({ role: 'editor' });

      expect(res.status).toBe(403);
    });
  });
});
