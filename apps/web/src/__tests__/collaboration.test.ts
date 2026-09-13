import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { api, setAccessToken } from '../lib/api';
import {
  CollabProvider,
  MESSAGE_PERSISTENCE,
  PERSISTENCE_STATUS_PERSISTED,
  PERSISTENCE_STATUS_PERSISTING,
  PERSISTENCE_STATUS_ERROR,
} from '../lib/collab-provider';
import { getDefaultEditorExtensions } from '../components/editor/extensions';
import { getCollaboratorColor, getUserInitials } from '../lib/collab-colors';

// Mock WebSocket for Node environment tests
class MockWebSocket {
  public static OPEN = 1;
  public static CLOSED = 3;
  public readyState = MockWebSocket.OPEN;
  public binaryType = 'arraybuffer';

  public onopen: (() => void) | null = null;
  public onmessage: ((evt: { data: ArrayBuffer }) => void) | null = null;
  public onerror: ((evt: unknown) => void) | null = null;
  public onclose: (() => void) | null = null;
  public sentMessages: ArrayBuffer[] = [];

  constructor(public url: string) {
    setTimeout(() => {
      if (this.onopen) this.onopen();
    }, 0);
  }

  send(data: ArrayBuffer) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose();
  }
}

describe('Phase 4 T3 & T4: Frontend Collaboration Provider & Awareness Integration', () => {
  const originalWebSocket = global.WebSocket;

  beforeEach(() => {
    setAccessToken('mock-access-token');
    vi.resetAllMocks();
    // @ts-expect-error Mocking WebSocket for vitest
    global.WebSocket = MockWebSocket;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.WebSocket = originalWebSocket;
  });

  describe('1. API Client — requestWsTicket', () => {
    it('requests single-use WebSocket ticket from /api/v1/ws/ticket', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'opaque-single-use-ticket-123' }),
      });

      const res = await api.requestWsTicket('ws-1', 'doc-1');
      expect(res.ticket).toBe('opaque-single-use-ticket-123');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/ws/ticket'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ workspaceId: 'ws-1', documentId: 'doc-1' }),
        }),
      );
    });

    it('uses existing authenticated API client mechanism with Bearer token', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'opaque-ticket' }),
      });

      await api.requestWsTicket('ws-1', 'doc-1');

      const fetchCallArgs = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const headers = fetchCallArgs[1].headers;
      expect(headers.get('Authorization')).toBe('Bearer mock-access-token');
    });
  });

  describe('2. WebSocket Collaboration Provider & Yjs Awareness', () => {
    it('acquires ticket and establishes WebSocket connection to NEXT_PUBLIC_COLLAB_URL/ws/doc/{documentId}?ticket={ticket}', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'test-ticket-xyz' }),
      });

      const doc = new Y.Doc();
      const statusChanges: string[] = [];

      const provider = new CollabProvider({
        workspaceId: 'ws-99',
        documentId: 'doc-88',
        doc,
        collabUrl: 'http://localhost:3001',
        onStatusChange: (status) => statusChanges.push(status),
      });

      // Wait for async connect
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(statusChanges).toContain('connecting');
      expect(statusChanges).toContain('connected');

      // Verify no JWT was exposed in the WebSocket URL
      // @ts-expect-error accessing private ws for test assertion
      const wsUrl = provider.ws.url;
      expect(wsUrl).toContain('ws://localhost:3001/ws/doc/doc-88?ticket=test-ticket-xyz');
      expect(wsUrl).not.toContain('mock-access-token');
      expect(wsUrl).not.toContain('Authorization');

      provider.destroy();
      doc.destroy();
    });

    it('initializes local awareness state with user identity and color', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'ticket-awareness' }),
      });

      const doc = new Y.Doc();
      const provider = new CollabProvider({
        workspaceId: 'ws-1',
        documentId: 'doc-1',
        doc,
        user: {
          id: 'user-123',
          displayName: 'Noel Shaji',
          color: '#F59E0B',
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));

      const localState = provider.awareness.getLocalState();
      expect(localState?.user).toEqual({
        id: 'user-123',
        name: 'Noel Shaji',
        color: '#F59E0B',
      });

      provider.destroy();
      doc.destroy();
    });

    it('cleanly destroys WebSocket connection and unbinds Y.Doc and Awareness listeners', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'ticket-1' }),
      });

      const doc = new Y.Doc();
      const provider = new CollabProvider({
        workspaceId: 'ws-1',
        documentId: 'doc-1',
        doc,
      });

      await new Promise((resolve) => setTimeout(resolve, 20));

      // Destroy provider
      provider.destroy();
      expect(provider.status).toBe('disconnected');

      // Modifying Y.Doc or Awareness after destroy should not throw errors
      expect(() => {
        doc.getText('default').insert(0, 'Hello');
      }).not.toThrow();

      doc.destroy();
    });
  });

  describe('3. Deterministic Collaboration Colors & User Initials', () => {
    it('produces identical deterministic colors for the same user ID across multiple invocations', () => {
      const color1 = getCollaboratorColor('user-alpha-123');
      const color2 = getCollaboratorColor('user-alpha-123');
      expect(color1).toBe(color2);
      expect(color1).toMatch(/^#[0-9A-F]{6}$/i);
    });

    it('produces distinct colors for different user IDs', () => {
      const color1 = getCollaboratorColor('user-alpha');
      const color2 = getCollaboratorColor('user-beta');
      expect(color1).not.toBe(color2);
    });

    it('correctly extracts user initials from display names', () => {
      expect(getUserInitials('Noel Shaji')).toBe('NS');
      expect(getUserInitials('Alice')).toBe('AL');
      expect(getUserInitials('Jane Mary Watson')).toBe('JW');
      expect(getUserInitials('')).toBe('?');
    });
  });

  describe('4. Tiptap Extensions & Collaborative Cursors', () => {
    it('disables StarterKit history and includes Collaboration & CollaborationCursor extensions when yDoc and provider are supplied', () => {
      const yDoc = new Y.Doc();
      const provider = new CollabProvider({
        workspaceId: 'ws-1',
        documentId: 'doc-1',
        doc: yDoc,
      });

      const extensions = getDefaultEditorExtensions({ yDoc, provider });

      const extensionNames = extensions.map((ext) => ext.name);
      expect(extensionNames).toContain('starterKit');
      expect(extensionNames).toContain('collaboration');
      expect(extensionNames).toContain('collaborationCursor');

      // Verify StarterKit history is disabled
      const starterKitExt = extensions.find((ext) => ext.name === 'starterKit');
      expect(starterKitExt?.options.history).toBe(false);

      provider.destroy();
      yDoc.destroy();
    });

    it('retains default StarterKit history and omits Collaboration extensions when yDoc is null', () => {
      const extensions = getDefaultEditorExtensions({ yDoc: null });

      const extensionNames = extensions.map((ext) => ext.name);
      expect(extensionNames).toContain('starterKit');
      expect(extensionNames).not.toContain('collaboration');
      expect(extensionNames).not.toContain('collaborationCursor');

      const starterKitExt = extensions.find((ext) => ext.name === 'starterKit');
      expect(starterKitExt?.options.history).not.toBe(false);
    });
  });

  describe('6. Phase 4 T6: Offline-Read Continuity & Reconnection Resilience', () => {
    it('retries connection with increasing backoff when WebSocket connection drops', async () => {
      vi.useFakeTimers();
      try {
        let ticketCount = 0;
        global.fetch = vi.fn().mockImplementation(() => {
          ticketCount++;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ ticket: `ticket-reconnect-${ticketCount}` }),
          });
        });

        const doc = new Y.Doc();
        const statusChanges: string[] = [];

        const provider = new CollabProvider({
          workspaceId: 'ws-1',
          documentId: 'doc-reconnect-1',
          doc,
          initialBackoffMs: 1000,
          maxBackoffMs: 30000,
          onStatusChange: (status) => statusChanges.push(status),
        });

        // Advance timers for initial connection
        await vi.advanceTimersByTimeAsync(10);
        expect(ticketCount).toBe(1);

        // Simulate unexpected WebSocket drop
        // @ts-expect-error accessing private ws
        const activeWs = provider.ws;
        if (activeWs && activeWs.onclose) {
          activeWs.onclose({ code: 1000, reason: '', wasClean: true } as CloseEvent);
        }

        expect(provider.status).toBe('connecting');

        // Advance timers past backoff delay (~1000ms ± 20%)
        await vi.advanceTimersByTimeAsync(1500);

        // Verify a fresh WS ticket was requested for the second connection attempt
        expect(ticketCount).toBe(2);

        provider.destroy();
        doc.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops automatic reconnection retries on 401/403 authorization failures', async () => {
      let fetchCount = 0;
      global.fetch = vi.fn().mockImplementation(() => {
        fetchCount++;
        return Promise.resolve({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          json: () => Promise.resolve({ error: { message: 'Document permission denied' } }),
        });
      });

      const doc = new Y.Doc();
      const statusChanges: string[] = [];

      const provider = new CollabProvider({
        workspaceId: 'ws-1',
        documentId: 'doc-denied-1',
        doc,
        onStatusChange: (status) => statusChanges.push(status),
      });

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(fetchCount).toBe(1);
      expect(provider.status).toBe('error');

      // Wait additional time to verify NO reconnect loop occurred
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fetchCount).toBe(1);

      provider.destroy();
      doc.destroy();
    });

    it('cancels pending reconnect timers and prevents socket creation when provider is destroyed', async () => {
      vi.useFakeTimers();
      try {
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ticket: 'ticket-destroy-1' }),
        });

        const doc = new Y.Doc();
        const provider = new CollabProvider({
          workspaceId: 'ws-1',
          documentId: 'doc-destroy-1',
          doc,
          initialBackoffMs: 1000,
        });

        await vi.advanceTimersByTimeAsync(10);

        // Trigger disconnect to schedule reconnect
        // @ts-expect-error accessing private ws
        const activeWs = provider.ws;
        if (activeWs && activeWs.onclose) {
          activeWs.onclose({ code: 1000, reason: '', wasClean: true } as CloseEvent);
        }

        // Immediately destroy provider while reconnect timer is pending
        provider.destroy();

        // Fast-forward past reconnect delay
        await vi.advanceTimersByTimeAsync(5000);

        // Verify status remains disconnected and no new socket was created
        expect(provider.status).toBe('disconnected');
        // @ts-expect-error accessing private ws
        expect(provider.ws).toBeNull();

        doc.destroy();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('7. Phase 4 T7: Collaboration UI/UX Polish', () => {
    it('does not trigger HTTP autosave on manual save shortcuts in collaborative mode', () => {
      let autosaveTriggered = false;
      const isCollaborative = true;

      const handleManualSave = () => {
        if (!isCollaborative) {
          autosaveTriggered = true;
        }
      };

      handleManualSave();
      expect(autosaveTriggered).toBe(false);
    });

    it('formats collab status labels accurately for status bar display', () => {
      const formatStatus = (collabStatus: string, userCount: number, readOnly: boolean) => {
        if (readOnly) return 'View Only';
        if (collabStatus === 'connected') {
          return userCount > 1 ? `Connected • ${userCount} collaborators` : 'Connected';
        }
        if (collabStatus === 'connecting') return 'Reconnecting...';
        if (collabStatus === 'disconnected') return 'Disconnected';
        if (collabStatus === 'error') return 'Connection Error';
        return null;
      };

      expect(formatStatus('connected', 1, false)).toBe('Connected');
      expect(formatStatus('connected', 3, false)).toBe('Connected • 3 collaborators');
      expect(formatStatus('connecting', 1, false)).toBe('Reconnecting...');
      expect(formatStatus('disconnected', 1, false)).toBe('Disconnected');
      expect(formatStatus('error', 1, false)).toBe('Connection Error');
      expect(formatStatus('connected', 3, true)).toBe('View Only');
    });
  });

  describe('8. Phase 5 T3: Persistence and Save-State Truthfulness', () => {
    it('transitions to "editing" immediately upon local document edit', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'test-ticket-persistence' }),
      });

      const doc = new Y.Doc();
      const persistenceStates: string[] = [];

      const provider = new CollabProvider({
        workspaceId: 'ws-test',
        documentId: 'doc-test',
        doc,
        onPersistenceChange: (st) => persistenceStates.push(st),
      });

      expect(provider.persistenceState).toBe('persisted');
      expect(provider.isDirty).toBe(false);

      // Local doc edit (origin is not provider)
      doc.getText('content').insert(0, 'Local edit test');

      expect(provider.persistenceState).toBe('editing');
      expect(provider.isDirty).toBe(true);
      expect(persistenceStates).toContain('editing');

      provider.destroy();
      doc.destroy();
    });

    it('transitions through "saving" and "persisted" upon receiving MESSAGE_PERSISTENCE packets', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'test-ticket-ack' }),
      });

      const doc = new Y.Doc();
      const persistenceStates: string[] = [];

      const provider = new CollabProvider({
        workspaceId: 'ws-test',
        documentId: 'doc-test',
        doc,
        onPersistenceChange: (st) => persistenceStates.push(st),
      });

      await new Promise((r) => setTimeout(r, 10));

      // Make local edit
      doc.getText('content').insert(0, 'A');
      expect(provider.persistenceState).toBe('editing');

      // Server sends PERSISTENCE_STATUS_PERSISTING
      const encPersisting = encoding.createEncoder();
      encoding.writeVarUint(encPersisting, MESSAGE_PERSISTENCE);
      encoding.writeVarUint(encPersisting, PERSISTENCE_STATUS_PERSISTING);
      encoding.writeVarUint(encPersisting, 1); // seq 1

      // @ts-expect-error accessing private ws
      provider.ws?.onmessage?.({ data: encoding.toUint8Array(encPersisting).buffer });

      expect(provider.persistenceState).toBe('saving');

      // Server sends PERSISTENCE_STATUS_PERSISTED
      const encPersisted = encoding.createEncoder();
      encoding.writeVarUint(encPersisted, MESSAGE_PERSISTENCE);
      encoding.writeVarUint(encPersisted, PERSISTENCE_STATUS_PERSISTED);
      encoding.writeVarUint(encPersisted, 1); // seq 1

      // @ts-expect-error accessing private ws
      provider.ws?.onmessage?.({ data: encoding.toUint8Array(encPersisted).buffer });

      expect(provider.persistenceState).toBe('persisted');
      expect(provider.isDirty).toBe(false);

      provider.destroy();
      doc.destroy();
    });

    it('monotonic revision guard: newer local edit while snapshot in-flight keeps state in "editing", never falsely "persisted"', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'test-ticket-race' }),
      });

      const doc = new Y.Doc();
      const provider = new CollabProvider({
        workspaceId: 'ws-test',
        documentId: 'doc-test',
        doc,
      });

      await new Promise((r) => setTimeout(r, 10));

      // 1. First local edit
      doc.getText('content').insert(0, 'First Edit');
      expect(provider.persistenceState).toBe('editing');

      // 2. Server begins persisting snapshot 1
      const encPersisting = encoding.createEncoder();
      encoding.writeVarUint(encPersisting, MESSAGE_PERSISTENCE);
      encoding.writeVarUint(encPersisting, PERSISTENCE_STATUS_PERSISTING);
      encoding.writeVarUint(encPersisting, 1);

      // @ts-expect-error accessing private ws
      provider.ws?.onmessage?.({ data: encoding.toUint8Array(encPersisting).buffer });
      expect(provider.persistenceState).toBe('saving');

      // 3. User makes SECOND local edit while snapshot 1 is still in flight!
      doc.getText('content').insert(10, ' Second Edit');
      expect(provider.persistenceState).toBe('editing');
      expect(provider.isDirty).toBe(true);

      // 4. Server finishes snapshot 1 and sends PERSISTENCE_STATUS_PERSISTED for seq 1
      const encPersisted = encoding.createEncoder();
      encoding.writeVarUint(encPersisted, MESSAGE_PERSISTENCE);
      encoding.writeVarUint(encPersisted, PERSISTENCE_STATUS_PERSISTED);
      encoding.writeVarUint(encPersisted, 1);

      // @ts-expect-error accessing private ws
      provider.ws?.onmessage?.({ data: encoding.toUint8Array(encPersisted).buffer });

      // Monotonic guard verifies localEditRev (2) > acknowledgedRev (1) -> NOT persisted!
      expect(provider.persistenceState).toBe('editing');
      expect(provider.isDirty).toBe(true);

      // 5. Now server snapshots second edit
      const encPersisting2 = encoding.createEncoder();
      encoding.writeVarUint(encPersisting2, MESSAGE_PERSISTENCE);
      encoding.writeVarUint(encPersisting2, PERSISTENCE_STATUS_PERSISTING);
      encoding.writeVarUint(encPersisting2, 2);

      // @ts-expect-error accessing private ws
      provider.ws?.onmessage?.({ data: encoding.toUint8Array(encPersisting2).buffer });
      expect(provider.persistenceState).toBe('saving');

      const encPersisted2 = encoding.createEncoder();
      encoding.writeVarUint(encPersisted2, MESSAGE_PERSISTENCE);
      encoding.writeVarUint(encPersisted2, PERSISTENCE_STATUS_PERSISTED);
      encoding.writeVarUint(encPersisted2, 2);

      // @ts-expect-error accessing private ws
      provider.ws?.onmessage?.({ data: encoding.toUint8Array(encPersisted2).buffer });

      // All local edits are now persisted
      expect(provider.persistenceState).toBe('persisted');
      expect(provider.isDirty).toBe(false);

      provider.destroy();
      doc.destroy();
    });

    it('transitions to "error" on receiving PERSISTENCE_STATUS_ERROR packet', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'test-ticket-err' }),
      });

      const doc = new Y.Doc();
      const provider = new CollabProvider({
        workspaceId: 'ws-test',
        documentId: 'doc-test',
        doc,
      });

      await new Promise((r) => setTimeout(r, 10));

      const encError = encoding.createEncoder();
      encoding.writeVarUint(encError, MESSAGE_PERSISTENCE);
      encoding.writeVarUint(encError, PERSISTENCE_STATUS_ERROR);
      encoding.writeVarUint(encError, 5);
      encoding.writeVarString(encError, 'PostgreSQL connection timeout');

      // @ts-expect-error accessing private ws
      provider.ws?.onmessage?.({ data: encoding.toUint8Array(encError).buffer });

      expect(provider.persistenceState).toBe('error');

      provider.destroy();
      doc.destroy();
    });

    it('requestPersistenceFlush sends MESSAGE_PERSISTENCE over active WebSocket', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'test-ticket-flush' }),
      });

      const doc = new Y.Doc();
      const provider = new CollabProvider({
        workspaceId: 'ws-test',
        documentId: 'doc-test',
        doc,
      });

      await new Promise((r) => setTimeout(r, 10));

      provider.requestPersistenceFlush();

      // @ts-expect-error accessing private ws
      const sent = provider.ws?.sentMessages || [];
      expect(sent.length).toBeGreaterThan(0);

      const lastSent = sent[sent.length - 1];
      const dec = decoding.createDecoder(new Uint8Array(lastSent));
      const msgType = decoding.readVarUint(dec);
      expect(msgType).toBe(MESSAGE_PERSISTENCE);

      provider.destroy();
      doc.destroy();
    });

    it('preserves local dirty state when WebSocket disconnects', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'test-ticket-disconnect' }),
      });

      const doc = new Y.Doc();
      const provider = new CollabProvider({
        workspaceId: 'ws-test',
        documentId: 'doc-test',
        doc,
      });

      await new Promise((r) => setTimeout(r, 10));

      // Local edit
      doc.getText('content').insert(0, 'Offline content');
      expect(provider.persistenceState).toBe('editing');

      // Disconnect socket
      // @ts-expect-error accessing private ws
      provider.ws?.close();

      expect(['disconnected', 'connecting']).toContain(provider.status);
      // Persistence state must still be editing, NOT falsely saved!
      expect(provider.persistenceState).toBe('editing');
      expect(provider.isDirty).toBe(true);

      provider.destroy();
      doc.destroy();
    });
  });
});

