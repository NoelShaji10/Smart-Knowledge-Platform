import * as Y from 'yjs';
import { sql } from 'kysely';
import { ScopedDb } from '@knowledge/database';
import { VersionTrigger } from '@knowledge/types';
import { getEnv } from '@knowledge/config';
import {
  loadVersionSnapshot,
  saveVersionSnapshot,
  loadRecoverySnapshot,
  saveRecoverySnapshot,
} from '@knowledge/storage';

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
      .select(['id', 'title', 'content_text', 'is_archived', 'snapshot_key'])
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

    // 3. Attempt to capture Yjs snapshot for this version
    let versionKey: string | null = null;
    try {
      let snapshotBytes = await loadRecoverySnapshot(documentId);
      if (!snapshotBytes && doc.content_text) {
        const tempDoc = new Y.Doc();
        const frag = tempDoc.getXmlFragment('default');
        const p = new Y.XmlElement('p');
        p.insert(0, [new Y.XmlText(doc.content_text)]);
        frag.insert(0, [p]);
        snapshotBytes = Y.encodeStateAsUpdate(tempDoc);
      }
      if (snapshotBytes && snapshotBytes.length > 0) {
        versionKey = await saveVersionSnapshot(documentId, nextVersion, snapshotBytes);
      }
    } catch {
      // Fallback: if MinIO snapshot storage fails, snapshot_key remains null
    }

    // 4. Insert new version row
    const versionRow = await db
      .insertInto('document_versions')
      .values({
        document_id: documentId,
        version_number: nextVersion,
        snapshot_key: versionKey,
        title: doc.title,
        content_text: doc.content_text,
        created_by: userId,
        trigger: trigger,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // 5. Update documents.snapshot_version
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

    if (!versionRow) {
      return null;
    }

    // If snapshot exists and content_text is missing, extract preview from snapshot
    if (!versionRow.content_text && versionRow.snapshot_key) {
      try {
        const bytes = await loadVersionSnapshot(documentId, versionNumber);
        if (bytes && bytes.length > 0) {
          const tempDoc = new Y.Doc();
          Y.applyUpdate(tempDoc, bytes);
          const frag = tempDoc.getXmlFragment('default');
          const extracted = frag.toString();
          if (extracted) {
            versionRow.content_text = extracted;
          }
        }
      } catch {
        // Safe fallback
      }
    }

    return versionRow;
  });
}

/**
 * Restore a historical version.
 * Restores canonical live Yjs document for active room or updates recovery snapshot for room-less restore.
 * Creates a NEW version checkpoint with trigger = 'restore'.
 * Rejects restoration if document is archived.
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
      .select(['id', 'title', 'content_text', 'parent_id', 'is_archived'])
      .forUpdate()
      .executeTakeFirst();

    if (!doc) {
      throw new Error('Document not found');
    }

    // Invariant: Restoring into an archived document is rejected
    if (doc.is_archived) {
      throw new Error('Cannot restore version for an archived document');
    }

    const versionRow = await getDocumentVersion(scopedDb, workspaceId, documentId, versionNumber);
    if (!versionRow) {
      throw new Error('Version not found');
    }

    // Step A: Attempt to delegate to Collab Server if an active room exists
    const env = getEnv();
    const collabPort = env.COLLAB_PORT || '3001';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(`http://127.0.0.1:${collabPort}/internal/documents/${documentId}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          versionNumber,
          userId,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const body = (await res.json()) as any;
        if (body.hasActiveRoom && body.document && body.newVersion) {
          return {
            document: body.document,
            newVersion: body.newVersion,
          };
        }
      }
    } catch {
      // Collab server not running or unreachable -> proceed with room-less restore
    }

    // Step B: Room-less restore (no active collaboration room)
    // 1. Load historical snapshot bytes
    const snapshotBytes = await loadVersionSnapshot(documentId, versionNumber);
    const histDoc = new Y.Doc();

    if (snapshotBytes && snapshotBytes.length > 0) {
      try {
        Y.applyUpdate(histDoc, snapshotBytes);
      } catch (err) {
        throw new Error('Historical version snapshot is corrupt or invalid');
      }
    } else if (versionRow.content_text !== null && versionRow.content_text !== undefined) {
      // Fallback for legacy checkpoints
      const frag = histDoc.getXmlFragment('default');
      const p = new Y.XmlElement('p');
      p.insert(0, [new Y.XmlText(versionRow.content_text)]);
      frag.insert(0, [p]);
    }

    // 2. Encode restored update bytes
    const restoredBytes = Y.encodeStateAsUpdate(histDoc);
    const restoredTitle = versionRow.title || 'Untitled';
    const restoredContentText = versionRow.content_text || '';

    // 3. Persist restored state to recovery snapshot in MinIO (so next room hydration loads restored state)
    let recoveryKey: string | null = null;
    try {
      recoveryKey = await saveRecoverySnapshot(documentId, restoredBytes);
    } catch {
      // If MinIO is offline in mock test, recoveryKey is null
    }

    // 4. Atomic next version calculation
    const maxRes = await db
      .selectFrom('document_versions')
      .where('document_id', '=', documentId)
      .select(sql<string | number>`COALESCE(MAX(version_number), 0)`.as('max_ver'))
      .executeTakeFirst();

    const nextVersion = Number(maxRes?.max_ver || 0) + 1;

    // 5. Save version snapshot for the newly created restore checkpoint
    let versionKey: string | null = null;
    try {
      versionKey = await saveVersionSnapshot(documentId, nextVersion, restoredBytes);
    } catch {
      // If MinIO is offline in mock test, versionKey is null
    }

    // 6. Update current document title and content_text in PostgreSQL
    const updatedDoc = await db
      .updateTable('documents')
      .set({
        title: restoredTitle,
        content_text: restoredContentText,
        snapshot_key: recoveryKey || versionKey,
        snapshot_version: nextVersion,
        updated_at: new Date(),
      })
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .returningAll()
      .executeTakeFirstOrThrow();

    // 7. Create NEW version checkpoint capturing restored state with trigger = 'restore'
    const newVersion = await db
      .insertInto('document_versions')
      .values({
        document_id: documentId,
        version_number: nextVersion,
        snapshot_key: versionKey,
        title: restoredTitle,
        content_text: restoredContentText,
        created_by: userId,
        trigger: 'restore',
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return {
      document: updatedDoc,
      newVersion,
    };
  });
}
