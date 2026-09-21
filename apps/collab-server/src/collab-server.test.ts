import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import WebSocket from 'ws';
import EventEmitter from 'events';

import { createCollabServer, handleIncomingMessage, sendSyncStep1 } from './server';
import {
  getOrCreateRoom,
  removeConnectionFromRoom,
  removeRoomIfEmpty,
  clearAllRooms,
  getRoom,
  getRoomCount,
  ClientConnection,
  addConnectionToRoom,
  MESSAGE_YJS_SYNC,
  MESSAGE_PERSISTENCE,
  PERSISTENCE_STATUS_PERSISTED,
  PERSISTENCE_STATUS_PERSISTING,
  PERSISTENCE_STATUS_ERROR,
  flushRoomPersistence,
} from './room-manager';
import * as storage from '@knowledge/storage';
import * as database from '@knowledge/database';
import * as snapshotService from './snapshot-service';

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

describe('T1, T2 & T5: Collab Server Yjs Sync, Room Manager & Viewer Write Enforcement Integration', () => {
  beforeEach(() => {
    clearAllRooms();
    vi.spyOn(database, 'withSystemContext').mockImplementation(async () => null);
    vi.spyOn(storage, 'loadRecoverySnapshot').mockResolvedValue(null);
    vi.spyOn(storage, 'loadRecoverySnapshotWithMetadata').mockResolvedValue(null);
    vi.spyOn(storage, 'loadVersionSnapshot').mockResolvedValue(null);
    vi.spyOn(storage, 'saveRecoverySnapshot').mockResolvedValue('snapshots/test/latest.yjs');
    vi.spyOn(storage, 'saveVersionSnapshot').mockResolvedValue('versions/test/1.yjs');
    vi.spyOn(snapshotService, 'persistRecoverySnapshot').mockResolvedValue();
    vi.spyOn(snapshotService, 'createVersionCheckpointOnSessionEnd').mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearAllRooms();
    vi.restoreAllMocks();
  });

  describe('Server Instantiation', () => {
    it('creates HTTP server and WebSocketServer instances', () => {
      const { server, wss } = createCollabServer();
      expect(server).toBeDefined();
      expect(wss).toBeDefined();
    });
  });

  describe('Room Lifecycle & Isolation', () => {
    it('creates a room and retrieves the same room for the same document ID', async () => {
      const room1 = await getOrCreateRoom('00000000-0000-0000-0000-000000000101');
      const room2 = await getOrCreateRoom('00000000-0000-0000-0000-000000000101');
      expect(room1).toBe(room2);
      expect(getRoomCount()).toBe(1);
    });

    it('isolates different document rooms completely', async () => {
      const roomA = await getOrCreateRoom('00000000-0000-0000-0000-00000000010a');
      const roomB = await getOrCreateRoom('00000000-0000-0000-0000-00000000010b');

      expect(roomA).not.toBe(roomB);
      expect(getRoomCount()).toBe(2);

      // Mutate roomA's Y.Doc
      const textA = roomA.doc.getText('content');
      textA.insert(0, 'Hello Room A');

      // RoomB's Y.Doc should remain empty
      const textB = roomB.doc.getText('content');
      expect(textB.toString()).toBe('');
    });

    it('cleans up empty rooms when all connections close', async () => {
      const docId = '00000000-0000-0000-0000-00000000010c';
      const room = await getOrCreateRoom(docId);
      const mockWs = new MockWebSocket() as unknown as WebSocket;

      const conn: ClientConnection = {
        id: 'conn-1',
        ws: mockWs,
        userId: '00000000-0000-0000-0000-000000000201',
        workspaceId: '00000000-0000-0000-0000-000000000301',
        documentId: docId,
        canEdit: true,
        effectiveRole: 'editor',
      };

      addConnectionToRoom(room, conn);
      expect(room.connections.size).toBe(1);

      removeConnectionFromRoom(room, conn);
      expect(room.connections.size).toBe(0);

      await removeRoomIfEmpty(docId);
      expect(getRoom(docId)).toBeUndefined();
      expect(getRoomCount()).toBe(0);
    });
  });

  describe('Yjs Sync Protocol & Viewer Write Enforcement', () => {
    it('sends SyncStep1 when sendSyncStep1 is invoked on connection', async () => {
      const room = await getOrCreateRoom('00000000-0000-0000-0000-00000000010d');
      const mockWs = new MockWebSocket();

      const conn: ClientConnection = {
        id: 'conn-1',
        ws: mockWs as unknown as WebSocket,
        userId: '00000000-0000-0000-0000-000000000201',
        workspaceId: '00000000-0000-0000-0000-000000000301',
        documentId: '00000000-0000-0000-0000-00000000010d',
        canEdit: true,
        effectiveRole: 'editor',
      };

      sendSyncStep1(conn, room);

      expect(mockWs.sentData.length).toBe(1);
      const sentPayload = mockWs.sentData[0];
      const decoder = decoding.createDecoder(sentPayload);
      const messageType = decoding.readVarUint(decoder);
      expect(messageType).toBe(MESSAGE_YJS_SYNC);

      const syncMessageType = decoding.readVarUint(decoder);
      expect(syncMessageType).toBe(syncProtocol.messageYjsSyncStep1);
    });

    it('synchronizes document edits bidirectionally between two editor clients in the same room', async () => {
      const room = await getOrCreateRoom('00000000-0000-0000-0000-00000000010e');

      const mockWsA = new MockWebSocket();
      const mockWsB = new MockWebSocket();

      const connA: ClientConnection = {
        id: 'conn-A',
        ws: mockWsA as unknown as WebSocket,
        userId: 'user-A',
        workspaceId: 'ws-1',
        documentId: '00000000-0000-0000-0000-00000000010e',
        canEdit: true,
        effectiveRole: 'editor',
      };

      const connB: ClientConnection = {
        id: 'conn-B',
        ws: mockWsB as unknown as WebSocket,
        userId: 'user-B',
        workspaceId: 'ws-1',
        documentId: '00000000-0000-0000-0000-00000000010e',
        canEdit: true,
        effectiveRole: 'editor',
      };

      addConnectionToRoom(room, connA);
      addConnectionToRoom(room, connB);

      // Client A creates a local Y.Doc, makes an edit, and sends SyncStep2 / Update to server
      const clientDocA = new Y.Doc();
      const textA = clientDocA.getText('content');

      let updateFromA: Uint8Array | null = null;
      clientDocA.on('update', (update) => {
        updateFromA = update;
      });

      textA.insert(0, 'Collaborative Text from Client A');
      expect(updateFromA).not.toBeNull();

      // Wrap updateFromA in a Yjs MESSAGE_YJS_SYNC message (Update subtype 2)
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_YJS_SYNC);
      syncProtocol.writeUpdate(encoder, updateFromA!);
      const messagePayload = encoding.toUint8Array(encoder);

      // Deliver Client A's update message to server via handleIncomingMessage
      handleIncomingMessage(connA, room, Buffer.from(messagePayload));

      // Check server room.doc has received the update
      expect(room.doc.getText('content').toString()).toBe('Collaborative Text from Client A');

      // Check Client B's mock socket received the update broadcast
      expect(mockWsB.sentData.length).toBeGreaterThan(0);
      const lastBroadcast = mockWsB.sentData[mockWsB.sentData.length - 1];

      // Client B applies the broadcast update to its local Y.Doc
      const clientDocB = new Y.Doc();
      const decoder = decoding.createDecoder(lastBroadcast);
      const messageType = decoding.readVarUint(decoder);
      expect(messageType).toBe(MESSAGE_YJS_SYNC);

      const dummyReplyEncoder = encoding.createEncoder();
      syncProtocol.readSyncMessage(decoder, dummyReplyEncoder, clientDocB, null);

      expect(clientDocB.getText('content').toString()).toBe('Collaborative Text from Client A');

      // Ensure Client A did NOT get echoed its own update
      expect(mockWsA.sentData.length).toBe(0);
    });

    it('DROPS raw Yjs updates sent by a viewer (canEdit: false) and preserves room state', async () => {
      const room = await getOrCreateRoom('00000000-0000-0000-0000-00000000010v');

      const mockWsViewer = new MockWebSocket();
      const mockWsEditor = new MockWebSocket();

      const connViewer: ClientConnection = {
        id: 'conn-viewer',
        ws: mockWsViewer as unknown as WebSocket,
        userId: 'user-viewer',
        workspaceId: 'ws-1',
        documentId: '00000000-0000-0000-0000-00000000010v',
        canEdit: false,
        effectiveRole: 'viewer',
      };

      const connEditor: ClientConnection = {
        id: 'conn-editor',
        ws: mockWsEditor as unknown as WebSocket,
        userId: 'user-editor',
        workspaceId: 'ws-1',
        documentId: '00000000-0000-0000-0000-00000000010v',
        canEdit: true,
        effectiveRole: 'editor',
      };

      addConnectionToRoom(room, connViewer);
      addConnectionToRoom(room, connEditor);

      // Initial server content
      room.doc.getText('content').insert(0, 'Original Content');

      // Clear broadcast sent to connEditor from initial insert
      mockWsEditor.sentData = [];
      mockWsViewer.sentData = [];
      vi.clearAllMocks();

      // Malicious viewer attempts to inject unauthorized text edit via raw Yjs update frame
      const viewerDoc = new Y.Doc();
      let viewerUpdate: Uint8Array | null = null;
      viewerDoc.on('update', (u) => {
        viewerUpdate = u;
      });
      viewerDoc.getText('content').insert(0, 'HAX0R EDIT BY VIEWER ');

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_YJS_SYNC);
      syncProtocol.writeUpdate(encoder, viewerUpdate!);
      const viewerMessagePayload = encoding.toUint8Array(encoder);

      // Viewer sends raw update frame to server
      handleIncomingMessage(connViewer, room, Buffer.from(viewerMessagePayload));

      // Assert SERVER ROOM DOC REMAINS COMPLETELY UNCHANGED
      expect(room.doc.getText('content').toString()).toBe('Original Content');

      // Assert OTHER CLIENTS RECEIVED NO BROADCAST FROM VIEWER
      expect(mockWsEditor.sentData.length).toBe(0);

      // Assert SNAPSHOT WAS NOT PERSISTED
      expect(snapshotService.persistRecoverySnapshot).not.toHaveBeenCalled();
    });

    it('allows a viewer (canEdit: false) to initiate SyncStep1 and receive current document state', async () => {
      const room = await getOrCreateRoom('00000000-0000-0000-0000-00000000010v2');
      room.doc.getText('content').insert(0, 'Server Readonly Content');

      const mockWsViewer = new MockWebSocket();
      const connViewer: ClientConnection = {
        id: 'conn-viewer',
        ws: mockWsViewer as unknown as WebSocket,
        userId: 'user-viewer',
        workspaceId: 'ws-1',
        documentId: '00000000-0000-0000-0000-00000000010v2',
        canEdit: false,
        effectiveRole: 'viewer',
      };
      addConnectionToRoom(room, connViewer);

      // Viewer sends SyncStep1 to request server document state
      const viewerDoc = new Y.Doc();
      const syncStep1Encoder = encoding.createEncoder();
      encoding.writeVarUint(syncStep1Encoder, MESSAGE_YJS_SYNC);
      syncProtocol.writeSyncStep1(syncStep1Encoder, viewerDoc);

      handleIncomingMessage(connViewer, room, Buffer.from(encoding.toUint8Array(syncStep1Encoder)));

      // Server responds with SyncStep2 to viewer
      expect(mockWsViewer.sentData.length).toBe(1);
      const serverPayload = mockWsViewer.sentData[0];

      const decoder = decoding.createDecoder(serverPayload);
      decoding.readVarUint(decoder); // skip MESSAGE_YJS_SYNC
      syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), viewerDoc, null);

      // Viewer receives room state cleanly
      expect(viewerDoc.getText('content').toString()).toBe('Server Readonly Content');
    });

    it('handles malformed, corrupt, or invalid binary messages without throwing or crashing', async () => {
      const room = await getOrCreateRoom('00000000-0000-0000-0000-000000000110');
      const mockWs = new MockWebSocket();

      const conn: ClientConnection = {
        id: 'conn-bad',
        ws: mockWs as unknown as WebSocket,
        userId: 'user-bad',
        workspaceId: 'ws-1',
        documentId: '00000000-0000-0000-0000-000000000110',
        canEdit: true,
        effectiveRole: 'editor',
      };
      addConnectionToRoom(room, conn);

      // Send arbitrary corrupt bytes
      const corruptData = Buffer.from([0xff, 0xff, 0xff, 0xff]);
      expect(() => {
        handleIncomingMessage(conn, room, corruptData);
      }).not.toThrow();

      // Send empty buffer
      expect(() => {
        handleIncomingMessage(conn, room, Buffer.from([]));
      }).not.toThrow();

      // Room doc state remains intact
      expect(room.doc.getText('content').toString()).toBe('');
    });
  });

  describe('Phase 5 T3: Durable Persistence Acknowledgement & Flush Protocol', () => {
    it('broadcasts persisting and persisted packets when snapshot debounce fires', async () => {
      vi.useFakeTimers();
      const room = await getOrCreateRoom('00000000-0000-0000-0000-000000000120');
      const mockWs = new MockWebSocket();
      const conn: ClientConnection = {
        id: 'conn-persist-1',
        ws: mockWs as unknown as WebSocket,
        userId: 'user-persist-1',
        workspaceId: 'ws-1',
        documentId: '00000000-0000-0000-0000-000000000120',
        canEdit: true,
        effectiveRole: 'editor',
      };
      addConnectionToRoom(room, conn);

      // Trigger doc update
      room.doc.getText('content').insert(0, 'Content requiring persistence');

      // Fast-forward debounce timer
      await vi.advanceTimersByTimeAsync(2000);
      if (room.inFlightPersistence) {
        await room.inFlightPersistence;
      }

      // Verify WebSocket received persistence messages
      const persistenceMessages = mockWs.sentData
        .map((buf) => {
          const dec = decoding.createDecoder(buf);
          const type = decoding.readVarUint(dec);
          if (type === MESSAGE_PERSISTENCE) {
            return {
              status: decoding.readVarUint(dec),
              seq: decoding.readVarUint(dec),
            };
          }
          return null;
        })
        .filter(Boolean);

      expect(persistenceMessages).toContainEqual({
        status: PERSISTENCE_STATUS_PERSISTING,
        seq: expect.any(Number),
      });
      expect(persistenceMessages).toContainEqual({
        status: PERSISTENCE_STATUS_PERSISTED,
        seq: expect.any(Number),
      });
      expect(snapshotService.persistRecoverySnapshot).toHaveBeenCalledWith(
        '00000000-0000-0000-0000-000000000120',
        room.doc,
        expect.anything(),
      );
      vi.useRealTimers();
    });

    it('handles incoming MESSAGE_PERSISTENCE flush request from an editor immediately', async () => {
      const room = await getOrCreateRoom('00000000-0000-0000-0000-000000000121');
      const mockWs = new MockWebSocket();
      const conn: ClientConnection = {
        id: 'conn-flush-editor',
        ws: mockWs as unknown as WebSocket,
        userId: 'user-editor',
        workspaceId: 'ws-1',
        documentId: '00000000-0000-0000-0000-000000000121',
        canEdit: true,
        effectiveRole: 'editor',
      };
      addConnectionToRoom(room, conn);

      // Client sends flush request packet (MESSAGE_PERSISTENCE)
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_PERSISTENCE);
      const flushPayload = Buffer.from(encoding.toUint8Array(enc));

      handleIncomingMessage(conn, room, flushPayload);

      // Wait a tick for async flush
      await new Promise((r) => setTimeout(r, 10));

      // Check sent messages for persisting and persisted
      const persistenceStatuses = mockWs.sentData
        .map((buf) => {
          const dec = decoding.createDecoder(buf);
          const type = decoding.readVarUint(dec);
          if (type === MESSAGE_PERSISTENCE) {
            return decoding.readVarUint(dec);
          }
          return null;
        })
        .filter((s) => s !== null);

      expect(persistenceStatuses).toContain(PERSISTENCE_STATUS_PERSISTING);
      expect(persistenceStatuses).toContain(PERSISTENCE_STATUS_PERSISTED);
    });

    it('ignores incoming MESSAGE_PERSISTENCE flush request from a viewer (canEdit: false)', async () => {
      const room = await getOrCreateRoom('00000000-0000-0000-0000-000000000122');
      const mockWs = new MockWebSocket();
      const conn: ClientConnection = {
        id: 'conn-flush-viewer',
        ws: mockWs as unknown as WebSocket,
        userId: 'user-viewer',
        workspaceId: 'ws-1',
        documentId: '00000000-0000-0000-0000-000000000122',
        canEdit: false,
        effectiveRole: 'viewer',
      };
      addConnectionToRoom(room, conn);

      const persistSpy = vi.spyOn(snapshotService, 'persistRecoverySnapshot');
      persistSpy.mockClear();

      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_PERSISTENCE);
      const flushPayload = Buffer.from(encoding.toUint8Array(enc));

      handleIncomingMessage(conn, room, flushPayload);

      await new Promise((r) => setTimeout(r, 10));

      expect(persistSpy).not.toHaveBeenCalled();
      expect(mockWs.sentData.length).toBe(0);
    });

    it('broadcasts PERSISTENCE_STATUS_ERROR when snapshot persistence fails', async () => {
      vi.useFakeTimers();
      const room = await getOrCreateRoom('00000000-0000-0000-0000-000000000123');
      const mockWs = new MockWebSocket();
      const conn: ClientConnection = {
        id: 'conn-persist-err',
        ws: mockWs as unknown as WebSocket,
        userId: 'user-1',
        workspaceId: 'ws-1',
        documentId: '00000000-0000-0000-0000-000000000123',
        canEdit: true,
        effectiveRole: 'editor',
      };
      addConnectionToRoom(room, conn);

      vi.spyOn(snapshotService, 'persistRecoverySnapshot').mockRejectedValueOnce(
        new Error('Disk quota exceeded'),
      );

      // Trigger doc update
      room.doc.getText('content').insert(0, 'Failing content');

      // Fast-forward debounce
      await vi.advanceTimersByTimeAsync(2000);
      if (room.inFlightPersistence) {
        try {
          await room.inFlightPersistence;
        } catch {}
      }

      const errorMessages = mockWs.sentData
        .map((buf) => {
          const dec = decoding.createDecoder(buf);
          const type = decoding.readVarUint(dec);
          if (type === MESSAGE_PERSISTENCE) {
            const status = decoding.readVarUint(dec);
            const seq = decoding.readVarUint(dec);
            let msg = '';
            if (status === PERSISTENCE_STATUS_ERROR && decoding.hasContent(dec)) {
              msg = decoding.readVarString(dec);
            }
            return { status, seq, msg };
          }
          return null;
        })
        .filter((m) => m && m.status === PERSISTENCE_STATUS_ERROR);

      expect(errorMessages.length).toBeGreaterThan(0);
      expect(errorMessages[0]?.msg).toContain('Disk quota exceeded');
      vi.useRealTimers();
    });

    it('Test G: Manual flush while debounced persistence is pending cancels debounce and flushes immediately using same sequencing', async () => {
      vi.useFakeTimers();
      const room = await getOrCreateRoom('00000000-0000-0000-0000-000000000124');
      const mockWs = new MockWebSocket();
      const conn: ClientConnection = {
        id: 'conn-flush-pending',
        ws: mockWs as unknown as WebSocket,
        userId: 'user-1',
        workspaceId: 'ws-1',
        documentId: '00000000-0000-0000-0000-000000000124',
        canEdit: true,
        effectiveRole: 'editor',
      };
      addConnectionToRoom(room, conn);

      // Doc update triggers debounce timer (docSeq = 1)
      room.doc.getText('content').insert(0, 'Debounced text');
      expect(room.debounceTimer).not.toBeNull();
      expect(room.docSeq).toBe(1);

      // Client sends manual flush (e.g. Ctrl+S) BEFORE debounce fires
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_PERSISTENCE);
      handleIncomingMessage(conn, room, Buffer.from(encoding.toUint8Array(enc)));

      // Debounce timer should be cleared immediately
      expect(room.debounceTimer).toBeNull();

      // Wait a tick for async flush
      await vi.advanceTimersByTimeAsync(10);
      if (room.inFlightPersistence) {
        await room.inFlightPersistence;
      }

      const packets = mockWs.sentData
        .map((buf) => {
          const dec = decoding.createDecoder(buf);
          if (decoding.readVarUint(dec) === MESSAGE_PERSISTENCE) {
            return {
              status: decoding.readVarUint(dec),
              seq: decoding.readVarUint(dec),
            };
          }
          return null;
        })
        .filter(Boolean);

      expect(packets).toEqual([
        { status: PERSISTENCE_STATUS_PERSISTING, seq: 1 },
        { status: PERSISTENCE_STATUS_PERSISTED, seq: 1 },
      ]);

      vi.useRealTimers();
    });

    it('Test J: Serializes overlapping persistence operations per room and never broadcasts stale acknowledgements out-of-order', async () => {
      const room = await getOrCreateRoom('00000000-0000-0000-0000-000000000125');
      const mockWs = new MockWebSocket();
      const conn: ClientConnection = {
        id: 'conn-serial-test',
        ws: mockWs as unknown as WebSocket,
        userId: 'user-1',
        workspaceId: 'ws-1',
        documentId: '00000000-0000-0000-0000-000000000125',
        canEdit: true,
        effectiveRole: 'editor',
      };
      addConnectionToRoom(room, conn);

      let resolveSnap1: () => void = () => {};
      let resolveSnap2: () => void = () => {};
      let snapCallCount = 0;

      vi.spyOn(snapshotService, 'persistRecoverySnapshot').mockImplementation(async () => {
        snapCallCount++;
        const currentCount = snapCallCount;
        return new Promise<void>((res) => {
          if (currentCount === 1) {
            resolveSnap1 = res;
          } else {
            resolveSnap2 = res;
          }
        });
      });

      // 1. Edit 1 (docSeq = 1)
      room.doc.getText('content').insert(0, 'Edit 1');
      const flush1Promise = flushRoomPersistence(room);

      // Wait a tick for withDocumentLock acquisition
      while (snapCallCount === 0) {
        await new Promise((r) => setTimeout(r, 5));
      }

      // Verify snap 1 started
      expect(snapCallCount).toBe(1);
      expect(room.inFlightPersistence).not.toBeNull();

      // 2. Edit 2 (docSeq = 2) while snap 1 is in-flight!
      room.doc.getText('content').insert(6, ' Edit 2');
      const flush2Promise = flushRoomPersistence(room);

      // Server must NOT run snap 2 concurrently; it queues it!
      expect(snapCallCount).toBe(1);
      expect(room.queuedPersistenceSeq).toBe(2);

      // 3. Resolve snap 1
      resolveSnap1();
      await flush1Promise;

      // Now snap 1 finished, server automatically starts queued snap 2!
      while (snapCallCount < 2) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(snapCallCount).toBe(2);

      // 4. Resolve snap 2
      resolveSnap2();
      await flush2Promise;

      const packets = mockWs.sentData
        .map((buf) => {
          const dec = decoding.createDecoder(buf);
          if (decoding.readVarUint(dec) === MESSAGE_PERSISTENCE) {
            return {
              status: decoding.readVarUint(dec),
              seq: decoding.readVarUint(dec),
            };
          }
          return null;
        })
        .filter(Boolean);

      // Strictly ordered monotonic sequence: PERSISTING(1) -> PERSISTED(1) -> PERSISTING(2) -> PERSISTED(2)
      expect(packets).toEqual([
        { status: PERSISTENCE_STATUS_PERSISTING, seq: 1 },
        { status: PERSISTENCE_STATUS_PERSISTED, seq: 1 },
        { status: PERSISTENCE_STATUS_PERSISTING, seq: 2 },
        { status: PERSISTENCE_STATUS_PERSISTED, seq: 2 },
      ]);
      expect(room.lastPersistedSeq).toBe(2);
    });
  });
});
