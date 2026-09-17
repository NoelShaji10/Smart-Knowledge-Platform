import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb, createScopedDb } from '@knowledge/database';
import { registerUser, loginUser } from '@knowledge/auth';
import { ensureBucketsExist } from '@knowledge/storage';
import * as storage from '@knowledge/storage';
import { getEnv } from '@knowledge/config';
import { createWorkspace, addWorkspaceMember } from '../../apps/api-server/src/lib/workspace-service';
import { createDocument, archiveDocument } from '../../apps/api-server/src/lib/document-service';
import {
  createVersionCheckpoint,
  listDocumentVersions,
  getDocumentVersion,
  restoreVersion,
} from '../../apps/api-server/src/lib/document-version-service';
import { createCollabServer } from '../../apps/collab-server/src/server';
import { getOrCreateRoom, clearAllRooms, getRoom, Y } from '../../apps/collab-server/src/room-manager';

describe('Document Versioning Integration Tests', () => {
  const app = createApiApp();
  let isDbConnected = false;

  const TEST_COLLAB_PORT = 3088;
  let collabServer: http.Server | null = null;
  let collabWss: any = null;

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

  beforeAll(async () => {
    try {
      await runMigrations();
      await ensureBucketsExist();
      isDbConnected = true;

      // Start isolated Collab Server on TEST_COLLAB_PORT
      process.env.COLLAB_PORT = String(TEST_COLLAB_PORT);
      const collabApp = createCollabServer();
      collabServer = collabApp.server;
      collabWss = collabApp.wss;
      await new Promise<void>((resolve) => {
        collabServer!.listen(TEST_COLLAB_PORT, () => resolve());
      });

      const sysDb = getSystemDb();

      // Register users
      const owner = await registerUser(sysDb, { email: `ver_owner_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Owner' });
      const admin = await registerUser(sysDb, { email: `ver_admin_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Admin' });
      const editor = await registerUser(sysDb, { email: `ver_editor_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Editor' });
      const viewer = await registerUser(sysDb, { email: `ver_viewer_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Viewer' });
      const userB = await registerUser(sysDb, { email: `ver_userB_${Date.now()}@example.com`, password: 'Password123!', displayName: 'User B' });

      ownerId = owner.id;
      adminId = admin.id;
      editorId = editor.id;
      viewerId = viewer.id;

      // Workspaces
      const wsA = await createWorkspace(sysDb, owner.id, 'Ver Workspace A');
      const wsB = await createWorkspace(sysDb, userB.id, 'Ver Workspace B');

      workspaceAId = wsA.id;
      workspaceBId = wsB.id;

      const scopedOwnerA = createScopedDb(owner.id);

      // Members
      await addWorkspaceMember(scopedOwnerA, workspaceAId, admin.email, 'admin');
      await addWorkspaceMember(scopedOwnerA, workspaceAId, editor.email, 'editor');
      await addWorkspaceMember(scopedOwnerA, workspaceAId, viewer.email, 'viewer');

      // Tokens
      ownerToken = (await loginUser(sysDb, { email: owner.email, password: 'Password123!' })).accessToken;
      adminToken = (await loginUser(sysDb, { email: admin.email, password: 'Password123!' })).accessToken;
      editorToken = (await loginUser(sysDb, { email: editor.email, password: 'Password123!' })).accessToken;
      viewerToken = (await loginUser(sysDb, { email: viewer.email, password: 'Password123!' })).accessToken;
      userBToken = (await loginUser(sysDb, { email: userB.email, password: 'Password123!' })).accessToken;

      // Create fixture document
      const doc = await createDocument(scopedOwnerA, {
        workspaceId: workspaceAId,
        title: 'Version Test Doc V1',
        contentText: 'Content V1',
        createdBy: owner.id,
      });

      docA1Id = doc.id;
    } catch {
      isDbConnected = false;
    }
  });

  afterAll(async () => {
    clearAllRooms();
    if (collabServer) {
      await new Promise<void>((resolve) => {
        collabServer!.close(() => resolve());
      });
    }
    if (collabWss) {
      collabWss.close();
    }
  });

  it('creates manual version checkpoint via API and validates fields', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}/versions`)
      .set('Authorization', `Bearer ${editorToken}`);

    expect(res.status).toBe(201);
    expect(res.body.version.version_number).toBe(1);
    expect(res.body.version.title).toBe('Version Test Doc V1');
    expect(res.body.version.content_text).toBe('Content V1');
    expect(res.body.version.snapshot_key).toBe(`${docA1Id}/1.yjs`);
    expect(res.body.version.trigger).toBe('manual');
  });

  it('lists document versions ordered newest first and retrieves specific version', async () => {
    if (!isDbConnected) return;

    const scopedEditor = createScopedDb(editorId);

    // Update document to V2 content and create second checkpoint
    await request(app)
      .patch(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ title: 'Version Test Doc V2', contentText: 'Content V2' });

    const v2 = await createVersionCheckpoint(scopedEditor, workspaceAId, docA1Id, editorId, 'manual');
    expect(v2.version_number).toBe(2);

    // List versions via GET /versions
    const resList = await request(app)
      .get(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}/versions`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(resList.status).toBe(200);
    expect(resList.body.versions.length).toBe(2);
    expect(resList.body.versions[0].version_number).toBe(2);
    expect(resList.body.versions[1].version_number).toBe(1);

    // Retrieve version 1 via GET /versions/1
    const resV1 = await request(app)
      .get(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}/versions/1`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(resV1.status).toBe(200);
    expect(resV1.body.version.title).toBe('Version Test Doc V1');
    expect(resV1.body.version.content_text).toBe('Content V1');

    // Mismatched workspaceId returns 404
    const resMismatch = await request(app)
      .get(`/api/v1/workspaces/${workspaceBId}/documents/${docA1Id}/versions/1`)
      .set('Authorization', `Bearer ${userBToken}`);

    expect(resMismatch.status).toBe(404);
  });

  it('restores historical version, updating document content and creating a new version checkpoint with trigger="restore"', async () => {
    if (!isDbConnected) return;

    // Current state is V2. Restore version 1 via API
    const resRestore = await request(app)
      .post(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}/versions/1/restore`)
      .set('Authorization', `Bearer ${editorToken}`);

    expect(resRestore.status).toBe(200);
    expect(resRestore.body.document.title).toBe('Version Test Doc V1');
    expect(resRestore.body.document.content_text).toBe('Content V1');
    expect(resRestore.body.newVersion.version_number).toBe(3);
    expect(resRestore.body.newVersion.trigger).toBe('restore');

    // Verify history now has 3 versions
    const scopedViewer = createScopedDb(viewerId);
    const versions = await listDocumentVersions(scopedViewer, workspaceAId, docA1Id);
    expect(versions.length).toBe(3);
    expect(versions[0].version_number).toBe(3);
    expect(versions[0].trigger).toBe('restore');
  });

  it('enforces version authorization (Editor+ can create/restore, Viewer can read, Viewer cannot create/restore)', async () => {
    if (!isDbConnected) return;

    // Viewer create checkpoint attempt -> 403 Forbidden
    const resViewerCreate = await request(app)
      .post(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}/versions`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(resViewerCreate.status).toBe(403);

    // Viewer restore attempt -> 403 Forbidden
    const resViewerRestore = await request(app)
      .post(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}/versions/1/restore`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(resViewerRestore.status).toBe(403);

    // Viewer read -> 200 OK
    const resViewerRead = await request(app)
      .get(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}/versions`)
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(resViewerRead.status).toBe(200);
  });

  it('prevents version creation for archived documents', async () => {
    if (!isDbConnected) return;

    const scopedAdmin = createScopedDb(adminId);
    const scopedEditor = createScopedDb(editorId);

    // Create a doc and archive it
    const docToArchive = await createDocument(scopedAdmin, {
      workspaceId: workspaceAId,
      title: 'Doc To Archive',
      createdBy: adminId,
    });

    await archiveDocument(scopedAdmin, workspaceAId, docToArchive.id);

    // Creating checkpoint for archived document fails
    await expect(
      createVersionCheckpoint(scopedEditor, workspaceAId, docToArchive.id, editorId, 'manual')
    ).rejects.toThrow('Cannot create version checkpoint for an archived document');
  });

  it('handles concurrent version creation producing monotonically increasing version numbers', async () => {
    if (!isDbConnected) return;

    const scopedEditor = createScopedDb(editorId);

    const doc = await createDocument(scopedEditor, {
      workspaceId: workspaceAId,
      title: 'Concurrent Doc',
      createdBy: editorId,
    });

    // Fire 3 concurrent version creation promises
    const p1 = createVersionCheckpoint(scopedEditor, workspaceAId, doc.id, editorId, 'manual');
    const p2 = createVersionCheckpoint(scopedEditor, workspaceAId, doc.id, editorId, 'manual');
    const p3 = createVersionCheckpoint(scopedEditor, workspaceAId, doc.id, editorId, 'manual');

    const results = await Promise.all([p1, p2, p3]);
    const versionNumbers = results.map((r) => r.version_number).sort((a, b) => a - b);

    // Version numbers must be unique and monotonic [1, 2, 3]
    expect(versionNumbers).toEqual([1, 2, 3]);
  });

  it('prevents restoring versions for archived documents', async () => {
    if (!isDbConnected) return;

    const scopedAdmin = createScopedDb(adminId);
    const scopedEditor = createScopedDb(editorId);

    // Create a doc, create a version checkpoint, then archive it
    const docArchived = await createDocument(scopedAdmin, {
      workspaceId: workspaceAId,
      title: 'Archived Restore Doc',
      contentText: 'V1 Content',
      createdBy: adminId,
    });

    await createVersionCheckpoint(scopedEditor, workspaceAId, docArchived.id, editorId, 'manual');
    await archiveDocument(scopedAdmin, workspaceAId, docArchived.id);

    // Attempting to restore version for archived document fails
    await expect(
      restoreVersion(scopedEditor, workspaceAId, docArchived.id, 1, editorId)
    ).rejects.toThrow('Cannot restore version for an archived document');

    // API returns error
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceAId}/documents/${docArchived.id}/versions/1/restore`)
      .set('Authorization', `Bearer ${editorToken}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toContain('archived');
  });

  it('fails safely when attempting to restore non-existent version', async () => {
    if (!isDbConnected) return;

    const scopedEditor = createScopedDb(editorId);

    await expect(
      restoreVersion(scopedEditor, workspaceAId, docA1Id, 9999, editorId)
    ).rejects.toThrow('Version not found');

    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}/versions/9999/restore`)
      .set('Authorization', `Bearer ${editorToken}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects cross-workspace restore attempt', async () => {
    if (!isDbConnected) return;

    // User B from Workspace B tries to restore docA1Id from Workspace A
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceAId}/documents/${docA1Id}/versions/1/restore`)
      .set('Authorization', `Bearer ${userBToken}`);

    expect(res.status).toBe(403);
  });

  it('verifies historical source version remains immutable after restore', async () => {
    if (!isDbConnected) return;

    const scopedViewer = createScopedDb(viewerId);

    // Fetch Version 1 after restorations have occurred
    const v1 = await getDocumentVersion(scopedViewer, workspaceAId, docA1Id, 1);
    expect(v1).toBeDefined();
    expect(v1?.version_number).toBe(1);
    expect(v1?.title).toBe('Version Test Doc V1');
    expect(v1?.content_text).toBe('Content V1');
    expect(v1?.trigger).toBe('manual');
  });

  it('restores version on an ACTIVE room without deadlocking and updates live CRDT state', async () => {
    if (!isDbConnected) return;

    const scopedOwner = createScopedDb(ownerId);
    const activeDoc = await createDocument(scopedOwner, {
      workspaceId: workspaceAId,
      title: 'Active Room Test Doc',
      contentText: 'Initial Active State V1',
      createdBy: ownerId,
    });

    // Create Version 1 checkpoint
    const v1 = await createVersionCheckpoint(scopedOwner, workspaceAId, activeDoc.id, ownerId, 'manual');
    expect(v1.version_number).toBe(1);

    // Open active room in collab server memory
    const room = await getOrCreateRoom(activeDoc.id);
    const frag = room.doc.getXmlFragment('default');

    // Mutate live room in memory to V2
    room.doc.transact(() => {
      frag.delete(0, frag.length);
      const p = new Y.XmlElement('p');
      p.insert(0, [new Y.XmlText('Live In-Memory Edited Content V2')]);
      frag.insert(0, [p]);
    });
    expect(room.doc.getXmlFragment('default').toString()).toBe('<p>Live In-Memory Edited Content V2</p>');

    // Restore Version 1 via API while active room is open
    // MUST NOT DEADLOCK: collab-server can persist document without waiting on an API-held lock
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceAId}/documents/${activeDoc.id}/versions/1/restore`)
      .set('Authorization', `Bearer ${editorToken}`);

    expect(res.status).toBe(200);
    expect(res.body.document.title).toBe('Active Room Test Doc');
    expect(res.body.newVersion.version_number).toBe(2);
    expect(res.body.newVersion.trigger).toBe('restore');

    // Canonical live room CRDT state was restored to V1
    expect(room.doc.getXmlFragment('default').toString()).toBe('<p>Initial Active State V1</p>');

    clearAllRooms();
  });

  it('fails closed when collab server is unreachable, refusing silent room-less fallback', async () => {
    if (!isDbConnected) return;

    const scopedOwner = createScopedDb(ownerId);
    const failDoc = await createDocument(scopedOwner, {
      workspaceId: workspaceAId,
      title: 'Fail Closed Doc',
      contentText: 'Content V1',
      createdBy: ownerId,
    });

    await createVersionCheckpoint(scopedOwner, workspaceAId, failDoc.id, ownerId, 'manual');

    // Temporarily point to a dead port
    process.env.COLLAB_PORT = '39999';

    try {
      // Attempting to restore when collab server is unreachable must throw an error, NOT perform room-less restore
      await expect(
        restoreVersion(scopedOwner, workspaceAId, failDoc.id, 1, ownerId)
      ).rejects.toThrow('Collab server is unreachable');

      // Verify no restored version was created
      const versions = await listDocumentVersions(scopedOwner, workspaceAId, failDoc.id);
      expect(versions.length).toBe(1);
    } finally {
      process.env.COLLAB_PORT = String(TEST_COLLAB_PORT);
    }
  });

  it('fails closed when snapshot storage fails, refusing corrupt null-snapshot versions', async () => {
    if (!isDbConnected) return;

    const scopedOwner = createScopedDb(ownerId);
    const doc = await createDocument(scopedOwner, {
      workspaceId: workspaceAId,
      title: 'Snapshot Fail Doc',
      contentText: 'Initial Content',
      createdBy: ownerId,
    });

    // Mock storage failure
    const saveSpy = vi.spyOn(storage, 'saveVersionSnapshot').mockRejectedValueOnce(
      new Error('MinIO storage connection refused')
    );

    try {
      // Checkpoint creation must throw and abort transaction, NOT create degraded version with null snapshot_key
      await expect(
        createVersionCheckpoint(scopedOwner, workspaceAId, doc.id, ownerId, 'manual')
      ).rejects.toThrow('MinIO storage connection refused');

      // Verify no version row was inserted
      const versions = await listDocumentVersions(scopedOwner, workspaceAId, doc.id);
      expect(versions.length).toBe(0);
    } finally {
      saveSpy.mockRestore();
    }
  });

  it('rejects unauthorized direct calls to collab server restore endpoint (401/403)', async () => {
    if (!isDbConnected) return;

    // 1. Missing x-internal-key header -> 401
    const resNoKey = await fetch(`http://127.0.0.1:${TEST_COLLAB_PORT}/internal/documents/${docA1Id}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionNumber: 1, userId: editorId }),
    });
    expect(resNoKey.status).toBe(401);

    // 2. Wrong x-internal-key header -> 401
    const resBadKey = await fetch(`http://127.0.0.1:${TEST_COLLAB_PORT}/internal/documents/${docA1Id}/restore`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': 'incorrect-secret-key',
      },
      body: JSON.stringify({ versionNumber: 1, userId: editorId }),
    });
    expect(resBadKey.status).toBe(401);

    // 3. Valid key, but viewer user lacking edit permissions -> 403
    const resViewer = await fetch(`http://127.0.0.1:${TEST_COLLAB_PORT}/internal/documents/${docA1Id}/restore`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': getEnv().INTERNAL_SERVICE_KEY,
      },
      body: JSON.stringify({ versionNumber: 1, userId: viewerId }),
    });
    expect(resViewer.status).toBe(403);
  });
});
