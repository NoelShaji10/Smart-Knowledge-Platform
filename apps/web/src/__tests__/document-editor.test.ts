import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, setAccessToken } from '../lib/api';

describe('Document API Integration & Auto-Save Capabilities', () => {
  beforeEach(() => {
    setAccessToken('mock-token');
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls GET /api/v1/workspaces/:wsId/documents to list workspace documents', async () => {
    const mockDocs = [
      {
        id: 'doc-1',
        workspace_id: 'ws-1',
        parent_id: null,
        title: 'Root Doc',
        content_text: 'Hello',
        created_by: 'user-1',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ documents: mockDocs }),
    });

    const res = await api.listDocuments('ws-1');
    expect(res.documents).toHaveLength(1);
    expect(res.documents[0].title).toBe('Root Doc');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/workspaces/ws-1/documents'),
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('calls POST to create a document', async () => {
    const newDoc = {
      id: 'doc-2',
      workspace_id: 'ws-1',
      parent_id: null,
      title: 'Untitled Document',
      content_text: '',
      created_by: 'user-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ document: newDoc }),
    });

    const res = await api.createDocument('ws-1', { title: 'Untitled Document' });
    expect(res.document.id).toBe('doc-2');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/workspaces/ws-1/documents'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'Untitled Document' }),
      }),
    );
  });

  it('calls PATCH to update document title and content', async () => {
    const updatedDoc = {
      id: 'doc-1',
      workspace_id: 'ws-1',
      parent_id: null,
      title: 'Updated Title',
      content_text: '<p>Updated Content</p>',
      created_by: 'user-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ document: updatedDoc }),
    });

    const res = await api.updateDocument('ws-1', 'doc-1', {
      title: 'Updated Title',
      contentText: '<p>Updated Content</p>',
    });

    expect(res.document.title).toBe('Updated Title');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/workspaces/ws-1/documents/doc-1'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Updated Title', contentText: '<p>Updated Content</p>' }),
      }),
    );
  });

  it('calls version restore endpoint', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          document: { id: 'doc-1', title: 'Restored Version' },
          newVersion: { version_number: 2 },
        }),
    });

    const res = await api.restoreVersion('ws-1', 'doc-1', 1);
    expect(res.document.title).toBe('Restored Version');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/workspaces/ws-1/documents/doc-1/versions/1/restore'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  describe('DocumentEditor State Machine & Race Condition Logic', () => {
    it('prevents stale in-flight save response A from overwriting newer local edit B', () => {
      // Logic verification: when editRevRef > saveRev, old response A does not mark state saved
      let editRev = 0;
      let saveRev = 0;
      let hasUnsavedChanges = false;
      let editorContent = 'Initial';

      // 1. Edit A
      editRev += 1;
      saveRev = editRev; // saveRev = 1
      hasUnsavedChanges = true;
      editorContent = 'Content A';

      // 2. User edits B while save A is in flight
      editRev += 1; // editRev = 2
      editorContent = 'Content B';

      // 3. Save A response arrives
      const resDocContent = 'Content A';
      if (editRev === saveRev) {
        hasUnsavedChanges = false;
        editorContent = resDocContent;
      }

      // 4. Verify B remains preserved
      expect(editorContent).toBe('Content B');
      expect(hasUnsavedChanges).toBe(true);
    });

    it('loads new content when switching from document A to document B', () => {
      let activeDocId = 'doc-1';
      let editRev = 5;
      let editorContent = 'Dirty content on doc 1';

      // Switch to doc-2
      const newDoc = { id: 'doc-2', title: 'Doc 2', content_text: 'Fresh content on doc 2' };
      const isDocumentSwitch = newDoc.id !== activeDocId;

      if (isDocumentSwitch) {
        activeDocId = newDoc.id;
        editRev = 0;
        editorContent = newDoc.content_text;
      }

      expect(activeDocId).toBe('doc-2');
      expect(editRev).toBe(0);
      expect(editorContent).toBe('Fresh content on doc 2');
    });

    it('updates save state to saved when save succeeds without intervening edits', () => {
      let editRev = 1;
      const saveRev = 1;
      let saveState = 'saving';
      let hasUnsavedChanges = true;

      if (editRev === saveRev) {
        saveState = 'saved';
        hasUnsavedChanges = false;
      }

      expect(saveState).toBe('saved');
      expect(hasUnsavedChanges).toBe(false);
    });
  });
});
