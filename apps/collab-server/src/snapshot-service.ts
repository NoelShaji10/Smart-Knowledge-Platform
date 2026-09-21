import * as Y from 'yjs';
import { sql } from 'kysely';
import { withSystemContext } from '@knowledge/database';
import {
  saveRecoverySnapshot,
  loadRecoverySnapshot,
  loadRecoverySnapshotWithMetadata,
  loadVersionSnapshot,
  saveVersionSnapshot,
} from '@knowledge/storage';
import { withDistributedLock, LockContext, StaleFencingTokenError } from '@knowledge/redis';
import { getPgBoss, QUEUE_INDEX_DOCUMENT } from '@knowledge/jobs';

/**
 * Safely inspect and resolve the 'default' shared type on a Y.Doc without
 * accidentally creating an incompatible constructor in doc.share.
 */
export function getAuthoritativeDefaultType(doc: Y.Doc): Y.XmlFragment | Y.Text {
  const shared = doc.share.get('default');
  if (shared instanceof Y.XmlFragment) return shared;
  if (shared instanceof Y.Text) return shared;

  if (shared && (shared as any)._start) {
    const item = (shared as any)._start;
    if (
      item?.content?.type instanceof Y.XmlElement ||
      item?.content?.type instanceof Y.XmlText ||
      item?.content?.type instanceof Y.XmlFragment ||
      item?.content?.constructor?.name === 'ContentType'
    ) {
      return doc.getXmlFragment('default');
    }
    if (
      item?.content?.str !== undefined ||
      item?.content?.constructor?.name === 'ContentString' ||
      item?.content?.constructor?.name === 'ContentFormat'
    ) {
      return doc.getText('default');
    }
  }

  return doc.getXmlFragment('default');
}

export function extractSearchableText(doc: Y.Doc): string {
  const parts: string[] = [];

  // Check 'default' shared type safely without corrupting constructor binding
  try {
    const defaultType = getAuthoritativeDefaultType(doc);
    if (defaultType instanceof Y.Text) {
      const txt = defaultType.toString().trim();
      if (txt) parts.push(txt);
    } else if (defaultType instanceof Y.XmlFragment) {
      const txt = extractXmlText(defaultType).trim();
      if (txt) parts.push(txt);
    }
  } catch {}

  for (const [name, type] of doc.share.entries()) {
    if (name === 'default') continue;
    if (type instanceof Y.Text) {
      const txt = type.toString().trim();
      if (txt && !parts.includes(txt)) parts.push(txt);
    } else if (type instanceof Y.XmlFragment || type instanceof Y.XmlElement) {
      const txt = extractXmlText(type).trim();
      if (txt && !parts.includes(txt)) parts.push(txt);
    }
  }

  return parts.join('\n') || '';
}

export function extractXmlText(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    return node.toString();
  }
  let str = '';
  if (node.length > 0) {
    for (let i = 0; i < node.length; i++) {
      const child = node.get(i);
      if (child instanceof Y.XmlText) {
        str += child.toString();
      } else if (child instanceof Y.XmlElement) {
        str += extractXmlText(child) + '\n';
      }
    }
  }
  return str;
}

