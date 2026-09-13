import type { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import type { WorkspaceRole, DocumentRole } from '@knowledge/types';
import { getEnv } from '@knowledge/config';
import {
  loadRoomSnapshot,
  persistRecoverySnapshot,
  createVersionCheckpointOnSessionEnd,
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
