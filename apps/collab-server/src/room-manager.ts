import type { WebSocket } from 'ws';
import * as Y from 'yjs';
export { Y };
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import type { WorkspaceRole, DocumentRole } from '@knowledge/types';
import { getEnv } from '@knowledge/config';
import { sql } from 'kysely';
import { withSystemContext } from '@knowledge/database';
import { withDistributedLock, LockContext, LockOptions, StaleFencingTokenError } from '@knowledge/redis';
import { loadVersionSnapshot, saveVersionSnapshot, saveRecoverySnapshot } from '@knowledge/storage';
import {
  loadRoomSnapshot,
  persistRecoverySnapshot,
  createVersionCheckpointOnSessionEnd,
  extractSearchableText,
} from './snapshot-service';

export const MESSAGE_YJS_SYNC = 0;
export const MESSAGE_PERSISTENCE = 2;

export const PERSISTENCE_STATUS_PERSISTED = 0;
export const PERSISTENCE_STATUS_PERSISTING = 1;
export const PERSISTENCE_STATUS_ERROR = 2;

export interface ClientConnection {
  id: string;
  ws: WebSocket;
  userId: string;
  workspaceId: string;
  documentId: string;
  canEdit: boolean;
  effectiveRole: WorkspaceRole | DocumentRole;
}

export interface Room {
  documentId: string;
  doc: Y.Doc;
  connections: Set<ClientConnection>;
  unbindDocListener?: () => void;
  debounceTimer?: NodeJS.Timeout | null;
  lastActiveUserId?: string;
  isClosing?: boolean;
  docSeq: number;
  lastPersistedSeq: number;
  inFlightPersistence: Promise<void> | null;
  queuedPersistenceSeq: number | null;
  fencingToken?: number;
}

export function broadcastPersistence(
  room: Room,
  status: number,
  seq: number,
  errorMsg?: string
): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_PERSISTENCE);
  encoding.writeVarUint(encoder, status);
  encoding.writeVarUint(encoder, seq);
  if (status === PERSISTENCE_STATUS_ERROR && errorMsg) {
    encoding.writeVarString(encoder, errorMsg);
  }
  const message = encoding.toUint8Array(encoder);

  for (const conn of room.connections) {
    if (conn.ws.readyState === 1 /* WebSocket.OPEN */) {
      try {
        conn.ws.send(message, { binary: true });
      } catch {
        // Socket write errors handled by close listeners
      }
    }
  }
}

export function sendPersistence(
  conn: ClientConnection,
  status: number,
  seq: number,
  errorMsg?: string
): void {
  if (conn.ws.readyState === 1 /* WebSocket.OPEN */) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_PERSISTENCE);
    encoding.writeVarUint(encoder, status);
    encoding.writeVarUint(encoder, seq);
    if (status === PERSISTENCE_STATUS_ERROR && errorMsg) {
      encoding.writeVarString(encoder, errorMsg);
    }
    try {
      conn.ws.send(encoding.toUint8Array(encoder), { binary: true });
    } catch {
      // Socket write errors handled by close listeners
    }
  }
}

const rooms = new Map<string, Room>();

/**
 * Evict a room immediately on fencing supersession or fatal lock loss:
 * 1. Mark the room as closing.
 * 2. Stop/disable further persistence from that room.
 * 3. Close connected clients with WebSocket code 4009 and reason 'Document superseded'.
 * 4. Destroy the Yjs document.
 * 5. Remove the room from the rooms map.
 * Does NOT trigger any further persistence writes.
 */
export function evictRoom(room: Room, reason = 'Document superseded'): void {
  if (room.isClosing) return;
  room.isClosing = true;

  // 1. Cancel pending debounce timer
  if (room.debounceTimer) {
    clearTimeout(room.debounceTimer);
    room.debounceTimer = null;
  }

  // 2. Unbind doc listener so updates cannot trigger persistence
  if (room.unbindDocListener) {
    room.unbindDocListener();
    room.unbindDocListener = undefined;
  }

  // 3. Close all client WebSockets with code 4009
  for (const conn of room.connections) {
    if (conn.ws.readyState === 1 /* WebSocket.OPEN */) {
      try {
        conn.ws.close(4009, reason);
      } catch {
        // Safe socket error handling
      }
    }
  }
  room.connections.clear();

  // 4. Cancel any queued persistence
  room.queuedPersistenceSeq = null;

  // 5. Destroy Yjs document
  try {
    room.doc.destroy();
  } catch {
    // Safe destruction handling
  }

  // 6. Evict from rooms Map
  rooms.delete(room.documentId);
}

