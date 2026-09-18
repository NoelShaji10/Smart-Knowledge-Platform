import * as Y from 'yjs';
import { sql } from 'kysely';
import { ScopedDb } from '@knowledge/database';
import { VersionTrigger } from '@knowledge/types';
import { getEnv } from '@knowledge/config';
import { withDistributedLock, StaleFencingTokenError } from '@knowledge/redis';
import {
  loadVersionSnapshot,
  saveVersionSnapshot,
  loadRecoverySnapshot,
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
  // Blocker 3: If collab server has an active room with unpersisted edits,
  // request an immediate persistence flush and explicitly validate response status!
  // Note: /flush is executed BEFORE acquiring the distributed document lock
  // to avoid deadlocking with collab server or causing premature fencing token supersession.
  const env = getEnv();
  const collabPort = env.COLLAB_PORT || '3001';
  const flushController = new AbortController();
  const flushTimeout = setTimeout(() => flushController.abort(), 2000);
  try {
    const res = await fetch(`http://127.0.0.1:${collabPort}/internal/documents/${documentId}/flush`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-key': env.INTERNAL_SERVICE_KEY,
      },
      signal: flushController.signal,
    });

    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as any;
      throw new Error(`Collab server flush failed with status ${res.status}${errBody.error ? ': ' + errBody.error : ''}`);
    }

    // body.active confirms whether an active room was flushed (true) or room was dormant (false)
    await res.json().catch(() => ({}));
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('Collab server timed out during persistence flush');
    }
    if (
      err.message.startsWith('Collab server flush failed') ||
      err.message.includes('Flush error') ||
      err.message.includes('Unauthorized internal service request')
    ) {
      throw err;
    }
    throw new Error(`Collab server is unreachable for persistence flush: ${err.message}`);
  } finally {
    clearTimeout(flushTimeout);
  }

  // Blocker 3B: Distributed locking for manual checkpoint creation
  return await withDistributedLock(`document:${documentId}`, async (lockContext) => {
    lockContext?.assertLockValid();
    const fencingToken = lockContext?.fencingToken ?? 0;

    return scopedDb.execute(async (db) => {
      lockContext?.assertLockValid();

      // 1. Validate document exists in workspace and lock row
      let docQuery = db
        .selectFrom('documents')
        .where('id', '=', documentId)
        .where('workspace_id', '=', workspaceId)
        .select(['id', 'title', 'content_text', 'is_archived', 'snapshot_key', 'fencing_token']);
      if (typeof (docQuery as any).forUpdate === 'function') {
        docQuery = (docQuery as any).forUpdate();
      }
      const doc = await docQuery.executeTakeFirst();

      if (!doc) {
        throw new Error('Document not found');
      }

      if (doc.is_archived) {
        throw new Error('Cannot create version checkpoint for an archived document');
      }

      // Check DB fencing token under row lock
      if (fencingToken > 0 && Number(doc.fencing_token || 0) > fencingToken) {
        throw new StaleFencingTokenError(
          `Stale checkpoint for ${documentId}: lock token ${fencingToken} < DB token ${doc.fencing_token}`
        );
      }

      // 2. Synchronize document fencing token in DB
      if (fencingToken > 0) {
        await db
          .updateTable('documents')
          .set({ fencing_token: fencingToken, updated_at: new Date() })
          .where('id', '=', documentId)
          .where((eb) =>
            eb.or([
              eb('fencing_token', '<=', fencingToken),
              eb('fencing_token', 'is', null),
            ])
          )
          .execute();
      }

      // 3. Atomic next version calculation under row lock
      const maxRes = await db
        .selectFrom('document_versions')
        .where('document_id', '=', documentId)
        .select(sql<string | number>`COALESCE(MAX(version_number), 0)`.as('max_ver'))
        .executeTakeFirst();

      const nextVersion = Number(maxRes?.max_ver || 0) + 1;

      // 4. Attempt to capture Yjs snapshot for this version (fail closed if storage fails)
      let snapshotBytes = await loadRecoverySnapshot(documentId);
      if (!snapshotBytes && doc.content_text) {
        const tempDoc = new Y.Doc();
        const frag = tempDoc.getXmlFragment('default');
        const p = new Y.XmlElement('p');
        p.insert(0, [new Y.XmlText(doc.content_text)]);
        frag.insert(0, [p]);
        snapshotBytes = Y.encodeStateAsUpdate(tempDoc);
      }

      let versionKey: string | null = null;
      if (snapshotBytes && snapshotBytes.length > 0) {
        versionKey = await saveVersionSnapshot(documentId, nextVersion, snapshotBytes);
      }

      lockContext?.assertLockValid();

      // 5. Insert new version row (Blocker 2: snapshot_key strictly encodes nextVersion)
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
          ...(fencingToken > 0 ? { fencing_token: fencingToken } : {}),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // 6. Update documents.snapshot_version with fencing check
      await db
        .updateTable('documents')
        .set({
          snapshot_version: nextVersion,
          ...(fencingToken > 0 ? { fencing_token: fencingToken } : {}),
          updated_at: new Date(),
        })
        .where('id', '=', documentId)
        .where('workspace_id', '=', workspaceId)
        .where((eb) => {
          if (fencingToken > 0) {
            return eb.or([
              eb('fencing_token', '<=', fencingToken),
              eb('fencing_token', 'is', null),
            ]);
          }
          return eb.val(true);
        })
        .execute();

      return versionRow;
    });
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
