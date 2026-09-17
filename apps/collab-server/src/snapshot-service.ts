import * as Y from 'yjs';
import { sql } from 'kysely';
import { withSystemContext } from '@knowledge/database';
import {
  saveRecoverySnapshot,
  loadRecoverySnapshot,
  saveVersionSnapshot,
} from '@knowledge/storage';
import { StaleFencingTokenError } from '@knowledge/redis';
import { getPgBoss, QUEUE_INDEX_DOCUMENT } from '@knowledge/jobs';

export function extractSearchableText(doc: Y.Doc): string {
  const parts: string[] = [];

  for (const [, type] of doc.share.entries()) {
    if (type instanceof Y.Text) {
      const txt = type.toString().trim();
      if (txt) parts.push(txt);
    } else if (type instanceof Y.XmlFragment || type instanceof Y.XmlElement) {
      const txt = extractXmlText(type).trim();
      if (txt) parts.push(txt);
    }
  }

  return parts.join('\n') || '';
}

function extractXmlText(node: Y.XmlFragment | Y.XmlElement | Y.XmlText): string {
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
    const snapshotBytes = await loadRecoverySnapshot(documentId);
    if (snapshotBytes && snapshotBytes.length > 0) {
      Y.applyUpdate(doc, snapshotBytes);
      return true;
    }
    return false;
  } catch (err: any) {
    const isNotFound =
      err.name === 'NoSuchKey' ||
      err.name === 'NotFound' ||
      err.code === 'NoSuchKey' ||
      err.$metadata?.httpStatusCode === 404;

    if (isNotFound) {
      return false;
    }
    console.error(`[collab-server] Failed to load snapshot for document ${documentId}:`, err);
    throw err;
  }
}

export async function persistRecoverySnapshot(
  documentId: string,
  doc: Y.Doc,
  fencingToken?: number
): Promise<void> {
  const snapshotBytes = Y.encodeStateAsUpdate(doc);
  const key = await saveRecoverySnapshot(documentId, snapshotBytes, fencingToken);
  const contentText = extractSearchableText(doc);

  const updatedDoc = await withSystemContext(async (systemDb) => {
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

    return await systemDb
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
  fencingToken?: number
): Promise<void> {
  const snapshotBytes = Y.encodeStateAsUpdate(doc);
  const contentText = extractSearchableText(doc);

  const checkpointData = await withSystemContext(async (systemDb) => {
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

  const versionKey = await saveVersionSnapshot(
    documentId,
    checkpointData.nextVersion,
    snapshotBytes
  );

  await withSystemContext(async (systemDb) => {
    if (fencingToken !== undefined && fencingToken > 0) {
      const docRow = await systemDb
        .selectFrom('documents')
        .where('id', '=', documentId)
        .select(['fencing_token'])
        .forUpdate()
        .executeTakeFirst();
      if (docRow && Number(docRow.fencing_token || 0) > fencingToken) {
        throw new StaleFencingTokenError(
          `Stale checkpoint commit for ${documentId}: token ${fencingToken} < DB token ${docRow.fencing_token}`
        );
      }
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