export function queueRoomPersistence(room: Room): Promise<void> {
  if (room.isClosing) {
    return Promise.resolve();
  }

  if (room.debounceTimer) {
    clearTimeout(room.debounceTimer);
    room.debounceTimer = null;
  }

  const targetSeq = room.docSeq || 0;

  // If already persisted up to or past targetSeq, and no in-flight persistence:
  if (room.lastPersistedSeq >= targetSeq && !room.inFlightPersistence) {
    broadcastPersistence(room, PERSISTENCE_STATUS_PERSISTED, targetSeq);
    return Promise.resolve();
  }

  // If another persistence operation is currently in-flight, serialize!
  if (room.inFlightPersistence) {
    room.queuedPersistenceSeq = Math.max(room.queuedPersistenceSeq || 0, targetSeq);
    return room.inFlightPersistence.then(() => {
      if ((room.lastPersistedSeq || 0) >= targetSeq || room.isClosing) {
        return;
      }
      return queueRoomPersistence(room);
    });
  }

  const seqToPersist = room.docSeq || 0;
  broadcastPersistence(room, PERSISTENCE_STATUS_PERSISTING, seqToPersist);

  const promise = (async () => {
    try {
      await persistRecoverySnapshot(room.documentId, room.doc, room.fencingToken);
      room.lastPersistedSeq = Math.max(room.lastPersistedSeq, seqToPersist);
      broadcastPersistence(room, PERSISTENCE_STATUS_PERSISTED, seqToPersist);
    } catch (err: any) {
      console.error(`[collab-server] Snapshot error for ${room.documentId}:`, err);
      const errorMsg = err instanceof Error ? err.message : 'Snapshot error';
      broadcastPersistence(room, PERSISTENCE_STATUS_ERROR, seqToPersist, errorMsg);

      // Blocker 3: If snapshot persistence fails with StaleFencingTokenError or LockLostError:
      // Immediately evict the room, close WebSockets with code 4009, destroy doc, and remove from rooms!
      if (
        err instanceof StaleFencingTokenError ||
        err?.name === 'StaleFencingTokenError' ||
        err?.name === 'LockLostError'
      ) {
        evictRoom(room, 'Document superseded');
      }
      throw err;
    } finally {
      room.inFlightPersistence = null;
      if (room.isClosing) {
        room.queuedPersistenceSeq = null;
      } else if (room.queuedPersistenceSeq !== null && room.queuedPersistenceSeq !== undefined) {
        const nextSeq = room.queuedPersistenceSeq;
        room.queuedPersistenceSeq = null;
        if (nextSeq > room.lastPersistedSeq) {
          queueRoomPersistence(room).catch(() => {
            // Already broadcast and logged
          });
        }
      }
    }
  })();

  room.inFlightPersistence = promise;
  return promise;
}

export async function flushRoomPersistence(room: Room): Promise<void> {
  return queueRoomPersistence(room);
}

export async function withDocumentLock<T>(
  documentId: string,
  fn: (lockContext?: LockContext) => Promise<T>,
  options?: LockOptions
): Promise<T> {
  return await withDistributedLock(`document:${documentId}`, fn, options);
}

