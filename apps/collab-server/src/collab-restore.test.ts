import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import WebSocket from 'ws';
import EventEmitter from 'events';

import {
  getOrCreateRoom,
  addConnectionToRoom,
  removeConnectionFromRoom,
  clearAllRooms,
  getRoom,
  restoreActiveRoom,
  applyHistoricalDocToRoomDoc,
  ClientConnection,
  MESSAGE_YJS_SYNC,
  MESSAGE_PERSISTENCE,
  PERSISTENCE_STATUS_PERSISTED,
  PERSISTENCE_STATUS_PERSISTING,
} from './room-manager';
import * as storage from '@knowledge/storage';
import * as snapshotService from './snapshot-service';
import * as database from '@knowledge/database';
import request from 'supertest';
import { createCollabServer, verifyUserCanEditDocument } from './server';
import { getEnv } from '@knowledge/config';

class MockWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sentData: Uint8Array[] = [];

  send(data: Uint8Array | string, _options?: { binary?: boolean }) {
    if (this.readyState !== WebSocket.OPEN) {
      throw new Error('Socket is not open');
    }
    if (data instanceof Uint8Array) {
      this.sentData.push(data);
    } else if (typeof data === 'string') {
      this.sentData.push(new TextEncoder().encode(data));
    }
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

describe('Phase 5 T4: Production-Grade Version History & Restore', () => {
  const docId = '11111111-1111-1111-1111-111111111111';
  const workspaceId = '22222222-2222-2222-2222-222222222222';
  const userId = '33333333-3333-3333-3333-333333333333';

  // In-memory mock storage for snapshots and versions
  const storageSnapshots = new Map<string, Uint8Array>();
  const storageVersions = new Map<string, Uint8Array>();

  let userExists = true;
  let docExists = true;
  let docArchived = false;
  let memberRole: 'owner' | 'admin' | 'editor' | 'viewer' | null = 'editor';
  let overrideRole: 'editor' | 'viewer' | 'none' | null = null;

  beforeEach(() => {
    clearAllRooms();
    storageSnapshots.clear();
    storageVersions.clear();

    userExists = true;
    docExists = true;
    docArchived = false;
    memberRole = 'editor';
    overrideRole = null;

    vi.spyOn(storage, 'loadRecoverySnapshot').mockImplementation(async (dId) => {
      return storageSnapshots.get(dId) || null;
    });

    vi.spyOn(storage, 'saveRecoverySnapshot').mockImplementation(async (dId, data) => {
      storageSnapshots.set(dId, new Uint8Array(data));
      return `snapshots/${dId}/latest.yjs`;
    });

    vi.spyOn(storage, 'saveVersionSnapshot').mockImplementation(async (dId, ver, data) => {
      const key = `versions/${dId}/${ver}.yjs`;
      storageVersions.set(`${dId}:${ver}`, new Uint8Array(data));
      return key;
    });

    vi.spyOn(storage, 'loadVersionSnapshot').mockImplementation(async (dId, ver) => {
      return storageVersions.get(`${dId}:${ver}`) || null;
    });

    vi.spyOn(snapshotService, 'persistRecoverySnapshot').mockImplementation(async (dId, doc) => {
      const bytes = Y.encodeStateAsUpdate(doc);
      storageSnapshots.set(dId, bytes);
      await storage.saveRecoverySnapshot(dId, bytes);
    });

    // Mock database interactions
    vi.spyOn(database, 'withSystemContext').mockImplementation(async (fn: any) => {
      const mockSystemDb = {
        selectFrom: (table: string) => ({
          where: (_col: string, _op: string, val: any) => ({
            where: (_col2: string, _op2: string, val2: any) => ({
              selectAll: () => ({
                executeTakeFirst: async () => {
                  if (table === 'document_versions') {
                    return {
                      id: 'ver-uuid-1',
                      document_id: docId,
                      version_number: val2,
                      snapshot_key: `versions/${docId}/${val2}.yjs`,
                      title: 'Test Doc Title V1',
                      content_text: 'First Version Content',
                      created_by: userId,
                      trigger: 'manual',
                      created_at: new Date().toISOString(),
                    };
                  }
                  return null;
                },
              }),
              select: (_sel: any) => ({
                executeTakeFirst: async () => {
                  if (table === 'workspace_members') {
                    return memberRole ? { role: memberRole } : null;
                  }
                  if (table === 'document_permissions') {
                    return overrideRole ? { role: overrideRole } : null;
                  }
                  return null;
                },
              }),
            }),
            selectAll: () => ({
              executeTakeFirst: async () => null,
            }),
            select: (_sel: any) => ({
              executeTakeFirst: async () => {
                if (table === 'users') {
                  return userExists ? { id: val } : null;
                }
                if (table === 'documents') {
                  return docExists ? { workspace_id: workspaceId, is_archived: docArchived ? 1 : 0 } : null;
                }
                if (table === 'document_versions') {
                  return { max_ver: 2 };
                }
                return null;
              },
            }),
          }),
        }),
        insertInto: () => ({
          values: (vals: any) => ({
            returningAll: () => ({
              executeTakeFirstOrThrow: async () => ({
                id: 'new-ver-uuid',
                ...vals,
                created_at: new Date().toISOString(),
              }),
            }),
            execute: async () => {},
          }),
        }),
        updateTable: () => ({
          set: (sets: any) => ({
            where: () => {
              const res = {
                id: docId,
                workspace_id: workspaceId,
                snapshot_version: 3,
                ...sets,
              };
              return {
                returningAll: () => ({
                  executeTakeFirstOrThrow: async () => res,
                  executeTakeFirst: async () => res,
                }),
                returning: () => ({
                  executeTakeFirstOrThrow: async () => res,
                  executeTakeFirst: async () => res,
                }),
                executeTakeFirstOrThrow: async () => res,
                executeTakeFirst: async () => res,
                execute: async () => {},
              };
            },
          }),
        }),
      };
      return await fn(mockSystemDb);
    });
  });

  afterEach(() => {
    clearAllRooms();
    vi.restoreAllMocks();
  });

  it('applies historical doc to target doc accurately via applyHistoricalDocToRoomDoc', () => {
    const targetDoc = new Y.Doc();
    const sourceDoc = new Y.Doc();

    // Source doc has Version 1 content
    const sourceFrag = sourceDoc.getXmlFragment('default');
    const p1 = new Y.XmlElement('p');
    p1.insert(0, [new Y.XmlText('Original Version 1 Content')]);
    sourceFrag.insert(0, [p1]);

    // Target doc currently has Version 2 content
    const targetFrag = targetDoc.getXmlFragment('default');
    const p2 = new Y.XmlElement('p');
    p2.insert(0, [new Y.XmlText('Overwritten Version 2 Content')]);
    targetFrag.insert(0, [p2]);

    expect(targetFrag.toString()).toBe('<p>Overwritten Version 2 Content</p>');

    // Apply historical source onto target
    targetDoc.transact(() => {
      applyHistoricalDocToRoomDoc(targetDoc, sourceDoc);
    });

    // Target now matches source exactly
    expect(targetFrag.toString()).toBe('<p>Original Version 1 Content</p>');
  });

  it('restores active room: connected clients A and B receive CRDT sync updates and converge to restored content', async () => {
    const room = await getOrCreateRoom(docId);

    // 1. Initial document state (Version 1)
    const frag = room.doc.getXmlFragment('default');
    const p1 = new Y.XmlElement('p');
    p1.insert(0, [new Y.XmlText('Version 1 Canonical State')]);
    frag.insert(0, [p1]);

    // Save Version 1 snapshot in storage
    const v1Bytes = Y.encodeStateAsUpdate(room.doc);
    storageVersions.set(`${docId}:1`, v1Bytes);

    // 2. Setup connected clients A and B
    const mockWsA = new MockWebSocket() as unknown as WebSocket;
    const mockWsB = new MockWebSocket() as unknown as WebSocket;

    const connA: ClientConnection = {
      id: 'conn-a',
      ws: mockWsA,
      userId: 'user-a',
      workspaceId,
      documentId: docId,
      canEdit: true,
      effectiveRole: 'editor',
    };

    const connB: ClientConnection = {
      id: 'conn-b',
      ws: mockWsB,
      userId: 'user-b',
      workspaceId,
      documentId: docId,
      canEdit: true,
      effectiveRole: 'editor',
    };

    addConnectionToRoom(room, connA);
    addConnectionToRoom(room, connB);

    // Local client docs initialized to current state
    const clientDocA = new Y.Doc();
    const clientDocB = new Y.Doc();
    Y.applyUpdate(clientDocA, Y.encodeStateAsUpdate(room.doc));
    Y.applyUpdate(clientDocB, Y.encodeStateAsUpdate(room.doc));

    // Clear sent data from mock sockets
    (mockWsA as any).sentData = [];
    (mockWsB as any).sentData = [];

    // 3. Document is mutated to Version 2
    room.doc.transact(() => {
      frag.delete(0, frag.length);
      const p2 = new Y.XmlElement('p');
      p2.insert(0, [new Y.XmlText('Version 2 Mutated Content - New edits')]);
      frag.insert(0, [p2]);
    });

    expect(room.doc.getXmlFragment('default').toString()).toBe('<p>Version 2 Mutated Content - New edits</p>');

    // Apply updates that were broadcast to clients
    for (const msg of (mockWsA as any).sentData) {
      const decoder = decoding.createDecoder(msg);
      const msgType = decoding.readVarUint(decoder);
      if (msgType === MESSAGE_YJS_SYNC) {
        const syncType = decoding.readVarUint(decoder);
        if (syncType === syncProtocol.messageYjsUpdate) {
          syncProtocol.readUpdate(decoder, clientDocA, null);
        }
      }
    }
    for (const msg of (mockWsB as any).sentData) {
      const decoder = decoding.createDecoder(msg);
      const msgType = decoding.readVarUint(decoder);
      if (msgType === MESSAGE_YJS_SYNC) {
        const syncType = decoding.readVarUint(decoder);
        if (syncType === syncProtocol.messageYjsUpdate) {
          syncProtocol.readUpdate(decoder, clientDocB, null);
        }
      }
    }

    expect(clientDocA.getXmlFragment('default').toString()).toBe('<p>Version 2 Mutated Content - New edits</p>');
    expect(clientDocB.getXmlFragment('default').toString()).toBe('<p>Version 2 Mutated Content - New edits</p>');

    // Clear socket buffers before restore
    (mockWsA as any).sentData = [];
    (mockWsB as any).sentData = [];

    // 4. RESTORE Version 1 on the active room!
    const restoreResult = await restoreActiveRoom(docId, 1, userId);

    expect(restoreResult).toBeDefined();
    expect(restoreResult?.newVersion.version_number).toBe(3);
    expect(restoreResult?.newVersion.trigger).toBe('restore');

    // 5. Verify room.doc contains restored Version 1 content
    expect(room.doc.getXmlFragment('default').toString()).toBe('<p>Version 1 Canonical State</p>');

    // 6. Verify Client A and Client B received Yjs update and CONVERGED to Version 1 content!
    const syncMsgsA = (mockWsA as any).sentData.filter((data: Uint8Array) => {
      const decoder = decoding.createDecoder(data);
      return decoding.readVarUint(decoder) === MESSAGE_YJS_SYNC;
    });

    const syncMsgsB = (mockWsB as any).sentData.filter((data: Uint8Array) => {
      const decoder = decoding.createDecoder(data);
      return decoding.readVarUint(decoder) === MESSAGE_YJS_SYNC;
    });

    expect(syncMsgsA.length).toBeGreaterThan(0);
    expect(syncMsgsB.length).toBeGreaterThan(0);

    for (const msg of syncMsgsA) {
      const decoder = decoding.createDecoder(msg);
      decoding.readVarUint(decoder); // messageType
      const syncType = decoding.readVarUint(decoder);
      if (syncType === syncProtocol.messageYjsUpdate) {
        syncProtocol.readUpdate(decoder, clientDocA, null);
      }
    }

    for (const msg of syncMsgsB) {
      const decoder = decoding.createDecoder(msg);
      decoding.readVarUint(decoder); // messageType
      const syncType = decoding.readVarUint(decoder);
      if (syncType === syncProtocol.messageYjsUpdate) {
        syncProtocol.readUpdate(decoder, clientDocB, null);
      }
    }

    // Both clients naturally converged to restored state!
    expect(clientDocA.getXmlFragment('default').toString()).toBe('<p>Version 1 Canonical State</p>');
    expect(clientDocB.getXmlFragment('default').toString()).toBe('<p>Version 1 Canonical State</p>');

    // 7. Verify persistence packets were broadcast
    const persistMsgsA = (mockWsA as any).sentData.filter((data: Uint8Array) => {
      const decoder = decoding.createDecoder(data);
      return decoding.readVarUint(decoder) === MESSAGE_PERSISTENCE;
    });
    expect(persistMsgsA.length).toBeGreaterThanOrEqual(1);

    // Clean up
    removeConnectionFromRoom(room, connA);
    removeConnectionFromRoom(room, connB);
  });

  it('hydrates next client from the restored state after room is closed', async () => {
    // 1. Create room and set Version 1
    let room = await getOrCreateRoom(docId);
    const frag = room.doc.getXmlFragment('default');
    const p1 = new Y.XmlElement('p');
    p1.insert(0, [new Y.XmlText('Historical Version 1')]);
    frag.insert(0, [p1]);

    const v1Bytes = Y.encodeStateAsUpdate(room.doc);
    storageVersions.set(`${docId}:1`, v1Bytes);

    // 2. Mutate to Version 2
    room.doc.transact(() => {
      frag.delete(0, frag.length);
      const p2 = new Y.XmlElement('p');
      p2.insert(0, [new Y.XmlText('Mutated Version 2')]);
      frag.insert(0, [p2]);
    });

    // 3. Restore Version 1
    await restoreActiveRoom(docId, 1, userId);

    // 4. Close/clear all rooms (simulating complete client disconnect & server shutdown)
    clearAllRooms();
    expect(getRoom(docId)).toBeUndefined();

    // 5. Subsequent connection opens room again
    const newRoom = await getOrCreateRoom(docId);

    // Verify newRoom hydrated directly from restored state
    expect(newRoom.doc.getXmlFragment('default').toString()).toBe('<p>Historical Version 1</p>');
  });

  it('preserves historical source version immutability', async () => {
    const room = await getOrCreateRoom(docId);
    const frag = room.doc.getXmlFragment('default');
    const p = new Y.XmlElement('p');
    p.insert(0, [new Y.XmlText('Version 1 Unchanged')]);
    frag.insert(0, [p]);

    const v1Bytes = Y.encodeStateAsUpdate(room.doc);
    storageVersions.set(`${docId}:1`, v1Bytes);

    // Restore
    await restoreActiveRoom(docId, 1, userId);

    // Verify stored Version 1 snapshot bytes are identical
    const storedV1After = storageVersions.get(`${docId}:1`);
    expect(storedV1After).toEqual(v1Bytes);
  });

  it('fails safely when version snapshot is corrupt without destroying live room', async () => {
    const room = await getOrCreateRoom(docId);
    const frag = room.doc.getXmlFragment('default');
    const p = new Y.XmlElement('p');
    p.insert(0, [new Y.XmlText('Current Live Content')]);
    frag.insert(0, [p]);

    // Store corrupted binary data
    const corruptBytes = new Uint8Array([0xff, 0xff, 0xff, 0x00, 0x12, 0x34]);
    storageVersions.set(`${docId}:99`, corruptBytes);

    // Restoring corrupt version throws error
    await expect(restoreActiveRoom(docId, 99, userId)).rejects.toThrow(
      'Historical version snapshot is corrupt or invalid'
    );

    // Live room content remains intact and uncorrupted
    expect(room.doc.getXmlFragment('default').toString()).toBe('<p>Current Live Content</p>');
  });

  it('returns null when room is not active', async () => {
    clearAllRooms();
    const result = await restoreActiveRoom('non-existent-doc-id', 1, userId);
    expect(result).toBeNull();
  });

  describe('Internal Restore Endpoint & Security', () => {
    const { server } = createCollabServer();

    it('rejects internal restore without service key (401)', async () => {
      const res = await request(server)
        .post(`/internal/documents/${docId}/restore`)
        .send({ versionNumber: 1, userId });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized internal service request');
    });

    it('rejects internal restore with invalid service key (401)', async () => {
      const res = await request(server)
        .post(`/internal/documents/${docId}/restore`)
        .set('x-internal-key', 'wrong-key')
        .send({ versionNumber: 1, userId });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized internal service request');
    });

    it('rejects internal restore when user does not have edit permissions (403)', async () => {
      memberRole = 'viewer';
      const res = await request(server)
        .post(`/internal/documents/${docId}/restore`)
        .set('x-internal-key', getEnv().INTERNAL_SERVICE_KEY)
        .send({ versionNumber: 1, userId });

      expect(res.status).toBe(403);
    });

    it('rejects internal restore when document is archived (403)', async () => {
      docArchived = true;
      const res = await request(server)
        .post(`/internal/documents/${docId}/restore`)
        .set('x-internal-key', getEnv().INTERNAL_SERVICE_KEY)
        .send({ versionNumber: 1, userId });

      expect(res.status).toBe(403);
    });

    it('rejects internal restore when user does not exist (401)', async () => {
      userExists = false;
      const res = await request(server)
        .post(`/internal/documents/${docId}/restore`)
        .set('x-internal-key', getEnv().INTERNAL_SERVICE_KEY)
        .send({ versionNumber: 1, userId });

      expect(res.status).toBe(401);
    });

    it('returns hasActiveRoom: false when no active room is open in memory', async () => {
      clearAllRooms();
      const res = await request(server)
        .post(`/internal/documents/${docId}/restore`)
        .set('x-internal-key', getEnv().INTERNAL_SERVICE_KEY)
        .send({ versionNumber: 1, userId });

      expect(res.status).toBe(200);
      expect(res.body.hasActiveRoom).toBe(false);
    });

    it('restores active room when room is open in memory', async () => {
      const room = await getOrCreateRoom(docId);
      const frag = room.doc.getXmlFragment('default');
      const p1 = new Y.XmlElement('p');
      p1.insert(0, [new Y.XmlText('Initial State')]);
      frag.insert(0, [p1]);

      storageVersions.set(`${docId}:1`, Y.encodeStateAsUpdate(room.doc));

      const res = await request(server)
        .post(`/internal/documents/${docId}/restore`)
        .set('x-internal-key', getEnv().INTERNAL_SERVICE_KEY)
        .send({ versionNumber: 1, userId });

      expect(res.status).toBe(200);
      expect(res.body.hasActiveRoom).toBe(true);
      expect(res.body.newVersion.version_number).toBe(3);
    });
  });
});
