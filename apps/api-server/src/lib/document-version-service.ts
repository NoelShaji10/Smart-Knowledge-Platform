import { sql } from 'kysely';
import { ScopedDb } from '@knowledge/database';
import { VersionTrigger } from '@knowledge/types';

/**
  * Create a manual (or system-triggered) version checkpoint for a document.
  * Validates document belongs to workspaceId and is not archived.
  * Version numbers are monotonically increasing per document.
  */
export async function createVersionCheckpoint(
  scopedDb: ScopedDb,
  workspaceId: string,
  documentId: string,
  userId: string,
  trigger: VersionTrigger = 'manual',
) {
  return scopedDb.execute(async (db) => {
    // 1. Validate document exists in workspace
    const doc = await db
      .selectFrom('documents')
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .select(['id', 'title', 'content_text', 'is_archived'])
      .forUpdate()
      .executeTakeFirst();

    if (!doc) {
      throw new Error('Document not found');
    }

    if (doc.is_archived) {
      throw new Error('Cannot create version checkpoint for an archived document');
    }

    // 2. Atomic next version calculation
    const maxRes = await db
      .selectFrom('document_versions')
      .where('document_id', '=', documentId)
      .select(sql<string | number>`COALESCE(MAX(version_number), 0)`.as('max_ver'))
      .executeTakeFirst();

    const nextVersion = Number(maxRes?.max_ver || 0) + 1;

    // 3. Insert new version row with snapshot_key = null
    const versionRow = await db
      .insertInto('document_versions')
      .values({
        document_id: documentId,
        version_number: nextVersion,
        snapshot_key: null,
        title: doc.title,
        content_text: doc.content_text,
        created_by: userId,
        trigger: trigger,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // 4. Update documents.snapshot_version
    await db
      .updateTable('documents')
      .set({ snapshot_version: nextVersion })
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .execute();

    return versionRow;
  });
}

/**
  * List document versions ordered newest first (version_number DESC).
  */
export async function listDocumentVersions(
  scopedDb: ScopedDb,
  workspaceId: string,
  documentId: string,
) {
  return scopedDb.execute(async (db) => {
    const doc = await db
      .selectFrom('documents')
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .select(['id'])
      .executeTakeFirst();

    if (!doc) {
      throw new Error('Document not found');
    }

    return db
      .selectFrom('document_versions')
      .leftJoin('users', 'users.id', 'document_versions.created_by')
      .where('document_versions.document_id', '=', documentId)
      .select([
        'document_versions.id',
        'document_versions.document_id',
        'document_versions.version_number',
        'document_versions.snapshot_key',
        'document_versions.title',
        'document_versions.content_text',
        'document_versions.trigger',
        'document_versions.created_by',
        'document_versions.created_at',
        'users.display_name as creator_name',
        'users.email as creator_email',
      ])
      .orderBy('document_versions.version_number', 'desc')
      .execute();
  });
}

/**
  * Get a specific version of a document by versionNumber.
  * Validates workspaceId + documentId + versionNumber.
  */
export async function getDocumentVersion(
  scopedDb: ScopedDb,
  workspaceId: string,
  documentId: string,
  versionNumber: number,
) {
  return scopedDb.execute(async (db) => {
    const doc = await db
      .selectFrom('documents')
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .select(['id'])
      .executeTakeFirst();

    if (!doc) {
      return null;
    }

    const versionRow = await db
      .selectFrom('document_versions')
      .leftJoin('users', 'users.id', 'document_versions.created_by')
      .where('document_versions.document_id', '=', documentId)
      .where('document_versions.version_number', '=', versionNumber)
      .select([
        'document_versions.id',
        'document_versions.document_id',
        'document_versions.version_number',
        'document_versions.snapshot_key',
        'document_versions.title',
        'document_versions.content_text',
        'document_versions.trigger',
        'document_versions.created_by',
        'document_versions.created_at',
        'users.display_name as creator_name',
        'users.email as creator_email',
      ])
      .executeTakeFirst();

    return versionRow || null;
  });
}

/**
  * Restore a historical version.
  * Updates current document content/title to version state and inserts a NEW version checkpoint with trigger = 'restore'.
  * If the document is currently archived, restores the document itself (promoting to root if parent is archived).
  */
export async function restoreVersion(
  scopedDb: ScopedDb,
  workspaceId: string,
  documentId: string,
  versionNumber: number,
  userId: string,
) {
  return scopedDb.execute(async (db) => {
    const doc = await db
      .selectFrom('documents')
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .select(['id', 'parent_id', 'is_archived'])
      .forUpdate()
      .executeTakeFirst();

    if (!doc) {
      throw new Error('Document not found');
    }

    const versionRow = await getDocumentVersion(scopedDb, workspaceId, documentId, versionNumber);
    if (!versionRow) {
      throw new Error('Version not found');
    }

    let targetParentId = doc.parent_id;
    let newIsArchived = doc.is_archived;

    // If document is archived, restoring a version restores the document itself
    if (doc.is_archived) {
      newIsArchived = false;
      if (targetParentId) {
        const parent = await db
          .selectFrom('documents')
          .where('id', '=', targetParentId)
          .where('workspace_id', '=', workspaceId)
          .select(['id', 'is_archived'])
          .executeTakeFirst();

        if (!parent || parent.is_archived) {
          targetParentId = null; // Promote to root
        }
      }
    }

    // 1. Update current document title and content_text
    const updatedDoc = await db
      .updateTable('documents')
      .set({
        title: versionRow.title || 'Untitled',
        content_text: versionRow.content_text || '',
        is_archived: newIsArchived,
        parent_id: targetParentId,
        updated_at: new Date(),
      })
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .returningAll()
      .executeTakeFirstOrThrow();

    // 2. Atomic next version calculation for new restored version
    const maxRes = await db
      .selectFrom('document_versions')
      .where('document_id', '=', documentId)
      .select(sql<string | number>`COALESCE(MAX(version_number), 0)`.as('max_ver'))
      .executeTakeFirst();

    const nextVersion = Number(maxRes?.max_ver || 0) + 1;

    // 3. Create NEW version checkpoint capturing restored state with trigger = 'restore'
    const newVersion = await db
      .insertInto('document_versions')
      .values({
        document_id: documentId,
        version_number: nextVersion,
        snapshot_key: null,
        title: versionRow.title || 'Untitled',
        content_text: versionRow.content_text || '',
        created_by: userId,
        trigger: 'restore',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // 4. Update documents.snapshot_version
    await db
      .updateTable('documents')
      .set({ snapshot_version: nextVersion })
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .execute();

    return {
      document: updatedDoc,
      newVersion,
    };
  });
}