export async function getOrCreateRoom(documentId: string): Promise<Room> {
  return await withDocumentLock(documentId, async (lockContext) => {
    let room = rooms.get(documentId);
    if (room) return room;

    lockContext?.assertLockValid();
    const doc = new Y.Doc();
    const connections = new Set<ClientConnection>();

    // Hydrate from MinIO recovery snapshot before serving sync requests
    await loadRoomSnapshot(documentId, doc);
    lockContext?.assertLockValid();

    const newRoom: Room = {
      documentId,
      doc,
      connections,
      debounceTimer: null,
      docSeq: 0,
      lastPersistedSeq: -1,
      inFlightPersistence: null,
      queuedPersistenceSeq: null,
      fencingToken: lockContext?.fencingToken,
    };

    const onDocUpdate = (update: Uint8Array, origin: unknown) => {
      newRoom.docSeq = (newRoom.docSeq || 0) + 1;

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_YJS_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);

      for (const conn of connections) {
        if (conn !== origin && conn.ws.readyState === 1 /* WebSocket.OPEN */) {
          try {
            conn.ws.send(message, { binary: true });
          } catch {
            // Socket write errors handled by close listeners
          }
        }
      }

      // Schedule debounced recovery snapshot
      if (newRoom.debounceTimer) {
        clearTimeout(newRoom.debounceTimer);
      }
      const env = getEnv();
      const debounceMs = env.SNAPSHOT_DEBOUNCE_MS || 2000;
      newRoom.debounceTimer = setTimeout(() => {
        newRoom.debounceTimer = null;
        queueRoomPersistence(newRoom).catch(() => {
          // Error already broadcast and logged
        });
      }, debounceMs);
    };

    doc.on('update', onDocUpdate);

    newRoom.unbindDocListener = () => {
      doc.off('update', onDocUpdate);
    };

    lockContext?.assertLockValid();
    rooms.set(documentId, newRoom);
    return newRoom;
  });
}

export function addConnectionToRoom(room: Room, conn: ClientConnection): void {
  room.connections.add(conn);
  room.lastActiveUserId = conn.userId;
}

export function removeConnectionFromRoom(room: Room, conn: ClientConnection): void {
  room.connections.delete(conn);
}

export async function removeRoomIfEmpty(documentId: string, lastUserId?: string): Promise<void> {
  return await withDocumentLock(documentId, async (lockContext) => {
    const room = rooms.get(documentId);
    if (!room || room.connections.size > 0 || room.isClosing) return;

    lockContext?.assertLockValid();
    room.isClosing = true;

    if (room.debounceTimer) {
      clearTimeout(room.debounceTimer);
      room.debounceTimer = null;
    }

    if (room.inFlightPersistence) {
      try {
        await room.inFlightPersistence;
      } catch {
        // Ignored during shutdown
      }
    }

    lockContext?.assertLockValid();

    try {
      // 1. Persist final recovery snapshot
      await persistRecoverySnapshot(documentId, room.doc, lockContext?.fencingToken);
      lockContext?.assertLockValid();
      // 2. Persist session-end version checkpoint
      await createVersionCheckpointOnSessionEnd(
        documentId,
        room.doc,
        lastUserId || room.lastActiveUserId,
        lockContext?.fencingToken
      );
    } catch (err) {
      console.error(`[collab-server] Error during room shutdown persistence for ${documentId}:`, err);
    }

    lockContext?.assertLockValid();

    if (room.connections.size === 0) {
      if (room.unbindDocListener) {
        room.unbindDocListener();
      }
      room.doc.destroy();
      rooms.delete(documentId);
    } else {
      room.isClosing = false;
    }
  });
}

export function getRoom(documentId: string): Room | undefined {
  return rooms.get(documentId);
}

export function getRoomCount(): number {
  return rooms.size;
}

export function clearAllRooms(): void {
  for (const room of rooms.values()) {
    if (room.debounceTimer) {
      clearTimeout(room.debounceTimer);
    }
    if (room.unbindDocListener) {
      room.unbindDocListener();
    }
    room.inFlightPersistence = null;
    room.queuedPersistenceSeq = null;
    room.doc.destroy();
  }
  rooms.clear();
}

/**
 * Apply historical Y.Doc state onto an active target Y.Doc inside an atomic transaction.
 * Clones shared types (XmlFragment, Text, Array, Map) into targetDoc so Yjs emits standard CRDT delta updates.
 */
