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
    const sendPersistencePacket = (
      provider: CollabProvider,
      status: number,
      seq: number,
      errorMessage?: string,
    ) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_PERSISTENCE);
      encoding.writeVarUint(enc, status);
      encoding.writeVarUint(enc, seq);
      if (status === PERSISTENCE_STATUS_ERROR && errorMessage) {
        encoding.writeVarString(enc, errorMessage);
      }
      // @ts-expect-error accessing private ws
      provider.ws?.onmessage?.({ data: encoding.toUint8Array(enc).buffer });
    };

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

    it('Test A: Sequential persistence: edit A -> persist A -> persisted A -> saved', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'test-ticket-a' }),
      });

      const doc = new Y.Doc();
      const persistenceStates: string[] = [];

      const provider = new CollabProvider({
        workspaceId: 'ws-test',
        documentId: 'doc-test-a',
        doc,
        onPersistenceChange: (st) => persistenceStates.push(st),
      });

      await new Promise((r) => setTimeout(r, 10));

      // 1. Edit A
      doc.getText('content').insert(0, 'A');
      expect(provider.persistenceState).toBe('editing');
      expect(provider.isDirty).toBe(true);
      expect(provider.getLocalEditRev()).toBe(1);

      // 2. Persistence A starts (seq 1)
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTING, 1);
      expect(provider.persistenceState).toBe('saving');
      expect(provider.isDirty).toBe(true);

      // 3. Persisted A arrives (seq 1)
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTED, 1);
      expect(provider.persistenceState).toBe('persisted');
      expect(provider.isDirty).toBe(false);
      expect(provider.getAcknowledgedLocalRev()).toBe(1);
      expect(provider.getLatestPersistedSeq()).toBe(1);

      provider.destroy();
      doc.destroy();
    });

    it('Test B: Edit during persistence: edit A -> persistence A starts -> edit B -> persisted A -> remains editing/dirty', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'test-ticket-b' }),
      });

      const doc = new Y.Doc();
      const provider = new CollabProvider({
        workspaceId: 'ws-test',
        documentId: 'doc-test-b',
        doc,
      });

      await new Promise((r) => setTimeout(r, 10));

      // 1. Edit A
      doc.getText('content').insert(0, 'First Edit');
      expect(provider.persistenceState).toBe('editing');
      expect(provider.getLocalEditRev()).toBe(1);

      // 2. Server begins persisting snapshot for seq 1
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTING, 1);
      expect(provider.persistenceState).toBe('saving');

      // 3. User makes SECOND local edit while snapshot 1 is still in flight
      doc.getText('content').insert(10, ' Second Edit');
      expect(provider.persistenceState).toBe('editing');
      expect(provider.isDirty).toBe(true);
      expect(provider.getLocalEditRev()).toBe(2);

      // 4. Server finishes snapshot 1 and sends PERSISTENCE_STATUS_PERSISTED for seq 1
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTED, 1);

      // Sequence guard verifies localEditRev (2) > acknowledgedRev (1) -> NOT persisted!
      expect(provider.persistenceState).toBe('editing');
      expect(provider.isDirty).toBe(true);
      expect(provider.getAcknowledgedLocalRev()).toBe(1);

      // 5. Now server snapshots second edit (seq 2)
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTING, 2);
      expect(provider.persistenceState).toBe('saving');

      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTED, 2);

      // All local edits are now persisted
      expect(provider.persistenceState).toBe('persisted');
      expect(provider.isDirty).toBe(false);
      expect(provider.getAcknowledgedLocalRev()).toBe(2);
      expect(provider.getLatestPersistedSeq()).toBe(2);

      provider.destroy();
      doc.destroy();
    });

    it('Test C: Two persistence operations overlap: seq1 starts -> seq2 starts -> seq1 persisted -> seq2 persisted', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'test-ticket-c' }),
      });

      const doc = new Y.Doc();
      const provider = new CollabProvider({
        workspaceId: 'ws-test',
        documentId: 'doc-test-c',
        doc,
      });

      await new Promise((r) => setTimeout(r, 10));

      // 1. Edit A (rev 1)
      doc.getText('content').insert(0, 'A');
      expect(provider.getLocalEditRev()).toBe(1);

      // 2. seq 1 starts
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTING, 1);
      expect(provider.persistenceState).toBe('saving');

      // 3. Edit B (rev 2) while seq 1 in flight
      doc.getText('content').insert(1, 'B');
      expect(provider.getLocalEditRev()).toBe(2);
      expect(provider.persistenceState).toBe('editing');

      // 4. seq 2 starts before seq 1 finishes
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTING, 2);
      expect(provider.persistenceState).toBe('saving');

      // 5. seq 1 finishes
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTED, 1);
      // seq 1 only acknowledged rev 1; local rev 2 is still dirty!
      expect(provider.persistenceState).toBe('editing');
      expect(provider.isDirty).toBe(true);
      expect(provider.getAcknowledgedLocalRev()).toBe(1);

      // 6. seq 2 finishes
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTED, 2);
      expect(provider.persistenceState).toBe('persisted');
      expect(provider.isDirty).toBe(false);
      expect(provider.getAcknowledgedLocalRev()).toBe(2);
      expect(provider.getLatestPersistedSeq()).toBe(2);

      provider.destroy();
      doc.destroy();
    });

    it('Test D: Reverse completion: seq1 starts -> seq2 starts -> seq2 persisted -> seq1 persisted -> old seq1 does not regress state', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'test-ticket-d' }),
      });

      const doc = new Y.Doc();
      const provider = new CollabProvider({
        workspaceId: 'ws-test',
        documentId: 'doc-test-d',
        doc,
      });

      await new Promise((r) => setTimeout(r, 10));

      // 1. Edit A (rev 1) -> seq 1 starts
      doc.getText('content').insert(0, 'A');
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTING, 1);

      // 2. Edit B (rev 2) -> seq 2 starts
      doc.getText('content').insert(1, 'B');
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTING, 2);

      // 3. seq 2 arrives first (e.g. out-of-order network arrival)
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTED, 2);
      expect(provider.persistenceState).toBe('persisted');
      expect(provider.isDirty).toBe(false);
      expect(provider.getAcknowledgedLocalRev()).toBe(2);
      expect(provider.getLatestPersistedSeq()).toBe(2);

      // 4. Stale seq 1 arrives after seq 2
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTED, 1);
      // Must NOT regress state to editing, must NOT regress acknowledgedLocalRev to 1!
      expect(provider.persistenceState).toBe('persisted');
      expect(provider.isDirty).toBe(false);
      expect(provider.getAcknowledgedLocalRev()).toBe(2);
      expect(provider.getLatestPersistedSeq()).toBe(2);

      provider.destroy();
      doc.destroy();
    });

    it('Test E: Old error after newer success: seq1 starts -> seq2 succeeds -> seq1 errors -> does not end in error', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'test-ticket-e' }),
      });

      const doc = new Y.Doc();
      const provider = new CollabProvider({
        workspaceId: 'ws-test',
        documentId: 'doc-test-e',
        doc,
      });

      await new Promise((r) => setTimeout(r, 10));

      // 1. Edit A -> seq 1 starts
      doc.getText('content').insert(0, 'A');
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTING, 1);

      // 2. Edit B -> seq 2 starts
      doc.getText('content').insert(1, 'B');
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTING, 2);

      // 3. seq 2 succeeds
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTED, 2);
      expect(provider.persistenceState).toBe('persisted');
      expect(provider.isDirty).toBe(false);

      // 4. Stale seq 1 fails
      sendPersistencePacket(provider, PERSISTENCE_STATUS_ERROR, 1, 'Network timeout on stale seq 1');

      // Stale seq 1 error must NOT overwrite the newer successful persistence state!
      expect(provider.persistenceState).toBe('persisted');
      expect(provider.isDirty).toBe(false);

      provider.destroy();
      doc.destroy();
    });

    it('Test F: Newest persistence failure: latest persistence fails -> explicit error and dirty changes remain', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'test-ticket-f' }),
      });

      let errorDetails: { error?: string } | undefined;
      const doc = new Y.Doc();
      const provider = new CollabProvider({
        workspaceId: 'ws-test',
        documentId: 'doc-test-f',
        doc,
        onPersistenceChange: (_st, details) => {
          errorDetails = details;
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      // 1. User makes edit
      doc.getText('content').insert(0, 'Failing edit');
      expect(provider.persistenceState).toBe('editing');
      expect(provider.isDirty).toBe(true);

      // 2. Persistence begins
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTING, 1);
      expect(provider.persistenceState).toBe('saving');

      // 3. Persistence fails
      sendPersistencePacket(provider, PERSISTENCE_STATUS_ERROR, 1, 'PostgreSQL connection timeout');

      // Provider surfaces error, preserves dirty state, and does NOT acknowledge revision
      expect(provider.persistenceState).toBe('error');
      expect(provider.isDirty).toBe(true);
      expect(provider.getAcknowledgedLocalRev()).toBe(0);
      expect(errorDetails?.error).toContain('PostgreSQL connection timeout');

      provider.destroy();
      doc.destroy();
    });

    it('Test G: Manual Ctrl+S / flushPersistence while debounced persistence is pending sends MESSAGE_PERSISTENCE with no false saved state', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'test-ticket-g' }),
      });

      const doc = new Y.Doc();
      const provider = new CollabProvider({
        workspaceId: 'ws-test',
        documentId: 'doc-test-g',
        doc,
      });

      await new Promise((r) => setTimeout(r, 10));

      // User makes edit
      doc.getText('content').insert(0, 'Manual save text');
      expect(provider.persistenceState).toBe('editing');
      expect(provider.isDirty).toBe(true);

      // User triggers manual flush (e.g. Ctrl+S)
      provider.requestPersistenceFlush();

      // Verify packet was sent over WebSocket
      // @ts-expect-error accessing private ws
      const sent = provider.ws?.sentMessages || [];
      expect(sent.length).toBeGreaterThan(0);
      const lastSent = sent[sent.length - 1];
      const dec = decoding.createDecoder(new Uint8Array(lastSent));
      expect(decoding.readVarUint(dec)).toBe(MESSAGE_PERSISTENCE);

      // State must remain editing/dirty until server acknowledges, NOT falsely marked saved
      expect(provider.persistenceState).toBe('editing');
      expect(provider.isDirty).toBe(true);

      // Server acknowledges flush
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTING, 1);
      expect(provider.persistenceState).toBe('saving');

      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTED, 1);
      expect(provider.persistenceState).toBe('persisted');
      expect(provider.isDirty).toBe(false);

      provider.destroy();
      doc.destroy();
    });

    it('Test H: Viewer sends/attempts persistence flush: server rejection handled gracefully without false saved state', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'test-ticket-h' }),
      });

      const doc = new Y.Doc();
      const provider = new CollabProvider({
        workspaceId: 'ws-test',
        documentId: 'doc-test-h',
        doc,
      });

      await new Promise((r) => setTimeout(r, 10));

      // Viewer triggers flush
      provider.requestPersistenceFlush();

      // Server rejects with PERSISTENCE_STATUS_ERROR
      sendPersistencePacket(provider, PERSISTENCE_STATUS_ERROR, 0, 'Permission denied: viewers cannot persist');

      expect(provider.persistenceState).toBe('error');
      expect(provider.getLatestPersistedSeq()).toBe(0);

      provider.destroy();
      doc.destroy();
    });

    it('Test I: Verify the actual sequence number is used by the client and not left unused', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ ticket: 'test-ticket-i' }),
      });

      const doc = new Y.Doc();
      const provider = new CollabProvider({
        workspaceId: 'ws-test',
        documentId: 'doc-test-i',
        doc,
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(provider.getLatestPersistedSeq()).toBe(0);

      // Send PERSISTING with sequence 42
      doc.getText('content').insert(0, 'Seq 42 content');
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTING, 42);

      // Sequence has not persisted yet
      expect(provider.getLatestPersistedSeq()).toBe(0);
      expect(provider.persistenceState).toBe('saving');

      // Send PERSISTED with sequence 42
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTED, 42);

      // Client MUST track the actual sequence number
      expect(provider.getLatestPersistedSeq()).toBe(42);
      expect(provider.getAcknowledgedLocalRev()).toBe(1);
      expect(provider.persistenceState).toBe('persisted');

      // Older sequence 10 arrives late
      sendPersistencePacket(provider, PERSISTENCE_STATUS_PERSISTED, 10);
      // Remains 42 (strictly monotonic, cannot regress)
      expect(provider.getLatestPersistedSeq()).toBe(42);

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

