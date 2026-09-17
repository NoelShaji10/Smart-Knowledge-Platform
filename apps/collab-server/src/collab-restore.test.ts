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
import * as redisModule from '@knowledge/redis';

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
              select: (_sel: any) => {
                const selectResult = async () => {
                  if (table === 'workspace_members') {
                    return memberRole ? { role: memberRole } : null;
                  }
                  if (table === 'document_permissions') {
                    return overrideRole ? { role: overrideRole } : null;
                  }
                  return null;
                };
                const selBuilder: any = {
                  forUpdate: () => selBuilder,
                  executeTakeFirst: selectResult,
                  executeTakeFirstOrThrow: async () => {
                    const r = await selectResult();
                    if (!r) throw new Error('Not found');
                    return r;
                  },
                };
                return selBuilder;
              },
            }),
            selectAll: () => ({
              executeTakeFirst: async () => null,
            }),
            select: (_sel: any) => {
              const selectResult = async () => {
                if (table === 'users') {
                  return userExists ? { id: val } : null;
                }
                if (table === 'documents') {
                  return docExists
                    ? { workspace_id: workspaceId, fencing_token: 0, is_archived: docArchived ? 1 : 0 }
                    : null;
                }
                if (table === 'document_versions') {
                  return { max_ver: 2 };
                }
                return null;
              };
              const selBuilder: any = {
                forUpdate: () => selBuilder,
                executeTakeFirst: selectResult,
                executeTakeFirstOrThrow: async () => {
                  const r = await selectResult();
                  if (!r) throw new Error('Not found');
                  return r;
                },
              };
              return selBuilder;
            },
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
          set: (sets: any) => {
            const res = {
              id: docId,
              workspace_id: workspaceId,
              snapshot_version: 3,
              fencing_token: 0,
              ...sets,
            };
            const updateBuilder: any = {
              where: () => updateBuilder,
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
            return updateBuilder;
          },
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

  it('performs room-less restore when room is not active in memory', async () => {
    clearAllRooms();
    const result = await restoreActiveRoom(docId, 1, userId);
    expect(result).toBeDefined();
    expect(result?.document).toBeDefined();
    expect(result?.newVersion.trigger).toBe('restore');
    expect(storageSnapshots.has(docId)).toBe(true);
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

    it('performs room-less restore under document lock when no room is in memory', async () => {
      clearAllRooms();
      const res = await request(server)
        .post(`/internal/documents/${docId}/restore`)
        .set('x-internal-key', getEnv().INTERNAL_SERVICE_KEY)
        .send({ versionNumber: 1, userId });

      expect(res.status).toBe(200);
      expect(res.body.document).toBeDefined();
      expect(res.body.newVersion).toBeDefined();
      expect(res.body.newVersion.version_number).toBe(3);
      expect(res.body.newVersion.trigger).toBe('restore');

      // Recovery snapshot was updated in storage
      expect(storageSnapshots.has(docId)).toBe(true);
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
      expect(res.body.document).toBeDefined();
      expect(res.body.newVersion.version_number).toBe(3);
      expect(res.body.newVersion.trigger).toBe('restore');
    });

    it('serializes room creation during restore: connecting client blocks and hydrates restored state, never stale state', async () => {
      clearAllRooms();

      // 1. Seed stale snapshot in storage
      const staleDoc = new Y.Doc();
      const staleFrag = staleDoc.getXmlFragment('default');
      const pStale = new Y.XmlElement('p');
      pStale.insert(0, [new Y.XmlText('Stale Pre-Restore State')]);
      staleFrag.insert(0, [pStale]);
      storageSnapshots.set(docId, Y.encodeStateAsUpdate(staleDoc));

      // 2. Seed restored version in storage
      const restoredDoc = new Y.Doc();
      const restoredFrag = restoredDoc.getXmlFragment('default');
      const pRestored = new Y.XmlElement('p');
      pRestored.insert(0, [new Y.XmlText('Restored Target Content')]);
      restoredFrag.insert(0, [pRestored]);
      storageVersions.set(`${docId}:1`, Y.encodeStateAsUpdate(restoredDoc));

      // 3. Mock saveRecoverySnapshot to introduce an artificial delay simulating slow MinIO write
      const originalSave = storage.saveRecoverySnapshot;
      vi.spyOn(storage, 'saveRecoverySnapshot').mockImplementation(async (dId, data) => {
        await new Promise((r) => setTimeout(r, 60));
        storageSnapshots.set(dId, new Uint8Array(data));
        return `snapshots/${dId}/latest.yjs`;
      });

      // 4. Start restore operation (room does not exist yet)
      const restorePromise = request(server)
        .post(`/internal/documents/${docId}/restore`)
        .set('x-internal-key', getEnv().INTERNAL_SERVICE_KEY)
        .send({ versionNumber: 1, userId });

      // 5. In parallel (while restore is still running), a client connects and calls getOrCreateRoom()
      // Because getOrCreateRoom acquires withDocumentLock(docId), it MUST wait for restore to complete!
      const roomPromise = (async () => {
        // slight delay to ensure restore enters withDocumentLock first
        await new Promise((r) => setTimeout(r, 10));
        return await getOrCreateRoom(docId);
      })();

      const [restoreRes, room] = await Promise.all([restorePromise, roomPromise]);

      expect(restoreRes.status).toBe(200);
      expect(room).toBeDefined();

      // Crucial assertion: the room MUST have hydrated the RESTORED state, NOT the stale state!
      expect(room.doc.getXmlFragment('default').toString()).toBe('<p>Restored Target Content</p>');
    });

    it('serializes concurrent restore requests without conflicting version numbers', async () => {
      clearAllRooms();

      let currentMax = 2;
      vi.spyOn(database, 'withSystemContext').mockImplementation(async (fn: any) => {
        const mockSystemDb = {
          selectFrom: (table: string) => ({
            where: (_col: string, _op: string, val: any) => ({
              where: (_col2: string, _op2: string, val2: any) => ({
                selectAll: () => ({
                  executeTakeFirst: async () => {
                    if (table === 'document_versions') {
                      return {
                        id: `ver-uuid-${val2}`,
                        document_id: docId,
                        version_number: val2,
                        snapshot_key: `versions/${docId}/${val2}.yjs`,
                        title: 'Test Doc Title',
                        content_text: 'Content',
                        created_by: userId,
                        trigger: 'manual',
                        created_at: new Date().toISOString(),
                      };
                    }
                    return null;
                  },
                }),
                select: (_sel: any) => {
                  const selBuilder: any = {
                    forUpdate: () => selBuilder,
                    executeTakeFirst: async () => ({ role: 'editor' }),
                    executeTakeFirstOrThrow: async () => ({ role: 'editor' }),
                  };
                  return selBuilder;
                },
              }),
              selectAll: () => ({
                executeTakeFirst: async () => null,
              }),
              select: (_sel: any) => {
                const selectResult = async () => {
                  if (table === 'users') return { id: val };
                  if (table === 'documents') return { workspace_id: workspaceId, fencing_token: 0, is_archived: 0 };
                  if (table === 'document_versions') {
                    currentMax += 1;
                    return { max_ver: currentMax - 1 };
                  }
                  return null;
                };
                const selBuilder: any = {
                  forUpdate: () => selBuilder,
                  executeTakeFirst: selectResult,
                  executeTakeFirstOrThrow: async () => {
                    const r = await selectResult();
                    if (!r) throw new Error('Not found');
                    return r;
                  },
                };
                return selBuilder;
              },
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
            set: (sets: any) => {
              const res = {
                id: docId,
                workspace_id: workspaceId,
                snapshot_version: currentMax,
                fencing_token: 0,
                ...sets,
              };
              const updateBuilder: any = {
                where: () => updateBuilder,
                returningAll: () => ({
                  executeTakeFirstOrThrow: async () => res,
                  executeTakeFirst: async () => res,
                }),
                execute: async () => {},
              };
              return updateBuilder;
            },
          }),
        };
        return await fn(mockSystemDb);
      });

      const p1 = request(server)
        .post(`/internal/documents/${docId}/restore`)
        .set('x-internal-key', getEnv().INTERNAL_SERVICE_KEY)
        .send({ versionNumber: 1, userId });

      const p2 = request(server)
        .post(`/internal/documents/${docId}/restore`)
        .set('x-internal-key', getEnv().INTERNAL_SERVICE_KEY)
        .send({ versionNumber: 1, userId });

      const [res1, res2] = await Promise.all([p1, p2]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res1.body.newVersion.version_number).not.toBe(res2.body.newVersion.version_number);
    });

    it('aborts restore and fails closed if lock ownership is lost during execution', async () => {
      clearAllRooms();
      const redis = redisModule.getRedisClient();

      // Hook into saveRecoverySnapshot to delete lock mid-flight
      const originalSave = storage.saveRecoverySnapshot;
      vi.spyOn(storage, 'saveRecoverySnapshot').mockImplementation(async (dId, data) => {
        // Delete the document lock in Redis while the restore is in-flight
        await redis.del(`lock:document:${dId}`);
        return originalSave(dId, data);
      });

      const res = await request(server)
        .post(`/internal/documents/${docId}/restore`)
        .set('x-internal-key', getEnv().INTERNAL_SERVICE_KEY)
        .send({ versionNumber: 1, userId });

      // Must fail closed with 500 Lock ownership lost error
      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Lock ownership lost');
    });

    it('refuses subsequent database mutations when lock ownership is lost mid-flight', async () => {
      clearAllRooms();
      const redis = redisModule.getRedisClient();
      let dbInsertAttempted = false;

      // Mock saveRecoverySnapshot to delete lock
      vi.spyOn(storage, 'saveRecoverySnapshot').mockImplementation(async () => {
        await redis.del(`lock:document:${docId}`);
        return `snapshots/${docId}/latest.yjs`;
      });

      // Spy on withSystemContext to check if document_versions insert was attempted after lock loss
      const originalWithSystem = database.withSystemContext;
      vi.spyOn(database, 'withSystemContext').mockImplementation(async (fn: any) => {
        const mockSystemDb = {
          selectFrom: (table: string) => ({
            where: () => ({
              where: () => ({
                selectAll: () => ({
                  executeTakeFirst: async () => {
                    if (table === 'document_versions') {
                      return {
                        id: 'ver-1',
                        document_id: docId,
                        version_number: 1,
                        snapshot_key: `versions/${docId}/1.yjs`,
                        title: 'Test',
                        content_text: 'Content',
                        created_by: userId,
                        trigger: 'manual',
                        created_at: new Date().toISOString(),
                      };
                    }
                    return null;
                  },
                }),
                select: () => ({
                  executeTakeFirst: async () => ({ role: 'editor' }),
                }),
              }),
              selectAll: () => ({ executeTakeFirst: async () => null }),
              select: () => ({
                executeTakeFirst: async () => {
                  if (table === 'users') return { id: userId };
                  if (table === 'documents') return { workspace_id: workspaceId, is_archived: 0 };
                  if (table === 'document_versions') return { max_ver: 2 };
                  return null;
                },
              }),
            }),
          }),
          insertInto: () => {
            dbInsertAttempted = true;
            throw new Error('Should not reach database insert after lock loss!');
          },
          updateTable: () => ({
            set: () => ({
              where: () => ({
                returningAll: () => ({ executeTakeFirstOrThrow: async () => ({}) }),
              }),
            }),
          }),
        };
        return await fn(mockSystemDb);
      });

      const res = await request(server)
        .post(`/internal/documents/${docId}/restore`)
        .set('x-internal-key', getEnv().INTERNAL_SERVICE_KEY)
        .send({ versionNumber: 1, userId });

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Lock ownership lost');
      expect(dbInsertAttempted).toBe(false);
    });

    it('prevents second restore from overlapping while first restore aborted work is settling', async () => {
      clearAllRooms();
      const redis = redisModule.getRedisClient();

      let firstRestoreActive = false;
      let secondRestoreOverlapped = false;

      // First restore: loses lock during saveRecoverySnapshot, then takes 80ms to settle
      let callCount = 0;
      vi.spyOn(storage, 'saveRecoverySnapshot').mockImplementation(async (dId, data) => {
        callCount++;
        if (callCount === 1) {
          firstRestoreActive = true;
          await redis.del(`lock:document:${dId}`);
          await new Promise((r) => setTimeout(r, 80));
          firstRestoreActive = false;
          return `snapshots/${dId}/latest.yjs`;
        }
        if (firstRestoreActive) {
          secondRestoreOverlapped = true;
        }
        return `snapshots/${dId}/latest.yjs`;
      });

      const p1 = request(server)
        .post(`/internal/documents/${docId}/restore`)
        .set('x-internal-key', getEnv().INTERNAL_SERVICE_KEY)
        .send({ versionNumber: 1, userId });

      // Second restore: launched concurrently with p1
      const p2 = (async () => {
        await new Promise((r) => setTimeout(r, 10));
        return await request(server)
          .post(`/internal/documents/${docId}/restore`)
          .set('x-internal-key', getEnv().INTERNAL_SERVICE_KEY)
          .send({ versionNumber: 1, userId });
      })();

      const [res1, res2] = await Promise.all([p1, p2]);
      expect(res1.status).toBe(500); // First failed closed due to lock loss
      expect(res2.status).toBe(200); // Second succeeded once first settled
      expect(secondRestoreOverlapped).toBe(false); // Never overlapped!
    });
  });
});