export function applyHistoricalDocToRoomDoc(targetDoc: Y.Doc, sourceDoc: Y.Doc): void {
  // 1. Primary Tiptap document fragment ('default')
  const targetFrag = targetDoc.getXmlFragment('default');
  const sourceFrag = sourceDoc.getXmlFragment('default');

  targetFrag.delete(0, targetFrag.length);
  const clonedChildren: (Y.XmlElement | Y.XmlText)[] = [];
  for (let i = 0; i < sourceFrag.length; i++) {
    const child = sourceFrag.get(i);
    clonedChildren.push(child.clone());
  }
  if (clonedChildren.length > 0) {
    targetFrag.insert(0, clonedChildren);
  }

  // 2. Handle any additional shared types
  const otherNames = new Set<string>();
  for (const name of targetDoc.share.keys()) {
    if (name !== 'default') otherNames.add(name);
  }
  for (const name of sourceDoc.share.keys()) {
    if (name !== 'default') otherNames.add(name);
  }

  for (const name of otherNames) {
    const targetType = targetDoc.share.get(name);
    if (targetType instanceof Y.Text) {
      const s = sourceDoc.getText(name);
      targetType.delete(0, targetType.length);
      const str = s.toString();
      if (str.length > 0) {
        targetType.insert(0, str);
      }
    } else if (targetType instanceof Y.Array) {
      const s = sourceDoc.getArray(name);
      targetType.delete(0, targetType.length);
      const items: any[] = [];
      for (let i = 0; i < s.length; i++) {
        const item = s.get(i) as any;
        items.push(typeof item?.clone === 'function' ? item.clone() : item);
      }
      if (items.length > 0) {
        targetType.insert(0, items);
      }
    } else if (targetType instanceof Y.Map) {
      const s = sourceDoc.getMap(name);
      for (const k of targetType.keys()) {
        targetType.delete(k);
      }
      for (const [k, v] of s.entries()) {
        const val = v as any;
        targetType.set(k, typeof val?.clone === 'function' ? val.clone() : val);
      }
    } else if (targetType instanceof Y.XmlFragment) {
      const s = sourceDoc.getXmlFragment(name);
      targetType.delete(0, targetType.length);
      const children: (Y.XmlElement | Y.XmlText)[] = [];
      for (let i = 0; i < s.length; i++) {
        children.push(s.get(i).clone());
      }
      if (children.length > 0) {
        targetType.insert(0, children);
      }
    }
  }
}

/**
 * Restore a document to a historical version.
 * Unified under withDocumentLock:
 * - If room is active in memory: mutates room.doc, broadcasts sync updates to connected clients,
 *   flushes persistence via T3 pipeline, and records the new checkpoint.
 * - If room is not active: updates MinIO recovery snapshot (so any future/waiting getOrCreateRoom hydrates
 *   the restored state), updates PostgreSQL, and records the new checkpoint.
 * Any client attempting to create/hydrate the room during restore is blocked on withDocumentLock until
 * restore finishes, guaranteeing that stale state is never hydrated.
 */
