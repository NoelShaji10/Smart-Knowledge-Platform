import { ScopedDb } from '@knowledge/database';
import { WorkspaceRole, DocumentRole } from '@knowledge/types';

export interface DocumentCapabilities {
  canRead: boolean;
  canEdit: boolean;
  canMove: boolean;
  canArchive: boolean;
  canManagePermissions: boolean;
}

export interface EffectiveDocumentRoleResult {
  workspaceRole: WorkspaceRole;
  documentOverrideRole: DocumentRole | null;
  effectiveRole: WorkspaceRole | DocumentRole;
  isDenied: boolean;
  capabilities: DocumentCapabilities;
}

/**
  * Resolve authoritatively the effective document role and capabilities for a user in a workspace.
  * Validates workspaceId + documentId match and queries PostgreSQL DB via ScopedDb.
  */
export async function getEffectiveDocumentRole(
  scopedDb: ScopedDb,
  workspaceId: string,
  documentId: string,
  userId: string,
): Promise<EffectiveDocumentRoleResult | null> {
  return scopedDb.execute(async (db) => {
    // 1. Verify document exists in workspace
    const doc = await db
      .selectFrom('documents')
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .select(['id', 'created_by'])
      .executeTakeFirst();

    if (!doc) {
      return null;
    }

    // 2. Verify workspace membership
    const member = await db
      .selectFrom('workspace_members')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .select(['role'])
      .executeTakeFirst();

    if (!member) {
      return null;
    }

    const wsRole = member.role as WorkspaceRole;

    // 3. Query document-level permission override
    const override = await db
      .selectFrom('document_permissions')
      .where('document_id', '=', documentId)
      .where('user_id', '=', userId)
      .select(['role'])
      .executeTakeFirst();

    const overrideRole = override ? (override.role as DocumentRole) : null;

    // 4. Resolve capabilities
    if (overrideRole === 'none') {
      return {
        workspaceRole: wsRole,
        documentOverrideRole: 'none',
        effectiveRole: 'none',
        isDenied: true,
        capabilities: {
          canRead: false,
          canEdit: false,
          canMove: false,
          canArchive: false,
          canManagePermissions: false,
        },
      };
    }

    let canRead = false;
    let canEdit = false;
    let canMove = false;
    let canArchive = false;
    let canManagePermissions = false;

    if (wsRole === 'owner' || wsRole === 'admin') {
      canRead = true;
      canEdit = true;
      canMove = true;
      canArchive = true;
      canManagePermissions = true;
    } else if (wsRole === 'editor') {
      if (overrideRole === 'viewer') {
        canRead = true;
        canEdit = false;
        canMove = false;
        canArchive = false;
        canManagePermissions = false;
      } else {
        // overrideRole === 'editor' or null
        canRead = true;
        canEdit = true;
        canMove = true;
        canArchive = false;
        canManagePermissions = false;
      }
    } else if (wsRole === 'viewer') {
      if (overrideRole === 'editor') {
        canRead = true;
        canEdit = true;
        canMove = false;
        canArchive = false;
        canManagePermissions = false;
      } else {
        // overrideRole === 'viewer' or null
        canRead = true;
        canEdit = false;
        canMove = false;
        canArchive = false;
        canManagePermissions = false;
      }
    }

    const effectiveRole = overrideRole ? overrideRole : wsRole;

    return {
      workspaceRole: wsRole,
      documentOverrideRole: overrideRole,
      effectiveRole,
      isDenied: false,
      capabilities: {
        canRead,
        canEdit,
        canMove,
        canArchive,
        canManagePermissions,
      },
    };
  });
}

/**
  * Set or update a document-level permission override.
  * Restricted strictly to Workspace Owner and Admin.
  */
export async function setDocumentPermission(
  scopedDb: ScopedDb,
  workspaceId: string,
  documentId: string,
  targetUserId: string,
  role: DocumentRole,
  actorUserId: string,
) {
  return scopedDb.execute(async (db) => {
    // 1. Validate actor role
    const actorRole = await getEffectiveDocumentRole(scopedDb, workspaceId, documentId, actorUserId);
    if (!actorRole || (!actorRole.capabilities.canManagePermissions && actorRole.workspaceRole !== 'owner' && actorRole.workspaceRole !== 'admin')) {
      throw new Error('Only workspace owners and admins can manage document permissions');
    }

    // 2. Validate target user is a member of workspace
    const targetMember = await db
      .selectFrom('workspace_members')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', targetUserId)
      .select(['role'])
      .executeTakeFirst();

    if (!targetMember) {
      throw new Error('Target user is not a member of this workspace');
    }

    // 3. Upsert document_permissions
    const existing = await db
      .selectFrom('document_permissions')
      .where('document_id', '=', documentId)
      .where('user_id', '=', targetUserId)
      .select(['role'])
      .executeTakeFirst();

    if (existing) {
      return db
        .updateTable('document_permissions')
        .set({
          role,
          granted_by: actorUserId,
          created_at: new Date(),
        })
        .where('document_id', '=', documentId)
        .where('user_id', '=', targetUserId)
        .returningAll()
        .executeTakeFirstOrThrow();
    }

    return db
      .insertInto('document_permissions')
      .values({
        document_id: documentId,
        user_id: targetUserId,
        role,
        granted_by: actorUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

/**
  * Remove a document-level permission override.
  * Restricted strictly to Workspace Owner and Admin.
  */
export async function removeDocumentPermission(
  scopedDb: ScopedDb,
  workspaceId: string,
  documentId: string,
  targetUserId: string,
  actorUserId: string,
) {
  return scopedDb.execute(async (db) => {
    // 1. Validate actor role
    const actorRole = await getEffectiveDocumentRole(scopedDb, workspaceId, documentId, actorUserId);
    if (!actorRole || (!actorRole.capabilities.canManagePermissions && actorRole.workspaceRole !== 'owner' && actorRole.workspaceRole !== 'admin')) {
      throw new Error('Only workspace owners and admins can manage document permissions');
    }

    // 2. Delete override
    await db
      .deleteFrom('document_permissions')
      .where('document_id', '=', documentId)
      .where('user_id', '=', targetUserId)
      .execute();

    return { ok: true };
  });
}

/**
  * List document-level permission overrides for a document.
  */
export async function getDocumentPermissions(
  scopedDb: ScopedDb,
  workspaceId: string,
  documentId: string,
  actorUserId: string,
) {
  return scopedDb.execute(async (db) => {
    const actorRole = await getEffectiveDocumentRole(scopedDb, workspaceId, documentId, actorUserId);
    if (!actorRole || !actorRole.capabilities.canRead) {
      throw new Error('Access denied to document');
    }

    return db
      .selectFrom('document_permissions')
      .innerJoin('users', 'users.id', 'document_permissions.user_id')
      .leftJoin('workspace_members', (join) =>
        join
          .onRef('workspace_members.user_id', '=', 'document_permissions.user_id')
          .on('workspace_members.workspace_id', '=', workspaceId),
      )
      .where('document_permissions.document_id', '=', documentId)
      .select([
        'users.id',
        'users.email',
        'users.display_name',
        'document_permissions.role',
        'document_permissions.granted_by',
        'document_permissions.created_at',
        'workspace_members.role as workspace_role',
      ])
      .execute();
  });
}
