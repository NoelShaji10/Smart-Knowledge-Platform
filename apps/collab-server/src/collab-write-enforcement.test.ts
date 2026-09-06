import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import WebSocket from 'ws';
import EventEmitter from 'events';

import { handleIncomingMessage } from './server';
import {
  getOrCreateRoom,
  clearAllRooms,
  addConnectionToRoom,
  ClientConnection,
  MESSAGE_YJS_SYNC,
} from './room-manager';
import * as storage from '@knowledge/storage';
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

describe('Security Invariant: Collaboration Viewer Write Enforcement (T5)', () => {
  beforeEach(() => {
    clearAllRooms();
    vi.spyOn(storage, 'loadRecoverySnapshot').mockResolvedValue(null);
    vi.spyOn(storage, 'saveRecoverySnapshot').mockResolvedValue('snapshots/test/latest.yjs');
    vi.spyOn(snapshotService, 'persistRecoverySnapshot').mockResolvedValue();
    vi.spyOn(snapshotService, 'createVersionCheckpointOnSessionEnd').mockResolvedValue();
  });

  afterEach(() => {
    clearAllRooms();
    vi.restoreAllMocks();
  });

  it('enforces server-side drop of Yjs update frames sent by a viewer connection (before === after proof)', async () => {
    const docId = '00000000-0000-0000-0000-000000000501';
    const room = await getOrCreateRoom(docId);

    const mockWsViewer = new MockWebSocket();
    const mockWsEditor = new MockWebSocket();

    const connViewer: ClientConnection = {
      id: 'conn-viewer-1',
      ws: mockWsViewer as unknown as WebSocket,
      userId: 'user-viewer-id',
      workspaceId: 'ws-1',
      documentId: docId,
      canEdit: false,
      effectiveRole: 'viewer',
    };

    const connEditor: ClientConnection = {
      id: 'conn-editor-1',
      ws: mockWsEditor as unknown as WebSocket,
      userId: 'user-editor-id',
      workspaceId: 'ws-1',
      documentId: docId,
      canEdit: true,
      effectiveRole: 'editor',
    };

    addConnectionToRoom(room, connViewer);
    addConnectionToRoom(room, connEditor);

    // Initial server document content
    const initialText = 'Authoritative Document State v1.0';
    room.doc.getText('content').insert(0, initialText);
    const stateBefore = room.doc.getText('content').toString();

    // Reset sentData from initial insert broadcast
    mockWsEditor.sentData = [];
    mockWsViewer.sentData = [];
    vi.clearAllMocks();

    // Malicious viewer constructs a Yjs document update attempt
    const maliciousDoc = new Y.Doc();
    let maliciousUpdate: Uint8Array | null = null;
    maliciousDoc.on('update', (u) => {
      maliciousUpdate = u;
    });
    maliciousDoc.getText('content').insert(0, 'MALICIOUS OVERWRITE BY VIEWER! ');

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_YJS_SYNC);
    syncProtocol.writeUpdate(encoder, maliciousUpdate!);
    const rawFrame = encoding.toUint8Array(encoder);

    // Viewer sends raw Yjs update frame to server
    handleIncomingMessage(connViewer, room, Buffer.from(rawFrame));

    const stateAfter = room.doc.getText('content').toString();

    // 1. PROOF: Server Y.Doc state remains completely unchanged
    expect(stateAfter).toBe(stateBefore);
    expect(stateAfter).toBe('Authoritative Document State v1.0');

    // 2. PROOF: Other collaborators in the room received 0 update messages originating from viewer
    expect(mockWsEditor.sentData.length).toBe(0);

    // 3. PROOF: Persistence snapshot was NOT triggered by rejected viewer update
    expect(snapshotService.persistRecoverySnapshot).not.toHaveBeenCalled();
  });

  it('allows authorized editors to mutate server Y.Doc and broadcast updates', async () => {
    const docId = '00000000-0000-0000-0000-000000000502';
    const room = await getOrCreateRoom(docId);

    const mockWsViewer = new MockWebSocket();
    const mockWsEditor = new MockWebSocket();

    const connViewer: ClientConnection = {
      id: 'conn-viewer-2',
      ws: mockWsViewer as unknown as WebSocket,
      userId: 'user-viewer-id',
      workspaceId: 'ws-1',
      documentId: docId,
      canEdit: false,
      effectiveRole: 'viewer',
    };

    const connEditor: ClientConnection = {
      id: 'conn-editor-2',
      ws: mockWsEditor as unknown as WebSocket,
      userId: 'user-editor-id',
      workspaceId: 'ws-1',
      documentId: docId,
      canEdit: true,
      effectiveRole: 'editor',
    };

    addConnectionToRoom(room, connViewer);
    addConnectionToRoom(room, connEditor);

    mockWsViewer.sentData = [];
    mockWsEditor.sentData = [];

    // Editor sends legitimate edit
    const editorDoc = new Y.Doc();
    let editorUpdate: Uint8Array | null = null;
    editorDoc.on('update', (u) => {
      editorUpdate = u;
    });
    editorDoc.getText('content').insert(0, 'Legitimate Edit by Editor');

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_YJS_SYNC);
    syncProtocol.writeUpdate(encoder, editorUpdate!);
    const rawFrame = encoding.toUint8Array(encoder);

    handleIncomingMessage(connEditor, room, Buffer.from(rawFrame));

    // Server Y.Doc is updated
    expect(room.doc.getText('content').toString()).toBe('Legitimate Edit by Editor');

    // Viewer receives the broadcasted editor update
    expect(mockWsViewer.sentData.length).toBe(1);
    const broadcastFrame = mockWsViewer.sentData[0];

    const viewerDoc = new Y.Doc();
    const decoder = decoding.createDecoder(broadcastFrame);
    decoding.readVarUint(decoder); // skip MESSAGE_YJS_SYNC
    syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), viewerDoc, null);

    expect(viewerDoc.getText('content').toString()).toBe('Legitimate Edit by Editor');
  });
});