export async function restoreDocument(
  documentId: string,
  versionNumber: number,
  userId: string,
  options?: LockOptions
): Promise<{ document: any; newVersion: any }> {
  return await withDocumentLock(documentId, async (lockContext) => {
    lockContext?.assertLockValid();
    const fencingToken = lockContext?.fencingToken ?? 0;

    // 1. Fetch historical version row from database
    const versionRow = await withSystemContext(async (systemDb) => {
      lockContext?.assertLockValid();
      return systemDb
        .selectFrom('document_versions')
        .where('document_id', '=', documentId)
        .where('version_number', '=', versionNumber)
        .selectAll()
        .executeTakeFirst();
    });

    lockContext?.assertLockValid();

    if (!versionRow) {
      throw new Error('Version not found');
    }

    // 2. Load historical snapshot bytes
    const snapshotBytes = await loadVersionSnapshot(documentId, versionNumber);
    lockContext?.assertLockValid();

    const histDoc = new Y.Doc();

    if (snapshotBytes && snapshotBytes.length > 0) {
      try {
        Y.applyUpdate(histDoc, snapshotBytes);
      } catch (err) {
        console.error(`[collab-server] Corrupt version snapshot for doc ${documentId} v${versionNumber}:`, err);
        throw new Error('Historical version snapshot is corrupt or invalid');
      }
    } else if (versionRow.content_text !== null && versionRow.content_text !== undefined) {
      // Fallback for legacy checkpoints created before full snapshot storage
      const frag = histDoc.getXmlFragment('default');
      const p = new Y.XmlElement('p');
      p.insert(0, [new Y.XmlText(versionRow.content_text)]);
      frag.insert(0, [p]);
    }

    const restoredBytes = Y.encodeStateAsUpdate(histDoc);
    const restoredTitle = versionRow.title || 'Untitled';
    const contentText = extractSearchableText(histDoc);

    const room = rooms.get(documentId);

    if (room) {
      // CASE 1: ACTIVE ROOM RESTORE
      try {
        lockContext?.assertLockValid();

        // Check fencing token against in-memory room
        if (fencingToken > 0 && room.fencingToken !== undefined && room.fencingToken > fencingToken) {
          throw new StaleFencingTokenError(
            `Stale active room restore for ${documentId}: token ${fencingToken} < room token ${room.fencingToken}`
          );
        }

        // Verify lock ownership before committing checkpoint to DB
        await lockContext?.verifyOwnership();
        lockContext?.assertLockValid();

        // 4 & 5. Perform PostgreSQL fencing validation & commit the restored document/version state FIRST!
        const dbResult = await withSystemContext(async (systemDb) => {
          lockContext?.assertLockValid();

          // 1. Validate DB fencing token under row lock
          let docQuery = systemDb
            .selectFrom('documents')
            .where('id', '=', documentId)
            .select(['workspace_id', 'fencing_token']);
          if (typeof (docQuery as any).forUpdate === 'function') {
            docQuery = (docQuery as any).forUpdate();
          }
          const docRow = await docQuery.executeTakeFirstOrThrow();

          if (fencingToken > 0 && Number(docRow.fencing_token || 0) > fencingToken) {
            throw new StaleFencingTokenError(
              `Stale active room restore commit for ${documentId}: token ${fencingToken} < DB token ${docRow.fencing_token}`
            );
          }

          const maxRes = await systemDb
            .selectFrom('document_versions')
            .where('document_id', '=', documentId)
            .select(sql<string | number>`COALESCE(MAX(version_number), 0)`.as('max_ver'))
            .executeTakeFirst();

          lockContext?.assertLockValid();
          const nextVersion = Number(maxRes?.max_ver || 0) + 1;

          // Save version snapshot for new checkpoint (fail closed if storage fails)
          const versionKey = await saveVersionSnapshot(documentId, nextVersion, restoredBytes);
          lockContext?.assertLockValid();

          // Save recovery snapshot with fencing token
          const recoveryKey = await saveRecoverySnapshot(documentId, restoredBytes, fencingToken);
          lockContext?.assertLockValid();

          const newVersion = await systemDb
            .insertInto('document_versions')
            .values({
              document_id: documentId,
              version_number: nextVersion,
              snapshot_key: versionKey,
              title: restoredTitle,
              content_text: contentText,
              created_by: userId,
              trigger: 'restore',
              ...(fencingToken > 0 ? { fencing_token: fencingToken } : {}),
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          const updatedDoc = await systemDb
            .updateTable('documents')
            .set({
              title: restoredTitle,
              content_text: contentText,
              snapshot_key: recoveryKey || versionKey,
              snapshot_version: nextVersion,
              ...(fencingToken > 0 ? { fencing_token: fencingToken } : {}),
              updated_at: new Date(),
            })
            .where('id', '=', documentId)
            .where((eb) => {
              if (fencingToken > 0) {
                return eb('fencing_token', '<=', fencingToken);
              }
              return eb.val(true);
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          await systemDb
            .insertInto('audit_events')
            .values({
              workspace_id: updatedDoc.workspace_id,
              actor_id: userId,
              action: 'document.version.restored',
              resource_type: 'document',
              resource_id: documentId,
              metadata: JSON.stringify({
                restoredVersionNumber: versionNumber,
                newVersionNumber: nextVersion,
              }),
              ip_address: null,
              user_agent: null,
            })
            .execute();

          lockContext?.assertLockValid();

          return {
            document: updatedDoc,
            newVersion,
          };
        });

        // 6. Only AFTER the DB transaction succeeds:
        // Update room fencing token
        room.fencingToken = fencingToken;

        // Apply historical state to room.doc inside a transaction
        // room.doc.on('update') will automatically broadcast MESSAGE_YJS_SYNC to all connected clients!
        room.doc.transact(() => {
          applyHistoricalDocToRoomDoc(room.doc, histDoc);
        });

        if (room.debounceTimer) {
          clearTimeout(room.debounceTimer);
          room.debounceTimer = null;
        }
        room.lastPersistedSeq = room.docSeq || 0;
        broadcastPersistence(room, PERSISTENCE_STATUS_PERSISTED, room.lastPersistedSeq);

        return dbResult;
      } catch (err: any) {
        // Failure handling:
        // If the active-room restore fails because of StaleFencingTokenError or LockLostError:
        // immediately evict the affected room!
        if (
          err instanceof StaleFencingTokenError ||
          err?.name === 'StaleFencingTokenError' ||
          err?.name === 'LockLostError'
        ) {
          evictRoom(room, 'Document superseded');
        }
        throw err;
      }
    } else {
      // CASE 2: ROOM-LESS RESTORE (under the exact same document lock)
      lockContext?.assertLockValid();

      // 1. Persist restored state to MinIO recovery snapshot (latest.yjs) with fencing token validation
      const recoveryKey = await saveRecoverySnapshot(documentId, restoredBytes, fencingToken);
      lockContext?.assertLockValid();

      // 2. Verify lock ownership before committing checkpoint to DB
      await lockContext?.verifyOwnership();
      lockContext?.assertLockValid();

      return await withSystemContext(async (systemDb) => {
        lockContext?.assertLockValid();

        // 1. Validate DB fencing token under row lock
        let docQuery = systemDb
          .selectFrom('documents')
          .where('id', '=', documentId)
          .select(['workspace_id', 'fencing_token']);
        if (typeof (docQuery as any).forUpdate === 'function') {
          docQuery = (docQuery as any).forUpdate();
        }
        const docRow = await docQuery.executeTakeFirstOrThrow();

        if (fencingToken > 0 && Number(docRow.fencing_token || 0) > fencingToken) {
          throw new StaleFencingTokenError(
            `Stale room-less restore commit for ${documentId}: token ${fencingToken} < DB token ${docRow.fencing_token}`
          );
        }

        const maxRes = await systemDb
          .selectFrom('document_versions')
          .where('document_id', '=', documentId)
          .select(sql<string | number>`COALESCE(MAX(version_number), 0)`.as('max_ver'))
          .executeTakeFirst();

        lockContext?.assertLockValid();
        const nextVersion = Number(maxRes?.max_ver || 0) + 1;

        // Save version snapshot for new checkpoint (fail closed if storage fails)
        const versionKey = await saveVersionSnapshot(documentId, nextVersion, restoredBytes);
        lockContext?.assertLockValid();

        const updatedDoc = await systemDb
          .updateTable('documents')
          .set({
            title: restoredTitle,
            content_text: contentText,
            snapshot_key: recoveryKey || versionKey,
            snapshot_version: nextVersion,
            ...(fencingToken > 0 ? { fencing_token: fencingToken } : {}),
            updated_at: new Date(),
          })
          .where('id', '=', documentId)
          .where((eb) => {
            if (fencingToken > 0) {
              return eb('fencing_token', '<=', fencingToken);
            }
            return eb.val(true);
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        const newVersion = await systemDb
          .insertInto('document_versions')
          .values({
            document_id: documentId,
            version_number: nextVersion,
            snapshot_key: versionKey,
            title: restoredTitle,
            content_text: contentText,
            created_by: userId,
            trigger: 'restore',
            ...(fencingToken > 0 ? { fencing_token: fencingToken } : {}),
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await systemDb
          .insertInto('audit_events')
          .values({
            workspace_id: updatedDoc.workspace_id,
            actor_id: userId,
            action: 'document.version.restored',
            resource_type: 'document',
            resource_id: documentId,
            metadata: JSON.stringify({
              restoredVersionNumber: versionNumber,
              newVersionNumber: nextVersion,
            }),
            ip_address: null,
            user_agent: null,
          })
          .execute();

        lockContext?.assertLockValid();

        return {
          document: updatedDoc,
          newVersion,
        };
      });
    }
  }, options);
}

export const restoreActiveRoom = restoreDocument;
