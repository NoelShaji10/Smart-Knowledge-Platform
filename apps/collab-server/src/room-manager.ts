import type { WebSocket } from 'ws';
import * as Y from 'yjs';
export { Y };
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import type { WorkspaceRole, DocumentRole } from '@knowledge/types';
import { getEnv } from '@knowledge/config';
import { sql } from 'kysely';
import { withSystemContext } from '@knowledge/database';
import { loadVersionSnapshot, saveVersionSnapshot } from '@knowledge/storage';
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

export function queueRoomPersistence(room: Room): Promise<void> {
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
      if ((room.lastPersistedSeq || 0) >= targetSeq) {
        return;
      }
      return queueRoomPersistence(room);
    });
  }

  const seqToPersist = room.docSeq || 0;
  broadcastPersistence(room, PERSISTENCE_STATUS_PERSISTING, seqToPersist);

  const promise = (async () => {
    try {
      await persistRecoverySnapshot(room.documentId, room.doc);
      room.lastPersistedSeq = Math.max(room.lastPersistedSeq, seqToPersist);
      broadcastPersistence(room, PERSISTENCE_STATUS_PERSISTED, seqToPersist);
    } catch (err) {
      console.error(`[collab-server] Snapshot error for ${room.documentId}:`, err);
      const errorMsg = err instanceof Error ? err.message : 'Snapshot error';
      broadcastPersistence(room, PERSISTENCE_STATUS_ERROR, seqToPersist, errorMsg);
      throw err;
    } finally {
      room.inFlightPersistence = null;
      if (room.queuedPersistenceSeq !== null && room.queuedPersistenceSeq !== undefined) {
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

const rooms = new Map<string, Room>();
const pendingRoomInits = new Map<string, Promise<Room>>();

export async function getOrCreateRoom(documentId: string): Promise<Room> {
  let room = rooms.get(documentId);
  if (room) return room;

  let pending = pendingRoomInits.get(documentId);
  if (!pending) {
    pending = (async () => {
      try {
        const doc = new Y.Doc();
        const connections = new Set<ClientConnection>();

        // Hydrate from MinIO recovery snapshot before serving sync requests
        await loadRoomSnapshot(documentId, doc);

        const newRoom: Room = {
          documentId,
          doc,
          connections,
          debounceTimer: null,
          docSeq: 0,
          lastPersistedSeq: -1,
          inFlightPersistence: null,
          queuedPersistenceSeq: null,
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

        rooms.set(documentId, newRoom);
        return newRoom;
      } finally {
        pendingRoomInits.delete(documentId);
      }
    })();
    pendingRoomInits.set(documentId, pending);
  }

  return await pending;
}

export function addConnectionToRoom(room: Room, conn: ClientConnection): void {
  room.connections.add(conn);
  room.lastActiveUserId = conn.userId;
}

export function removeConnectionFromRoom(room: Room, conn: ClientConnection): void {
  room.connections.delete(conn);
}

export async function removeRoomIfEmpty(documentId: string, lastUserId?: string): Promise<void> {
  const room = rooms.get(documentId);
  if (!room || room.connections.size > 0 || room.isClosing) return;

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

  try {
    // 1. Persist final recovery snapshot
    await persistRecoverySnapshot(documentId, room.doc);
    // 2. Persist session-end version checkpoint
    await createVersionCheckpointOnSessionEnd(documentId, room.doc, lastUserId || room.lastActiveUserId);
  } catch (err) {
    console.error(`[collab-server] Error during room shutdown persistence for ${documentId}:`, err);
  }

  if (room.connections.size === 0) {
    if (room.unbindDocListener) {
      room.unbindDocListener();
    }
    room.doc.destroy();
    rooms.delete(documentId);
  } else {
    room.isClosing = false;
  }
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
  pendingRoomInits.clear();
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
 * Restore an active room to a historical version.
 * Applies historical state to room.doc, broadcasts updates to connected clients,
 * persists the restored state using T3 persistence sequencing, and creates a NEW version checkpoint.
 */
export async function restoreActiveRoom(
  documentId: string,
  versionNumber: number,
  userId: string,
): Promise<{ document: any; newVersion: any } | null> {
  const room = rooms.get(documentId);
  if (!room) {
    return null;
  }

  // 1. Fetch historical version row from database
  const versionRow = await withSystemContext(async (systemDb) => {
    return systemDb
      .selectFrom('document_versions')
      .where('document_id', '=', documentId)
      .where('version_number', '=', versionNumber)
      .selectAll()
      .executeTakeFirst();
  });

  if (!versionRow) {
    throw new Error('Version not found');
  }

  // 2. Load historical snapshot bytes
  const snapshotBytes = await loadVersionSnapshot(documentId, versionNumber);
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

  // 3. Apply historical state to room.doc inside a transaction
  // room.doc.on('update') will automatically broadcast MESSAGE_YJS_SYNC to all connected clients!
  room.doc.transact(() => {
    applyHistoricalDocToRoomDoc(room.doc, histDoc);
  });

  // 4. Force immediate durable persistence of restored state using existing T3 sequencing
  await flushRoomPersistence(room);

  // 5. Create NEW version checkpoint capturing restored state with trigger = 'restore'
  const restoredBytes = Y.encodeStateAsUpdate(room.doc);
  const contentText = extractSearchableText(room.doc);
  const restoredTitle = versionRow.title || 'Untitled';

  const result = await withSystemContext(async (systemDb) => {
    const maxRes = await systemDb
      .selectFrom('document_versions')
      .where('document_id', '=', documentId)
      .select(sql<string | number>`COALESCE(MAX(version_number), 0)`.as('max_ver'))
      .executeTakeFirst();

    const nextVersion = Number(maxRes?.max_ver || 0) + 1;

    // Save version snapshot for new checkpoint
    const versionKey = await saveVersionSnapshot(documentId, nextVersion, restoredBytes);

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
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const updatedDoc = await systemDb
      .updateTable('documents')
      .set({
        title: restoredTitle,
        content_text: contentText,
        snapshot_key: versionKey,
        snapshot_version: nextVersion,
        updated_at: new Date(),
      })
      .where('id', '=', documentId)
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

    return {
      document: updatedDoc,
      newVersion,
    };
  });

  return result;
}
