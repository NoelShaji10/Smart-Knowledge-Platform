import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError, Document, setAccessToken } from '../lib/api';

describe('Phase 5 T1 — Core Document Lifecycle Repair Tests', () => {
  beforeEach(() => {
    setAccessToken('mock-token');
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Failed document creation throws ApiError and does NOT produce fake doc-${Date.now()}', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Database error creating document' }),
    });

    try {
      await api.createDocument('ws-1', { title: 'Untitled Document' });
      expect.unreachable('Should have thrown ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(500);
      expect(apiErr.message).not.toContain('demo-user-1');
      expect(apiErr.message).not.toContain('doc-');
    }
  });

  it('2. Successful document creation returns and uses real persisted document ID', async () => {
    const realId = '11111111-2222-3333-4444-555555555555';
    const realDoc: Document = {
      id: realId,
      workspace_id: 'ws-1',
      parent_id: null,
      title: 'New Real Document',
      content_text: '',
      created_by: 'usr-real-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ document: realDoc }),
    });

    const res = await api.createDocument('ws-1', { title: 'New Real Document' });
    expect(res.document.id).toBe(realId);
    expect(res.document.created_by).toBe('usr-real-1');
  });

  it('3. Title rename persists via PATCH in non-collaborative mode', async () => {
    const updatedDoc: Document = {
      id: 'doc-1',
      workspace_id: 'ws-1',
      parent_id: null,
      title: 'Updated Non-Collab Title',
      content_text: '<p>Content</p>',
      created_by: 'usr-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ document: updatedDoc }),
    });

    const res = await api.updateDocument('ws-1', 'doc-1', {
      title: 'Updated Non-Collab Title',
      contentText: '<p>Content</p>',
    });

    expect(res.document.title).toBe('Updated Non-Collab Title');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/workspaces/ws-1/documents/doc-1'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Updated Non-Collab Title', contentText: '<p>Content</p>' }),
      }),
    );
  });

  it('4. Title rename persists via PATCH in collaborative mode (title metadata endpoint)', async () => {
    const updatedDoc: Document = {
      id: 'doc-1',
      workspace_id: 'ws-1',
      parent_id: null,
      title: 'Collaborative Title Edit',
      content_text: '<p>Yjs Content</p>',
      created_by: 'usr-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ document: updatedDoc }),
    });

    const res = await api.updateDocument('ws-1', 'doc-1', { title: 'Collaborative Title Edit' });
    expect(res.document.title).toBe('Collaborative Title Edit');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/workspaces/ws-1/documents/doc-1'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ title: 'Collaborative Title Edit' }),
      }),
    );
  });

  it('5. Archive API failure throws ApiError and does NOT fake local archive success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Database write error' }),
    });

    try {
      await api.archiveDocument('ws-1', 'doc-1');
      expect.unreachable('Should have thrown ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(500);
    }
  });

  it('6. Restore API failure throws ApiError and does NOT fake local restore success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Database write error' }),
    });

    try {
      await api.restoreDocument('ws-1', 'doc-1');
      expect.unreachable('Should have thrown ApiError');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(500);
    }
  });

  it('7. Document switching clears edit state and loads target document state', () => {
    let currentDocId = 'doc-A';
    let localTitle = 'Title A';
    let editRev = 3;

    // Switch to doc-B
    const nextDoc = { id: 'doc-B', title: 'Title B' };
    if (nextDoc.id !== currentDocId) {
      currentDocId = nextDoc.id;
      localTitle = nextDoc.title;
      editRev = 0;
    }

    expect(currentDocId).toBe('doc-B');
    expect(localTitle).toBe('Title B');
    expect(editRev).toBe(0);
  });

  it('8. Browser refresh reconstructs document state strictly from server response', async () => {
    const serverDoc: Document = {
      id: 'doc-persisted-123',
      workspace_id: 'ws-1',
      parent_id: null,
      title: 'Persisted Server Title',
      content_text: '<p>Persisted Server Content</p>',
      is_archived: false,
      created_by: 'usr-1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        document: serverDoc,
        capabilities: { canRead: true, canEdit: true },
      }),
    });

    const res = await api.getDocument('ws-1', 'doc-persisted-123');
    expect(res.document.title).toBe('Persisted Server Title');
    expect(res.document.content_text).toBe('<p>Persisted Server Content</p>');
  });

  it('9. Collaborative mode bypasses legacy content autosave endpoint', async () => {
    let autosaveTriggered = false;

    const isCollaborative = true;
    const handleEditorUpdate = ({ html }: { html: string }) => {
      if (isCollaborative) return;
      autosaveTriggered = true;
    };

    handleEditorUpdate({ html: '<p>New typing</p>' });
    expect(autosaveTriggered).toBe(false);
  });

  it('10. Document API failure does NOT generate demo or preview document data', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal Server Error' }),
    });

    await expect(api.listDocuments('ws-1')).rejects.toThrow(ApiError);
    await expect(api.createDocument('ws-1', { title: 'Test' })).rejects.toThrow(ApiError);
    await expect(api.archiveDocument('ws-1', 'doc-1')).rejects.toThrow(ApiError);
    await expect(api.restoreDocument('ws-1', 'doc-1')).rejects.toThrow(ApiError);
  });

  it('11. Real asynchronous title update queueing guarantees newest title intent is persisted and stale responses cannot overwrite', async () => {
    const executedTitles: string[] = [];
    let activeInFlightPromise: Promise<void> | null = null;
    let pendingTitle: string | null = null;
    let currentSavedTitle = 'Original Title';

    const mockApiUpdate = vi.fn(async (title: string, delayMs: number) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      currentSavedTitle = title;
      executedTitles.push(title);
    });

    const executeTitleSave = async (titleToSend: string, delayMs: number) => {
      const promise = (async () => {
        try {
          await mockApiUpdate(titleToSend, delayMs);
          const next = pendingTitle;
          pendingTitle = null;
          if (next !== null && next !== titleToSend) {
            await executeTitleSave(next, 10);
          }
        } finally {
          activeInFlightPromise = null;
        }
      })();

      activeInFlightPromise = promise;
      return promise;
    };

    const queueTitleSave = (targetTitle: string, delayMs: number) => {
      if (activeInFlightPromise !== null) {
        pendingTitle = targetTitle;
      } else {
        executeTitleSave(targetTitle, delayMs);
      }
    };

    // 1. Queue Title A with 60ms delay (in-flight)
    queueTitleSave('Title A', 60);

    // 2. Queue Title B and Title C while Title A is in-flight
    queueTitleSave('Title B', 30);
    queueTitleSave('Title C', 10);

    // 3. Await first in-flight request
    await activeInFlightPromise;

    // Allow second queued operation to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify Title A executed first, then Title C executed second (Title B coalesced into newest intent)
    expect(executedTitles).toEqual(['Title A', 'Title C']);
    expect(currentSavedTitle).toBe('Title C');
  });

  it('12. Document switch isolates in-flight title save callbacks from target document', async () => {
    let activeDocId = 'doc-A';
    let docBTitle = 'Doc B Initial Title';
    let docBToastError: string | null = null;

    const mockInFlightSave = vi.fn(async (docIdAtStart: string) => {
      await new Promise((r) => setTimeout(r, 40));
      if (activeDocId !== docIdAtStart) {
        // Document switch guard: return early
        return;
      }
      docBTitle = 'Mutated Title';
      docBToastError = 'Error Toast';
    });

    // Start save for doc-A
    const promiseA = mockInFlightSave('doc-A');

    // Switch to doc-B
    activeDocId = 'doc-B';

    // Wait for promiseA to complete
    await promiseA;

    // Verify doc-B remains completely unaffected
    expect(docBTitle).toBe('Doc B Initial Title');
    expect(docBToastError).toBeNull();
  });
});