export async function loadRoomSnapshot(documentId: string, doc: Y.Doc): Promise<boolean> {
  try {
    // 1. PostgreSQL is treated as the authoritative source for the document's current snapshot metadata
    let docRow:
      | {
          snapshot_key: string | null;
          snapshot_version: number;
          fencing_token: string | number;
        }
      | undefined;

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId);

    if (isUuid) {
      try {
        docRow = await withSystemContext(async (systemDb) => {
          return await systemDb
            .selectFrom('documents')
            .where('id', '=', documentId)
            .select(['snapshot_key', 'snapshot_version', 'fencing_token'])
            .executeTakeFirst();
        });
      } catch (dbErr: any) {
        if (dbErr?.code !== '22P02') {
          console.error(`[collab-server] Failed to query snapshot metadata from DB for ${documentId}:`, dbErr);
          throw dbErr;
        }
      }
    }

    const dbFencingToken = docRow ? Number(docRow.fencing_token || 0) : 0;
    const dbSnapshotVersion = docRow ? Number(docRow.snapshot_version || 1) : 1;

    // 2. Load latest.yjs with its fencing metadata
    let recoveryResult = await loadRecoverySnapshotWithMetadata(documentId).catch((err: any) => {
      const isNotFound =
        err.name === 'NoSuchKey' ||
        err.name === 'NotFound' ||
        err.code === 'NoSuchKey' ||
        err.$metadata?.httpStatusCode === 404;
      if (isNotFound) return null;
      throw err;
    });

    // Support fallback in test environments without DB row where loadRecoverySnapshot was mocked
    if (!recoveryResult && !docRow) {
      const fallbackBytes = await loadRecoverySnapshot(documentId);
      if (fallbackBytes && fallbackBytes.length > 0) {
        Y.applyUpdate(doc, fallbackBytes);
        return true;
      }
    }

    // 3. Compare object fencing token against authoritative DB fencing token:
    // Invariant: PostgreSQL committed state is authoritative.
    // - If recoveryResult.fencingToken > dbFencingToken: The recovery object was written with an uncommitted or aborted fencing generation! It MUST be rejected.
    // - If recoveryResult.fencingToken < dbFencingToken: The recovery object is stale! It MUST be rejected.
    // - If recoveryResult.fencingToken === dbFencingToken: The recovery object matches the authoritative DB fencing generation.
    const isFencingMatch = docRow
      ? recoveryResult &&
        recoveryResult.fencingToken !== undefined &&
        !isNaN(recoveryResult.fencingToken) &&
        recoveryResult.fencingToken === dbFencingToken &&
        recoveryResult.data.length > 0
      : recoveryResult &&
        recoveryResult.fencingToken !== undefined &&
        !isNaN(recoveryResult.fencingToken) &&
        recoveryResult.fencingToken >= dbFencingToken &&
        recoveryResult.data.length > 0;

    if (isFencingMatch && recoveryResult) {
      Y.applyUpdate(doc, recoveryResult.data);
      return true;
    }

    if (
      recoveryResult &&
      docRow &&
      recoveryResult.fencingToken !== undefined &&
      recoveryResult.fencingToken > dbFencingToken
    ) {
      console.warn(
        `[collab-server] Rejecting uncommitted/aborted recovery snapshot for ${documentId}: recovery token ${recoveryResult.fencingToken} > authoritative DB token ${dbFencingToken}`
      );
    }

    // 4. Fallback to DB-authoritative version snapshot using snapshot_version
    if (dbSnapshotVersion > 0) {
      const versionBytes = await loadVersionSnapshot(documentId, dbSnapshotVersion).catch((err: any) => {
        const isNotFound =
          err.name === 'NoSuchKey' ||
          err.name === 'NotFound' ||
          err.code === 'NoSuchKey' ||
          err.$metadata?.httpStatusCode === 404;
        if (isNotFound) return null;
        throw err;
      });

      if (versionBytes && versionBytes.length > 0) {
        Y.applyUpdate(doc, versionBytes);
        return true;
      }
    }

    return false;
  } catch (err: any) {
    console.error(`[collab-server] Failed to load snapshot for document ${documentId}:`, err);
    throw err;
  }
}

const isLockContext = (val: any): val is LockContext =>
  val !== undefined && val !== null && typeof val === 'object' && typeof val.assertLockValid === 'function';

export async function persistRecoverySnapshot(
  documentId: string,
  doc: Y.Doc,
  fencingTokenOrLockContext?: number | LockContext,
  lockContextParam?: LockContext
): Promise<void> {
  const lockContext = isLockContext(fencingTokenOrLockContext)
    ? fencingTokenOrLockContext
    : isLockContext(lockContextParam)
    ? lockContextParam
    : undefined;

  const rawToken = typeof fencingTokenOrLockContext === 'number'
    ? fencingTokenOrLockContext
    : lockContext?.fencingToken;

  if (lockContext) {
    return await executeRecoverySnapshotPersistence(documentId, doc, lockContext.fencingToken ?? rawToken, lockContext);
  } else {
    // Standalone caller without existing lock: acquire document lock
    return await withDistributedLock(`document:${documentId}`, async (acquiredCtx) => {
      const effectiveToken = rawToken !== undefined ? rawToken : acquiredCtx?.fencingToken;
      return await executeRecoverySnapshotPersistence(documentId, doc, effectiveToken, acquiredCtx);
    });
  }
}

