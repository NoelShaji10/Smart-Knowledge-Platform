import * as Y from 'yjs';
import { sql } from 'kysely';
import { ScopedDb } from '@knowledge/database';
import { VersionTrigger } from '@knowledge/types';
import { getEnv } from '@knowledge/config';
import { loadVersionSnapshot } from '@knowledge/storage';

/**
 * Create a manual (or system-triggered) version checkpoint for a document.
 * Validates document belongs to workspaceId and is not archived.
 * Delegates to Collab Server under unified per-document distributed lock (Option A),
 * guaranteeing that live room state flush and version allocation occur atomically without race conditions.
 */
export async function createVersionCheckpoint(
  scopedDb: ScopedDb,
  workspaceId: string,
  documentId: string,
  userId: string,
  trigger: VersionTrigger = 'manual',
) {
  // Pre-flight check: ensure document exists in workspace and is not archived
  const doc = await scopedDb.execute(async (db) => {
    return await db
      .selectFrom('documents')
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .select(['id', 'is_archived'])
      .executeTakeFirst();
  });

  if (!doc) {
    throw new Error('Document not found');
  }

  if (doc.is_archived) {
    throw new Error('Cannot create version checkpoint for an archived document');
  }

  const env = getEnv();
  const collabPort = env.COLLAB_PORT || '3001';
  const checkpointController = new AbortController();
  const checkpointTimeout = setTimeout(() => checkpointController.abort(), 10000);

  try {
    const res = await fetch(`http://127.0.0.1:${collabPort}/internal/documents/${documentId}/checkpoint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': env.INTERNAL_SERVICE_KEY,
      },
      body: JSON.stringify({
        workspaceId,
        userId,
        trigger,
      }),
      signal: checkpointController.signal,
    });

    if (res.status === 201 || res.status === 200) {
      const body = (await res.json()) as any;
      return body.version;
    } else if (res.status === 401) {
      throw new Error('Collab server authentication failed');
    } else if (res.status === 404) {
      throw new Error('Document not found');
    } else if (res.status === 400) {
      const errBody = (await res.json().catch(() => ({}))) as any;
      throw new Error(errBody.error || 'Cannot create version checkpoint for an archived document');
    } else {
      const errBody = (await res.json().catch(() => ({}))) as any;
      throw new Error(
        `Collab server checkpoint failed with status ${res.status}${errBody.error ? ': ' + errBody.error : ''}`
      );
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('Collab server timed out during version checkpoint');
    }
    if (
      err.message.startsWith('Collab server') ||
      err.message === 'Document not found' ||
      err.message === 'Cannot create version checkpoint for an archived document'
    ) {
      throw err;
    }
    throw new Error(`Collab server is unreachable for version checkpoint: ${err.message}`);
  } finally {
    clearTimeout(checkpointTimeout);
  }
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
  // Pre-flight read-only checks: ensure document exists and is not archived (WITHOUT holding a transaction or row lock)
  const doc = await scopedDb.execute(async (db) => {
    return db
      .selectFrom('documents')
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .select(['id', 'title', 'content_text', 'parent_id', 'is_archived'])
      .executeTakeFirst();
  });

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

  // Step A: Delegate to Collab Server under unified per-document lock
  // NO DB lock or transaction is held during this internal HTTP call
  const env = getEnv();
  const collabPort = env.COLLAB_PORT || '3001';

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${collabPort}/internal/documents/${documentId}/restore`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-key': env.INTERNAL_SERVICE_KEY,
        },
        body: JSON.stringify({
          workspaceId,
          versionNumber,
          userId,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 200) {
      const body = (await res.json()) as any;
      return {
        document: body.document,
        newVersion: body.newVersion,
      };
    } else if (res.status === 401) {
      throw new Error('Collab server authentication failed');
    } else if (res.status === 403) {
      const errBody = (await res.json().catch(() => ({}))) as any;
      throw new Error(errBody.error || 'Forbidden: User does not have edit permissions on this document');
    } else if (res.status === 404) {
      throw new Error('Document or version not found');
    } else {
      const errBody = (await res.json().catch(() => ({}))) as any;
      throw new Error(errBody.error || `Collab server error: ${res.statusText}`);
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('Collab server timed out during version restore');
    }
    // Re-throw authoritative errors from collab server
    if (
      err.message.startsWith('Collab server') ||
      err.message.startsWith('Forbidden') ||
      err.message.startsWith('Document or version not found')
    ) {
      throw err;
    }
    // Fail closed: Collab server unreachable must throw, never silently proceed to room-less restore
    throw new Error(`Collab server is unreachable: ${err.message}`);
  }
}
