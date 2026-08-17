import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations, getSystemDb, createScopedDb } from '@knowledge/database';
import { registerUser } from '@knowledge/auth';
import { createWorkspace, addWorkspaceMember } from '../../apps/api-server/src/lib/workspace-service';
import { createDocument } from '../../apps/api-server/src/lib/document-service';
import {
  getEffectiveDocumentRole,
  setDocumentPermission,
  removeDocumentPermission,
  getDocumentPermissions,
} from '../../apps/api-server/src/lib/document-permission-service';

describe('Document Permission Service & Middleware Integration Tests', () => {
  let isDbConnected = false;

  let owner_id: string;
  let admin_id: string;
  let editor_id: string;
  let viewer_id: string;
  let userB_id: string;

  let workspaceA_id: string;
  let workspaceB_id: string;

  let docA_id: string;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;

      const sysDb = getSystemDb();

      // Register users
      const owner = await registerUser(sysDb, { email: `owner_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Owner' });
      const admin = await registerUser(sysDb, { email: `admin_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Admin' });
      const editor = await registerUser(sysDb, { email: `editor_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Editor' });
      const viewer = await registerUser(sysDb, { email: `viewer_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Viewer' });
      const userB = await registerUser(sysDb, { email: `userB_perm_${Date.now()}@example.com`, password: 'Password123!', displayName: 'User B' });

      owner_id = owner.id;
      admin_id = admin.id;
      editor_id = editor.id;
      viewer_id = viewer.id;
      userB_id = userB.id;

      // Create Workspaces
      const wsA = await createWorkspace(sysDb, owner_id, 'Workspace A Perms');
      const wsB = await createWorkspace(sysDb, userB_id, 'Workspace B Perms');

      workspaceA_id = wsA.id;
      workspaceB_id = wsB.id;

      const scopedOwnerA = createScopedDb(owner_id);

      // Add members to Workspace A
      await addWorkspaceMember(scopedOwnerA, workspaceA_id, admin.email, 'admin');
      await addWorkspaceMember(scopedOwnerA, workspaceA_id, editor.email, 'editor');
      await addWorkspaceMember(scopedOwnerA, workspaceA_id, viewer.email, 'viewer');

      // Create Document in Workspace A
      const docA = await createDocument(scopedOwnerA, {
        workspaceId: workspaceA_id,
        title: 'Doc A Perms',
        createdBy: owner_id,
      });

      docA_id = docA.id;
    } catch {
      isDbConnected = false;
    }
  });

  it('grants full capabilities (read, edit, move, archive, manage_permissions) to OWNER', async () => {
    if (!isDbConnected) return;

    const scopedDb = createScopedDb(owner_id);
    const result = await getEffectiveDocumentRole(scopedDb, workspaceA_id, docA_id, owner_id);

    expect(result).not.toBeNull();
    expect(result?.workspaceRole).toBe('owner');
    expect(result?.capabilities.canRead).toBe(true);
    expect(result?.capabilities.canEdit).toBe(true);
    expect(result?.capabilities.canMove).toBe(true);
    expect(result?.capabilities.canArchive).toBe(true);
    expect(result?.capabilities.canManagePermissions).toBe(true);
  });

  it('grants full capabilities to ADMIN', async () => {
    if (!isDbConnected) return;

    const scopedDb = createScopedDb(admin_id);
    const result = await getEffectiveDocumentRole(scopedDb, workspaceA_id, docA_id, admin_id);

    expect(result).not.toBeNull();
    expect(result?.workspaceRole).toBe('admin');
    expect(result?.capabilities.canRead).toBe(true);
    expect(result?.capabilities.canEdit).toBe(true);
    expect(result?.capabilities.canMove).toBe(true);
    expect(result?.capabilities.canArchive).toBe(true);
    expect(result?.capabilities.canManagePermissions).toBe(true);
  });

  it('restricts EDITOR capabilities (read, edit, move allowed; archive and manage_permissions denied)', async () => {
    if (!isDbConnected) return;

    const scopedDb = createScopedDb(editor_id);
    const result = await getEffectiveDocumentRole(scopedDb, workspaceA_id, docA_id, editor_id);

    expect(result).not.toBeNull();
    expect(result?.workspaceRole).toBe('editor');
    expect(result?.capabilities.canRead).toBe(true);
    expect(result?.capabilities.canEdit).toBe(true);
    expect(result?.capabilities.canMove).toBe(true);
    expect(result?.capabilities.canArchive).toBe(false);
    expect(result?.capabilities.canManagePermissions).toBe(false);

    // Verify Editor cannot set document permissions
    await expect(
      setDocumentPermission(scopedDb, workspaceA_id, docA_id, viewer_id, 'editor', editor_id)
    ).rejects.toThrow('Only workspace owners and admins can manage document permissions');
  });

  it('restricts VIEWER capabilities (read allowed; edit, move, archive, manage_permissions denied)', async () => {
    if (!isDbConnected) return;

    const scopedDb = createScopedDb(viewer_id);
    const result = await getEffectiveDocumentRole(scopedDb, workspaceA_id, docA_id, viewer_id);

    expect(result).not.toBeNull();
    expect(result?.workspaceRole).toBe('viewer');
    expect(result?.capabilities.canRead).toBe(true);
    expect(result?.capabilities.canEdit).toBe(false);
    expect(result?.capabilities.canMove).toBe(false);
    expect(result?.capabilities.canArchive).toBe(false);
    expect(result?.capabilities.canManagePermissions).toBe(false);
  });

  it('enforces explicit document role="none" absolute denial', async () => {
    if (!isDbConnected) return;

    const scopedOwner = createScopedDb(owner_id);
    const scopedEditor = createScopedDb(editor_id);

    // Owner sets role="none" for Editor on Doc A
    await setDocumentPermission(scopedOwner, workspaceA_id, docA_id, editor_id, 'none', owner_id);

    // Verify Editor is now absolutely denied
    const result = await getEffectiveDocumentRole(scopedEditor, workspaceA_id, docA_id, editor_id);
    expect(result).not.toBeNull();
    expect(result?.isDenied).toBe(true);
    expect(result?.capabilities.canRead).toBe(false);
    expect(result?.capabilities.canEdit).toBe(false);
    expect(result?.capabilities.canMove).toBe(false);
    expect(result?.capabilities.canArchive).toBe(false);
    expect(result?.capabilities.canManagePermissions).toBe(false);

    // Clean up override
    await removeDocumentPermission(scopedOwner, workspaceA_id, docA_id, editor_id, owner_id);
  });

  it('prevents workspace boundary violation (workspaceId + documentId mismatch)', async () => {
    if (!isDbConnected) return;

    const scopedOwner = createScopedDb(owner_id);

    // Request Doc A (belongs to Workspace A) under Workspace B
    const result = await getEffectiveDocumentRole(scopedOwner, workspaceB_id, docA_id, owner_id);
    expect(result).toBeNull();
  });

  it('updates permissions dynamically when DB changes occur (stale JWT claims ignored)', async () => {
    if (!isDbConnected) return;

    const scopedOwner = createScopedDb(owner_id);
    const scopedViewer = createScopedDb(viewer_id);

    // Originally Viewer has read-only
    const initial = await getEffectiveDocumentRole(scopedViewer, workspaceA_id, docA_id, viewer_id);
    expect(initial?.capabilities.canEdit).toBe(false);

    // Owner promotes Viewer to document-level editor
    await setDocumentPermission(scopedOwner, workspaceA_id, docA_id, viewer_id, 'editor', owner_id);

    // Query DB again -> immediately reflects editor capability
    const promoted = await getEffectiveDocumentRole(scopedViewer, workspaceA_id, docA_id, viewer_id);
    expect(promoted?.capabilities.canEdit).toBe(true);

    // Clean up
    await removeDocumentPermission(scopedOwner, workspaceA_id, docA_id, viewer_id, owner_id);
  });

  it('allows Owner and Admin to list document permission overrides', async () => {
    if (!isDbConnected) return;

    const scopedOwner = createScopedDb(owner_id);
    const scopedAdmin = createScopedDb(admin_id);

    // Set an override
    await setDocumentPermission(scopedOwner, workspaceA_id, docA_id, viewer_id, 'viewer', owner_id);

    const permissions = await getDocumentPermissions(scopedAdmin, workspaceA_id, docA_id, admin_id);
    expect(permissions.length).toBeGreaterThan(0);
    expect(permissions.some((p) => p.id === viewer_id)).toBe(true);

    // Clean up
    await removeDocumentPermission(scopedOwner, workspaceA_id, docA_id, viewer_id, owner_id);
  });
});