async function executeRecoverySnapshotPersistence(
  documentId: string,
  doc: Y.Doc,
  fencingToken?: number,
  lockContext?: LockContext
): Promise<void> {
  lockContext?.assertLockValid();
  await lockContext?.verifyOwnership();

  const snapshotBytes = Y.encodeStateAsUpdate(doc);
  const contentText = extractSearchableText(doc);

  const updatedDoc = await withSystemContext(async (systemDb) => {
    lockContext?.assertLockValid();
    await lockContext?.verifyOwnership();

    // 1. Validate DB fencing token under row lock FIRST!
    if (fencingToken !== undefined && fencingToken > 0) {
      const docRow = await systemDb
        .selectFrom('documents')
        .where('id', '=', documentId)
        .select(['fencing_token'])
        .forUpdate()
        .executeTakeFirst();
      if (docRow && Number(docRow.fencing_token || 0) > fencingToken) {
        throw new StaleFencingTokenError(
          `Stale recovery snapshot persistence for ${documentId}: token ${fencingToken} < DB token ${docRow.fencing_token}`
        );
      }
    }

    lockContext?.assertLockValid();

    // 2. Save recovery snapshot to MinIO ONLY AFTER PostgreSQL row lock validates fencing token!
    const key = await saveRecoverySnapshot(documentId, snapshotBytes, fencingToken);

    lockContext?.assertLockValid();
    await lockContext?.verifyOwnership();

    const updatedDoc = await systemDb
      .updateTable('documents')
      .set({
        snapshot_key: key,
        content_text: contentText,
        ...(fencingToken !== undefined && fencingToken > 0 ? { fencing_token: fencingToken } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', documentId)
      .where((eb) => {
        if (fencingToken !== undefined && fencingToken > 0) {
          return eb('fencing_token', '<=', fencingToken);
        }
        return eb.val(true);
      })
      .returning(['workspace_id', 'snapshot_version'])
      .executeTakeFirst();

    if (!updatedDoc) {
      throw new StaleFencingTokenError(
        `Stale recovery snapshot persistence for ${documentId}: fencing token ${fencingToken} superseded in DB`
      );
    }

    return updatedDoc;
  });

  if (updatedDoc) {
    try {
      const boss = getPgBoss();
      await boss.send(QUEUE_INDEX_DOCUMENT, {
        documentId,
        version: updatedDoc.snapshot_version,
        workspaceId: updatedDoc.workspace_id,
      });
    } catch {
      // Job queue send errors handled gracefully
    }
  }
}

export async function createVersionCheckpointOnSessionEnd(
  documentId: string,
  doc: Y.Doc,
  actorUserId?: string,
  lockContextOrToken?: LockContext | number
): Promise<void> {
  const isLockContext =
    lockContextOrToken !== undefined &&
    typeof lockContextOrToken === 'object' &&
    typeof (lockContextOrToken as any).assertLockValid === 'function';

  if (isLockContext) {
    const lockContext = lockContextOrToken as LockContext;
    return await executeSessionEndCheckpoint(documentId, doc, actorUserId, lockContext.fencingToken, lockContext);
  } else {
    const rawToken = typeof lockContextOrToken === 'number' ? lockContextOrToken : undefined;
    return await withDistributedLock(`document:${documentId}`, async (lockContext) => {
      const effectiveToken = rawToken !== undefined ? rawToken : lockContext?.fencingToken;
      return await executeSessionEndCheckpoint(documentId, doc, actorUserId, effectiveToken, lockContext);
    });
  }
}

async function executeSessionEndCheckpoint(
  documentId: string,
  doc: Y.Doc,
  actorUserId?: string,
  fencingToken?: number,
  lockContext?: LockContext
): Promise<void> {
  lockContext?.assertLockValid();
  await lockContext?.verifyOwnership();

  const snapshotBytes = Y.encodeStateAsUpdate(doc);
  const contentText = extractSearchableText(doc);

  const checkpointData = await withSystemContext(async (systemDb) => {
    lockContext?.assertLockValid();
    const docRow = await systemDb
      .selectFrom('documents')
      .where('id', '=', documentId)
      .select(['workspace_id', 'title', 'created_by', 'fencing_token'])
      .forUpdate()
      .executeTakeFirst();

    if (!docRow) return null;

    if (
      fencingToken !== undefined &&
      fencingToken > 0 &&
      Number(docRow.fencing_token || 0) > fencingToken
    ) {
      throw new StaleFencingTokenError(
        `Stale version checkpoint for ${documentId}: token ${fencingToken} < DB token ${docRow.fencing_token}`
      );
    }

    const maxRes = await systemDb
      .selectFrom('document_versions')
      .where('document_id', '=', documentId)
      .select(sql<string | number>`COALESCE(MAX(version_number), 0)`.as('max_ver'))
      .executeTakeFirst();

    const nextVersion = Number(maxRes?.max_ver || 0) + 1;

    return {
      workspaceId: docRow.workspace_id,
      title: docRow.title,
      createdBy: actorUserId || docRow.created_by,
      nextVersion,
    };
  });

  if (!checkpointData) return;

  lockContext?.assertLockValid();
  await lockContext?.verifyOwnership();

  const versionKey = await saveVersionSnapshot(
    documentId,
    checkpointData.nextVersion,
    snapshotBytes
  );

  lockContext?.assertLockValid();
  await lockContext?.verifyOwnership();

  await withSystemContext(async (systemDb) => {
    lockContext?.assertLockValid();
    let docQuery = systemDb
      .selectFrom('documents')
      .where('id', '=', documentId)
      .select(['fencing_token']);
    if (typeof (docQuery as any).forUpdate === 'function') {
      docQuery = (docQuery as any).forUpdate();
    }
    const docRow = await docQuery.executeTakeFirst();

    if (
      fencingToken !== undefined &&
      fencingToken > 0 &&
      docRow &&
      Number(docRow.fencing_token || 0) > fencingToken
    ) {
      throw new StaleFencingTokenError(
        `Stale checkpoint commit for ${documentId}: token ${fencingToken} < DB token ${docRow.fencing_token}`
      );
    }

    // Blocker 2: Verify version number allocation has not diverged under concurrent checkpoints
    const maxResCheck = await systemDb
      .selectFrom('document_versions')
      .where('document_id', '=', documentId)
      .select(sql<string | number>`COALESCE(MAX(version_number), 0)`.as('max_ver'))
      .executeTakeFirst();
    const curMax = Number(maxResCheck?.max_ver || 0);
    if (curMax + 1 !== checkpointData.nextVersion) {
      throw new Error(
        `Version divergence detected for document ${documentId}: allocated version ${checkpointData.nextVersion} but DB max version is ${curMax}`
      );
    }

    const updatedDoc = await systemDb
      .updateTable('documents')
      .set({
        snapshot_version: checkpointData.nextVersion,
        snapshot_key: versionKey,
        content_text: contentText,
        ...(fencingToken !== undefined && fencingToken > 0 ? { fencing_token: fencingToken } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', documentId)
      .where((eb) => {
        if (fencingToken !== undefined && fencingToken > 0) {
          return eb('fencing_token', '<=', fencingToken);
        }
        return eb.val(true);
      })
      .returning(['id'])
      .executeTakeFirst();

    if (!updatedDoc) {
      throw new StaleFencingTokenError(
        `Stale checkpoint commit for ${documentId}: fencing token ${fencingToken} superseded in DB`
      );
    }

    await systemDb
      .insertInto('document_versions')
      .values({
        document_id: documentId,
        version_number: checkpointData.nextVersion,
        snapshot_key: versionKey,
        title: checkpointData.title,
        content_text: contentText,
        created_by: checkpointData.createdBy,
        trigger: 'session_end',
        ...(fencingToken !== undefined && fencingToken > 0 ? { fencing_token: fencingToken } : {}),
      })
      .execute();

    await systemDb
      .insertInto('audit_events')
      .values({
        workspace_id: checkpointData.workspaceId,
        actor_id: checkpointData.createdBy,
        action: 'document.version.created',
        resource_type: 'document',
        resource_id: documentId,
        metadata: JSON.stringify({
          version_number: checkpointData.nextVersion,
          trigger: 'session_end',
        }),
        ip_address: null,
        user_agent: null,
      })
      .execute();
  });

  try {
    const boss = getPgBoss();
    await boss.send(QUEUE_INDEX_DOCUMENT, {
      documentId,
      version: checkpointData.nextVersion,
      workspaceId: checkpointData.workspaceId,
    });
  } catch {
    // Job queue send errors handled gracefully
  }
}
