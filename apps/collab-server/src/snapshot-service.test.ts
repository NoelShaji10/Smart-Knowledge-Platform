import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import {
  extractSearchableText,
  loadRoomSnapshot,
} from './snapshot-service';
import * as snapshotService from './snapshot-service';
import { getOrCreateRoom, clearAllRooms, removeRoomIfEmpty, getRoom } from './room-manager';
import * as storage from '@knowledge/storage';

describe('T2: Snapshot Service & Persistence', () => {
  beforeEach(() => {
    clearAllRooms();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearAllRooms();
    vi.restoreAllMocks();
  });

  describe('extractSearchableText', () => {
    it('extracts text from Y.Text objects in Y.Doc', () => {
      const doc = new Y.Doc();
      const text = doc.getText('content');
      text.insert(0, 'Searchable Document Plaintext');

      const extracted = extractSearchableText(doc);
      expect(extracted).toBe('Searchable Document Plaintext');
    });

    it('extracts text from Y.XmlFragment objects in Y.Doc', () => {
      const doc = new Y.Doc();
      const xmlFrag = doc.getXmlFragment('default');
      const p1 = new Y.XmlElement('p');
      const t1 = new Y.XmlText('Paragraph 1 text');
      p1.insert(0, [t1]);
      xmlFrag.insert(0, [p1]);

      const extracted = extractSearchableText(doc);
      expect(extracted).toContain('Paragraph 1 text');
    });

    it('returns empty string for fresh empty Y.Doc', () => {
      const doc = new Y.Doc();
      expect(extractSearchableText(doc)).toBe('');
    });
  });

  describe('Snapshot Loading & Fail-Closed Behavior', () => {
    it('returns false and starts empty room if loadRecoverySnapshot returns null (missing snapshot)', async () => {
      vi.spyOn(storage, 'loadRecoverySnapshot').mockResolvedValue(null);

      const doc = new Y.Doc();
      const loaded = await loadRoomSnapshot('00000000-0000-0000-0000-000000000101', doc);
      expect(loaded).toBe(false);
      expect(extractSearchableText(doc)).toBe('');
    });

    it('hydrates Y.Doc when valid snapshot binary is loaded', async () => {
      const sourceDoc = new Y.Doc();
      sourceDoc.getText('content').insert(0, 'Persisted State Content');
      const snapshotBytes = Y.encodeStateAsUpdate(sourceDoc);

      vi.spyOn(storage, 'loadRecoverySnapshot').mockResolvedValue(snapshotBytes);

      const targetDoc = new Y.Doc();
      const loaded = await loadRoomSnapshot('00000000-0000-0000-0000-000000000102', targetDoc);
      expect(loaded).toBe(true);
      expect(targetDoc.getText('content').toString()).toBe('Persisted State Content');
    });

    it('throws error and fails closed when snapshot loading encounters storage outage / error', async () => {
      vi.spyOn(storage, 'loadRecoverySnapshot').mockRejectedValue(new Error('MinIO connection refused'));

      const doc = new Y.Doc();
      await expect(loadRoomSnapshot('00000000-0000-0000-0000-000000000103', doc)).rejects.toThrow('MinIO connection refused');
    });

    it('throws error when persisted snapshot binary is corrupted', async () => {
      const corruptBytes = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
      vi.spyOn(storage, 'loadRecoverySnapshot').mockResolvedValue(corruptBytes);

      const doc = new Y.Doc();
      await expect(loadRoomSnapshot('00000000-0000-0000-0000-000000000104', doc)).rejects.toThrow();
    });
  });

  describe('Debounced Snapshot & Room Shutdown Lifecycle', () => {
    it('triggers snapshot persistence and session-end version checkpoint on room shutdown', async () => {
      vi.spyOn(storage, 'loadRecoverySnapshot').mockResolvedValue(null);
      const persistSpy = vi.spyOn(snapshotService, 'persistRecoverySnapshot').mockResolvedValue();
      const checkpointSpy = vi.spyOn(snapshotService, 'createVersionCheckpointOnSessionEnd').mockResolvedValue();

      const docId = '00000000-0000-0000-0000-000000000105';
      const room = await getOrCreateRoom(docId);
      room.doc.getText('content').insert(0, 'Shutdown Content');

      // Simulate connection close -> removeRoomIfEmpty
      await removeRoomIfEmpty(docId, '00000000-0000-0000-0000-000000000201');

      expect(persistSpy).toHaveBeenCalledWith(docId, expect.any(Y.Doc), expect.anything());
      expect(checkpointSpy).toHaveBeenCalledWith(
        docId,
        expect.any(Y.Doc),
        '00000000-0000-0000-0000-000000000201',
        expect.anything()
      );
      expect(getRoom(docId)).toBeUndefined();
    });
  });
});
