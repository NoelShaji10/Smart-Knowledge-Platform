import type { WebSocket } from 'ws';
import * as Y from 'yjs';
export { Y };
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import type { WorkspaceRole, DocumentRole, VersionTrigger } from '@knowledge/types';
import { getEnv } from '@knowledge/config';
import { sql } from 'kysely';
import { withSystemContext } from '@knowledge/database';
import { withDistributedLock, LockContext, LockOptions, StaleFencingTokenError, LockLostError } from '@knowledge/redis';
import { loadVersionSnapshot, saveVersionSnapshot, saveRecoverySnapshot, loadRecoverySnapshot } from '@knowledge/storage';
import { getPgBoss, QUEUE_INDEX_DOCUMENT } from '@knowledge/jobs';
import {
  loadRoomSnapshot,
  persistRecoverySnapshot,
  createVersionCheckpointOnSessionEnd,
  extractSearchableText,
  extractXmlText,
  getAuthoritativeDefaultType,
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
  isRestoring?: boolean;
  persistenceGeneration?: number;
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
  const seqToken = room.fencingToken;
  const persistenceGen = room.persistenceGeneration || 0;
  broadcastPersistence(room, PERSISTENCE_STATUS_PERSISTING, seqToPersist);

  const promise = (async () => {
    try {
      await withDocumentLock(room.documentId, async (lockContext) => {
        lockContext?.assertLockValid();
        await lockContext?.verifyOwnership();

        // 1. Update room fencing token if lock provided a valid fencing token
        if (lockContext?.fencingToken && lockContext.fencingToken > 0) {
          room.fencingToken = lockContext.fencingToken;
        }

        // 2. Pre-mutation checks under lock:
        if (room.isClosing || rooms.get(room.documentId) !== room) {
          return;
        }

        if (room.persistenceGeneration !== undefined && room.persistenceGeneration > persistenceGen) {
          return;
        }

        // Check if already persisted up to or past seqToPersist
        // (e.g. manual checkpoint or restore ran while we were waiting for the lock!)
        if (room.lastPersistedSeq >= seqToPersist) {
          broadcastPersistence(room, PERSISTENCE_STATUS_PERSISTED, room.lastPersistedSeq);
          return;
        }

        // 3. Persist recovery snapshot passing our acquired lockContext
        await persistRecoverySnapshot(room.documentId, room.doc, lockContext);

        lockContext?.assertLockValid();
        await lockContext?.verifyOwnership();

        room.lastPersistedSeq = Math.max(room.lastPersistedSeq, seqToPersist);
        broadcastPersistence(room, PERSISTENCE_STATUS_PERSISTED, seqToPersist);
      });
    } catch (err: any) {
      console.error(`[collab-server] Snapshot error for ${room.documentId}:`, err);
      const errorMsg = err instanceof Error ? err.message : 'Snapshot error';
      broadcastPersistence(room, PERSISTENCE_STATUS_ERROR, seqToPersist, errorMsg);

      // Blocker 3 & Finding 4: Handle snapshot persistence failures
      const isStaleToken =
        err instanceof StaleFencingTokenError || err?.name === 'StaleFencingTokenError';
      const isLockLost = err instanceof LockLostError || err?.name === 'LockLostError';

      if (isStaleToken || isLockLost) {
        // Only suppress room eviction for StaleFencingTokenError if the room itself advanced its generation/token
        // (i.e. restore superseded pre-restore background persistence).
        // LockLostError MUST ALWAYS evict the room!
        const isPreRestoreSuperseded =
          isStaleToken &&
          !isLockLost &&
          (room.isRestoring ||
            (room.persistenceGeneration !== undefined && room.persistenceGeneration > persistenceGen) ||
            (room.fencingToken !== undefined && room.fencingToken > (seqToken || 0)));

        if (isPreRestoreSuperseded) {
          console.info(
            `[collab-server] Pre-restore persistence for ${room.documentId} superseded gracefully without room eviction.`
          );
        } else {
          evictRoom(room, 'Document superseded');
        }
      }
      throw err;
    } finally {
      room.inFlightPersistence = null;
      if (room.isClosing || room.isRestoring) {
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

/**
 * Synchronize the document's fencing token in PostgreSQL immediately upon distributed lock acquisition.
 * Guarantees PostgreSQL's fencing generation reflects the newer generation as soon as Redis grants the lease,
 * ensuring any stale lock owner's subsequent database queries/mutations are immediately rejected.
 */
export async function syncDocumentFencingToken(
  documentId: string,
  fencingToken: number
): Promise<void> {
  if (!fencingToken || fencingToken <= 0) return;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId);
  if (!isUuid) return;

  try {
    await withSystemContext(async (systemDb) => {
      if (!systemDb || typeof systemDb.updateTable !== 'function') return;

      let query: any = systemDb
        .updateTable('documents')
        .set({
          fencing_token: fencingToken,
          updated_at: new Date(),
        });

      if (typeof query?.where === 'function') {
        query = query.where((eb: any) => {
          if (typeof eb?.and === 'function') {
            return eb.and([
              eb('id', '=', documentId),
              eb.or([
                eb('fencing_token', '<', fencingToken),
                eb('fencing_token', 'is', null),
              ]),
            ]);
          }
          return eb('id', '=', documentId);
        });
      }

      if (typeof query?.execute === 'function') {
        await query.execute();
      }
    });
  } catch (err: any) {
    if (err && typeof err === 'object' && err.message && !err.message.includes('updateTable is not a function')) {
      console.error(`[collab-server] Failed to sync fencing token for document ${documentId}:`, err);
      throw err;
    }
  }
}

export async function withDocumentLock<T>(
  documentId: string,
  fn: (lockContext?: LockContext) => Promise<T>,
  options?: LockOptions
): Promise<T> {
  return await withDistributedLock(
    `document:${documentId}`,
    async (lockContext) => {
      if (lockContext?.fencingToken && lockContext.fencingToken > 0) {
        await syncDocumentFencingToken(documentId, lockContext.fencingToken);
      }
      return await fn(lockContext);
    },
    options
  );
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
  // Await any in-flight persistence before acquiring document lock to prevent distributed deadlocks
  const preRoom = rooms.get(documentId);
  if (preRoom?.inFlightPersistence) {
    try {
      await preRoom.inFlightPersistence;
    } catch {
      // Ignored during shutdown
    }
  }

  return await withDocumentLock(documentId, async (lockContext) => {
    const room = rooms.get(documentId);
    if (!room || room.connections.size > 0 || room.isClosing) return;

    lockContext?.assertLockValid();
    room.isClosing = true;

    if (room.debounceTimer) {
      clearTimeout(room.debounceTimer);
      room.debounceTimer = null;
    }

    lockContext?.assertLockValid();

    try {
      // 1. Persist final recovery snapshot
      await persistRecoverySnapshot(documentId, room.doc, lockContext);
      lockContext?.assertLockValid();
      // 2. Persist session-end version checkpoint
      await createVersionCheckpointOnSessionEnd(
        documentId,
        room.doc,
        lastUserId || room.lastActiveUserId,
        lockContext
      );
    } catch (err) {
      console.error(`[collab-server] Error during room shutdown persistence for ${documentId}:`, err);
      if (room.connections.size === 0) {
        if (room.unbindDocListener) {
          room.unbindDocListener();
          room.unbindDocListener = undefined;
        }
        try {
          room.doc.destroy();
        } catch {}
        rooms.delete(documentId);
      } else {
        room.isClosing = false;
      }
      throw err;
    }

    lockContext?.assertLockValid();

    if (room.connections.size === 0) {
      if (room.unbindDocListener) {
        room.unbindDocListener();
        room.unbindDocListener = undefined;
      }
      try {
        room.doc.destroy();
      } catch {}
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

function cloneXmlNode(node: any): Y.XmlElement | Y.XmlText {
  if (node instanceof Y.XmlText || node?.constructor?.name === 'XmlText' || node?.nodeName === undefined) {
    const cloned = new Y.XmlText();
    if (typeof node.toDelta === 'function') {
      const delta = node.toDelta();
      if (Array.isArray(delta) && delta.length > 0) {
        cloned.applyDelta(delta);
      }
    } else {
      const str = typeof node.toString === 'function' ? node.toString() : String(node ?? '');
      if (str.length > 0) {
        cloned.insert(0, str);
      }
    }
    return cloned;
  }
  const el = new Y.XmlElement(node.nodeName);
  const attrs = typeof node.getAttributes === 'function' ? node.getAttributes() : {};
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v as string);
  }
  const children: (Y.XmlElement | Y.XmlText)[] = [];
  const childNodes: any[] = typeof node.toArray === 'function'
    ? node.toArray()
    : (typeof node.length === 'number' ? Array.from({ length: node.length }, (_, i) => node.get(i)) : []);
  for (const child of childNodes) {
    children.push(cloneXmlNode(child));
  }
  if (children.length > 0) {
    el.insert(0, children);
  }
  return el;
}

/**
 * Apply historical Y.Doc state onto an active target Y.Doc inside an atomic transaction.
 * Clones shared types (XmlFragment, Text, Array, Map) into targetDoc so Yjs emits standard CRDT delta updates.
 */
export function applyHistoricalDocToRoomDoc(targetDoc: Y.Doc, sourceDoc: Y.Doc): void {
  // 1. Primary document fragment or text ('default')
  const targetDef = getAuthoritativeDefaultType(targetDoc);
  const sourceDef = getAuthoritativeDefaultType(sourceDoc);

  if (targetDef instanceof Y.XmlFragment && sourceDef instanceof Y.Text) {
    // Target is rich text XmlFragment, source is plain Text: wrap in <p><text></p>
    const targetFrag = targetDoc.getXmlFragment('default');
    targetFrag.delete(0, targetFrag.length);
    const p = new Y.XmlElement('p');
    const text = new Y.XmlText();
    if (typeof sourceDef.toDelta === 'function') {
      const delta = sourceDef.toDelta();
      if (Array.isArray(delta) && delta.length > 0) {
        text.applyDelta(delta);
      }
    } else {
      const str = sourceDef.toString();
      if (str.length > 0) text.insert(0, str);
    }
    p.insert(0, [text]);
    targetFrag.insert(0, [p]);
  } else if (targetDef instanceof Y.Text && sourceDef instanceof Y.XmlFragment) {
    // Target is plain Text, source is rich text XmlFragment
    const targetText = targetDoc.getText('default');
    targetText.delete(0, targetText.length);
    targetText.insert(0, extractXmlText(sourceDef));
  } else if (sourceDef instanceof Y.Text) {
    const targetText = targetDoc.getText('default');
    targetText.delete(0, targetText.length);
    if (typeof sourceDef.toDelta === 'function') {
      const delta = sourceDef.toDelta();
      if (Array.isArray(delta) && delta.length > 0) {
        targetText.applyDelta(delta);
      }
    } else {
      const str = sourceDef.toString();
      if (str.length > 0) {
        targetText.insert(0, str);
      }
    }
  } else {
    const targetFrag = targetDoc.getXmlFragment('default');
    const sourceFrag = sourceDoc.getXmlFragment('default');

    targetFrag.delete(0, targetFrag.length);
    const clonedChildren: (Y.XmlElement | Y.XmlText)[] = [];
    for (let i = 0; i < sourceFrag.length; i++) {
      const child = sourceFrag.get(i) as any;
      clonedChildren.push(cloneXmlNode(child));
    }
    if (clonedChildren.length > 0) {
      targetFrag.insert(0, clonedChildren);
    }
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
      if (typeof s.toDelta === 'function') {
        const delta = s.toDelta();
        if (Array.isArray(delta) && delta.length > 0) {
          targetType.applyDelta(delta);
        }
      } else {
        const str = s.toString();
        if (str.length > 0) {
          targetType.insert(0, str);
        }
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
      const children: any[] = [];
      for (let i = 0; i < s.length; i++) {
        const child = s.get(i) as any;
        children.push(cloneXmlNode(child));
      }
      if (children.length > 0) {
        targetType.insert(0, children);
      }
    }
  }
}

export interface RestoreDocumentOptions extends LockOptions {
  /**
   * Optional controlled test hook invoked after loading historical snapshot and prior to
   * entering the protected mutation boundary (PostgreSQL / MinIO / active room state).
   * Allows deterministic simulation of distributed interleavings where a stale owner's async
   * operation continues executing while a newer instance acquires the lock and commits state.
   */
  beforeMutationHook?: (lockContext?: LockContext) => Promise<void>;
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
  options?: RestoreDocumentOptions
): Promise<{ document: any; newVersion: any }> {
  // Await any in-flight persistence before acquiring document lock to prevent distributed deadlocks
  const preRoom = rooms.get(documentId);
  if (preRoom?.inFlightPersistence) {
    try {
      await preRoom.inFlightPersistence;
    } catch {
      // Pre-restore in-flight persistence errors are safely ignored
    }
  }

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
    } else if (versionRow.content_text && versionRow.content_text.trim().length > 0) {
      // Fallback for legacy checkpoints created before full snapshot storage with non-empty text
      const frag = histDoc.getXmlFragment('default');
      const p = new Y.XmlElement('p');
      const t = new Y.XmlText();
      t.insert(0, versionRow.content_text);
      p.insert(0, [t]);
      frag.insert(0, [p]);
    } else if (versionRow.snapshot_key) {
      // If a snapshot_key was registered for this version, but loadVersionSnapshot returned null/empty,
      // the snapshot is missing/lost! Fail closed: DO NOT restore an empty document!
      throw new Error(`Historical version snapshot is missing or unavailable for version ${versionNumber}`);
    } else if (versionRow.content_text === '' || versionRow.content_text === null) {
      // Only permit empty document if explicitly recorded as an empty version with no snapshot_key
      const frag = histDoc.getXmlFragment('default');
      const p = new Y.XmlElement('p');
      frag.insert(0, [p]);
    } else {
      throw new Error(`Historical version ${versionNumber} has no restorable content or snapshot`);
    }

    const restoredBytes = Y.encodeStateAsUpdate(histDoc);
    const restoredTitle = versionRow.title || 'Untitled';
    const contentText = extractSearchableText(histDoc);

    // Controlled test hook: invoked right before the protected mutation boundary
    if (options?.beforeMutationHook) {
      await options.beforeMutationHook(lockContext);
    }

    const room = rooms.get(documentId);

    if (room) {
      // CASE 1: ACTIVE ROOM RESTORE
      room.isRestoring = true;
      room.persistenceGeneration = (room.persistenceGeneration || 0) + 1;

      // 1. Cancel pending debounced persistence
      if (room.debounceTimer) {
        clearTimeout(room.debounceTimer);
        room.debounceTimer = null;
      }
      room.queuedPersistenceSeq = null;

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

        // Step A: Save immutable version snapshot FIRST (fail closed if storage fails)
        // This is safe because version snapshots are immutable and only referenced if DB commits.
        const maxResPre = await withSystemContext(async (systemDb) => {
          return await systemDb
            .selectFrom('document_versions')
            .where('document_id', '=', documentId)
            .select(sql<string | number>`COALESCE(MAX(version_number), 0)`.as('max_ver'))
            .executeTakeFirst();
        });
        const allocatedVersion = Number(maxResPre?.max_ver || 0) + 1;

        const versionKey = await saveVersionSnapshot(documentId, allocatedVersion, restoredBytes);
        lockContext?.assertLockValid();

        // Step B: PostgreSQL transaction validates fencing token under row lock,
        // updates document to point to versionKey, inserts document_versions, and inserts audit_event.
        // NOTE: MinIO recovery snapshot (latest.yjs) is NOT written yet!
        // This guarantees that if this DB transaction fails/aborts, MinIO latest.yjs is UNTOUCHED!
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

          // Blocker 2: Verify version number allocation has not diverged under concurrent checkpoints
          const maxRes = await systemDb
            .selectFrom('document_versions')
            .where('document_id', '=', documentId)
            .select(sql<string | number>`COALESCE(MAX(version_number), 0)`.as('max_ver'))
            .executeTakeFirst();

          lockContext?.assertLockValid();
          const currentMaxVersion = Number(maxRes?.max_ver || 0);
          if (currentMaxVersion + 1 !== allocatedVersion) {
            throw new Error(
              `Version divergence detected for document ${documentId}: allocated version ${allocatedVersion} but DB max version is ${currentMaxVersion}`
            );
          }
          const commitVersion = allocatedVersion;

          const updatedDoc = await systemDb
            .updateTable('documents')
            .set({
              title: restoredTitle,
              content_text: contentText,
              snapshot_key: versionKey,
              snapshot_version: commitVersion,
              ...(fencingToken > 0 ? { fencing_token: fencingToken } : {}),
              updated_at: new Date(),
            })
            .where('id', '=', documentId)
            .where((eb) => {
              if (fencingToken > 0) {
                return eb.or([
                  eb('fencing_token', '<=', fencingToken),
                  eb('fencing_token', 'is', null),
                ]);
              }
              return eb.val(true);
            })
            .returningAll()
            .executeTakeFirst();

          if (!updatedDoc) {
            throw new StaleFencingTokenError(
              `Stale active room restore commit for ${documentId}: fencing token ${fencingToken} superseded in DB`
            );
          }

          const newVersion = await systemDb
            .insertInto('document_versions')
            .values({
              document_id: documentId,
              version_number: commitVersion,
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
                newVersionNumber: commitVersion,
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

        // Step C: ONLY AFTER PostgreSQL commits: update MinIO recovery snapshot (latest.yjs)
        // Blocker 1: Fenced post-commit update with lock verification (fail-closed on DB / MinIO errors)
        lockContext?.assertLockValid();
        await lockContext?.verifyOwnership();

        const recoveryKey = await saveRecoverySnapshot(documentId, restoredBytes, fencingToken);
        if (recoveryKey) {
          await withSystemContext(async (systemDb) => {
            const res = await systemDb
              .updateTable('documents')
              .set({ snapshot_key: recoveryKey })
              .where('id', '=', documentId)
              .where((eb) => {
                if (fencingToken > 0) {
                  return eb.and([
                    eb.or([
                      eb('fencing_token', '<=', fencingToken),
                      eb('fencing_token', 'is', null),
                    ]),
                    eb('snapshot_version', '<=', allocatedVersion),
                  ]);
                }
                return eb('snapshot_version', '<=', allocatedVersion);
              })
              .executeTakeFirst();

            const numUpdated = Number(res?.numUpdatedRows || 0);
            if (numUpdated === 0) {
              console.warn(
                `[collab-server] Recovery snapshot pointer update skipped for ${documentId}: superseded in DB (token ${fencingToken}, ver ${allocatedVersion})`
              );
            }
          });
        }

        // Step D: Update in-memory room state and broadcast to clients
        room.fencingToken = fencingToken;
        room.doc.transact(() => {
          applyHistoricalDocToRoomDoc(room.doc, histDoc);
        });

        room.lastPersistedSeq = room.docSeq || 0;
        broadcastPersistence(room, PERSISTENCE_STATUS_PERSISTED, room.lastPersistedSeq);

        lockContext?.assertLockValid();
        await lockContext?.verifyOwnership();

        return dbResult;
      } catch (err: any) {
        if (
          err instanceof StaleFencingTokenError ||
          err?.name === 'StaleFencingTokenError' ||
          err?.name === 'LockLostError'
        ) {
          evictRoom(room, 'Document superseded');
        }
        throw err;
      } finally {
        room.isRestoring = false;
      }
    } else {
      // CASE 2: ROOM-LESS RESTORE (under the exact same document lock)
      lockContext?.assertLockValid();

      // Step A: Save immutable version snapshot FIRST
      const maxResPre = await withSystemContext(async (systemDb) => {
        return await systemDb
          .selectFrom('document_versions')
          .where('document_id', '=', documentId)
          .select(sql<string | number>`COALESCE(MAX(version_number), 0)`.as('max_ver'))
          .executeTakeFirst();
      });
      const allocatedVersion = Number(maxResPre?.max_ver || 0) + 1;

      const versionKey = await saveVersionSnapshot(documentId, allocatedVersion, restoredBytes);
      lockContext?.assertLockValid();

      await lockContext?.verifyOwnership();
      lockContext?.assertLockValid();

      // Step B: PostgreSQL commit FIRST
      const dbResult = await withSystemContext(async (systemDb) => {
        lockContext?.assertLockValid();

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

        // Blocker 2: Verify version number allocation has not diverged under concurrent checkpoints
        const maxRes = await systemDb
          .selectFrom('document_versions')
          .where('document_id', '=', documentId)
          .select(sql<string | number>`COALESCE(MAX(version_number), 0)`.as('max_ver'))
          .executeTakeFirst();

        lockContext?.assertLockValid();
        const currentMaxVersion = Number(maxRes?.max_ver || 0);
        if (currentMaxVersion + 1 !== allocatedVersion) {
          throw new Error(
            `Version divergence detected for document ${documentId}: allocated version ${allocatedVersion} but DB max version is ${currentMaxVersion}`
          );
        }
        const commitVersion = allocatedVersion;

        const updatedDoc = await systemDb
          .updateTable('documents')
          .set({
            title: restoredTitle,
            content_text: contentText,
            snapshot_key: versionKey,
            snapshot_version: commitVersion,
            ...(fencingToken > 0 ? { fencing_token: fencingToken } : {}),
            updated_at: new Date(),
          })
          .where('id', '=', documentId)
          .where((eb) => {
            if (fencingToken > 0) {
              return eb.or([
                eb('fencing_token', '<=', fencingToken),
                eb('fencing_token', 'is', null),
              ]);
            }
            return eb.val(true);
          })
          .returningAll()
          .executeTakeFirst();

        if (!updatedDoc) {
          throw new StaleFencingTokenError(
            `Stale room-less restore commit for ${documentId}: fencing token ${fencingToken} superseded in DB`
          );
        }

        const newVersion = await systemDb
          .insertInto('document_versions')
          .values({
            document_id: documentId,
            version_number: commitVersion,
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
              newVersionNumber: commitVersion,
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

      // Step C: ONLY AFTER PostgreSQL commits: update MinIO recovery snapshot (latest.yjs)
      // Blocker 1: Fenced post-commit update with lock verification (fail-closed on DB / MinIO errors)
      lockContext?.assertLockValid();
      await lockContext?.verifyOwnership();

      const recoveryKey = await saveRecoverySnapshot(documentId, restoredBytes, fencingToken);
      if (recoveryKey) {
        await withSystemContext(async (systemDb) => {
          const res = await systemDb
            .updateTable('documents')
            .set({ snapshot_key: recoveryKey })
            .where('id', '=', documentId)
            .where((eb) => {
              if (fencingToken > 0) {
                return eb.and([
                  eb.or([
                    eb('fencing_token', '<=', fencingToken),
                    eb('fencing_token', 'is', null),
                  ]),
                  eb('snapshot_version', '<=', allocatedVersion),
                ]);
              }
              return eb('snapshot_version', '<=', allocatedVersion);
            })
            .executeTakeFirst();

          const numUpdated = Number(res?.numUpdatedRows || 0);
          if (numUpdated === 0) {
            console.warn(
              `[collab-server] Recovery snapshot pointer update skipped for ${documentId}: superseded in DB (token ${fencingToken}, ver ${allocatedVersion})`
            );
          }
        });
      }

      lockContext?.assertLockValid();
      await lockContext?.verifyOwnership();

      return dbResult;
    }
  }, options);
}

export const restoreActiveRoom = restoreDocument;

/**
 * Create a document version checkpoint unified under withDocumentLock.
 * Option A:
 * - If room is active in memory: reads room.doc directly (authoritative in-memory state),
 *   saves recovery snapshot to MinIO, updates room.lastPersistedSeq, and writes the version checkpoint.
 * - If room is not active: reads recovery snapshot or document content_text and writes the version checkpoint.
 * - Entire flow is serialized under withDocumentLock(`document:${documentId}`), eliminating race conditions
 *   between background flushes and version number allocation.
 */
export async function createDocumentCheckpoint(
  documentId: string,
  workspaceId: string,
  userId: string,
  trigger: VersionTrigger = 'manual',
  options?: LockOptions
) {
  // Await any in-flight persistence before acquiring document lock to prevent distributed deadlocks
  const preRoom = rooms.get(documentId);
  if (preRoom?.inFlightPersistence) {
    try {
      await preRoom.inFlightPersistence;
    } catch {
      // Ignored; checkpoint will capture authoritative state
    }
  }

  return await withDocumentLock(
    documentId,
    async (lockContext) => {
      lockContext?.assertLockValid();
      await lockContext?.verifyOwnership();
      const fencingToken = lockContext?.fencingToken ?? 0;

      const room = rooms.get(documentId);
      let snapshotBytes: Uint8Array | null = null;
      let title: string | null = null;
      let contentText: string | null = null;
      let recoveryKey: string | null = null;

      if (room) {
        // 1. Active room: read authoritative doc
        snapshotBytes = Y.encodeStateAsUpdate(room.doc);
        contentText = extractSearchableText(room.doc);

        // Persist recovery snapshot
        recoveryKey = await saveRecoverySnapshot(documentId, snapshotBytes, fencingToken);
        room.lastPersistedSeq = room.docSeq;
        broadcastPersistence(room, PERSISTENCE_STATUS_PERSISTED, room.lastPersistedSeq);
      } else {
        // 2. Room-less: read durable recovery snapshot
        snapshotBytes = await loadRecoverySnapshot(documentId);
      }

      lockContext?.assertLockValid();
      await lockContext?.verifyOwnership();

      const result = await withSystemContext(async (systemDb) => {
        return await systemDb.transaction().execute(async (trx) => {
          lockContext?.assertLockValid();

          let docQuery = trx
            .selectFrom('documents')
            .where('id', '=', documentId)
            .where('workspace_id', '=', workspaceId)
            .select(['id', 'title', 'content_text', 'is_archived', 'snapshot_key', 'snapshot_version', 'fencing_token']);

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

          if (fencingToken > 0 && Number(doc.fencing_token || 0) > fencingToken) {
            throw new StaleFencingTokenError(
              `Stale checkpoint for ${documentId}: lock token ${fencingToken} < DB token ${doc.fencing_token}`
            );
          }

          title = doc.title;
          if (!contentText) {
            contentText = doc.content_text;
          }

          if ((!snapshotBytes || snapshotBytes.length === 0) && doc.content_text) {
            const tempDoc = new Y.Doc();
            const frag = tempDoc.getXmlFragment('default');
            const p = new Y.XmlElement('p');
            p.insert(0, [new Y.XmlText(doc.content_text)]);
            frag.insert(0, [p]);
            snapshotBytes = Y.encodeStateAsUpdate(tempDoc);
          }

          const maxRes = await trx
            .selectFrom('document_versions')
            .where('document_id', '=', documentId)
            .select(sql<string | number>`COALESCE(MAX(version_number), 0)`.as('max_ver'))
            .executeTakeFirst();

          const currentMaxVersion = Number(maxRes?.max_ver || 0);
          const nextVersion = currentMaxVersion + 1;

          lockContext?.assertLockValid();
          await lockContext?.verifyOwnership();

          let versionKey: string | null = null;
          if (snapshotBytes && snapshotBytes.length > 0) {
            versionKey = await saveVersionSnapshot(documentId, nextVersion, snapshotBytes);
          }

          lockContext?.assertLockValid();
          await lockContext?.verifyOwnership();

          const versionRow = await trx
            .insertInto('document_versions')
            .values({
              document_id: documentId,
              version_number: nextVersion,
              snapshot_key: versionKey,
              title: title || doc.title,
              content_text: contentText,
              created_by: userId,
              trigger: trigger,
              ...(fencingToken > 0 ? { fencing_token: fencingToken } : {}),
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          const updatedDoc = await trx
            .updateTable('documents')
            .set({
              snapshot_version: nextVersion,
              content_text: contentText,
              ...(recoveryKey ? { snapshot_key: recoveryKey } : {}),
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
            .returning(['id'])
            .executeTakeFirst();

          if (!updatedDoc) {
            throw new StaleFencingTokenError(
              `Stale checkpoint commit for ${documentId}: fencing token ${fencingToken} superseded in DB`
            );
          }

          await trx
            .insertInto('audit_events')
            .values({
              workspace_id: workspaceId,
              actor_id: userId,
              action: 'document.version.created',
              resource_type: 'document',
              resource_id: documentId,
              metadata: JSON.stringify({
                version_number: nextVersion,
                trigger,
              }),
              ip_address: null,
              user_agent: null,
            })
            .execute();

          lockContext?.assertLockValid();

          return versionRow;
        });
      });

      try {
        const boss = getPgBoss();
        await boss.send(QUEUE_INDEX_DOCUMENT, {
          documentId,
          version: result.version_number,
          workspaceId,
        });
      } catch {
        // Job queue send errors handled gracefully
      }

      return result;
    },
    options
  );
}

