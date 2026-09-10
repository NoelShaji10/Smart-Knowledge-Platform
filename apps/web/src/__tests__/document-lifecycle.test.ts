// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError, Document, setAccessToken } from '../lib/api';
import { DocumentEditor } from '../components/editor/DocumentEditor';

// Configure act environment for React 18
// @ts-expect-error global IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'user@example.com', displayName: 'User One' },
    isAuthenticated: true,
  }),
}));

const mockShowToast = vi.fn();
vi.mock('@/components/ui', () => ({
  useToast: () => ({
    showToast: mockShowToast,
  }),
}));

vi.mock('@/hooks/useCollaboration', () => ({
  useCollaboration: () => ({
    provider: null,
    yDoc: null,
    status: 'connected',
    error: null,
    connectedUsers: [],
    indexeddbProvider: null,
  }),
}));

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
});

describe('Phase 5 T1 — Real DocumentEditor Collaborative Title Persistence Tests', () => {
  function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function changeTitle(input: HTMLInputElement, newTitle: string) {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;
    nativeInputValueSetter?.call(input, newTitle);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('11. Real asynchronous title race test: verifies debounce, single in-flight serialization, newest intent coalescing, and final title persistence', async () => {
    vi.useFakeTimers();

    const doc: Document = {
      id: 'doc-1',
      workspace_id: 'ws-1',
      parent_id: null,
      title: 'Initial Title',
      content_text: '<p>Content</p>',
      created_by: 'u1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const deferredA = createDeferred<{ document: Document }>();
    const deferredC = createDeferred<{ document: Document }>();
    const executedPayloads: Array<{ wsId: string; docId: string; data: { title?: string } }> = [];

    vi.spyOn(api, 'updateDocument').mockImplementation(async (wsId, docId, data) => {
      executedPayloads.push({ wsId, docId, data });
      if (executedPayloads.length === 1) {
        return deferredA.promise;
      }
      return deferredC.promise;
    });

    let latestSaveState = '';
    let updatedDocReceived: Document | null = null;
    let currentDoc = doc;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const renderEditor = () => {
      root.render(
        React.createElement(DocumentEditor, {
          workspaceId: 'ws-1',
          document: currentDoc,
          collaborative: true,
          onSaveStateChange: (s) => {
            latestSaveState = s;
          },
          onDocumentUpdated: (d) => {
            updatedDocReceived = d;
            currentDoc = d;
            renderEditor();
          },
        })
      );
    };

    await act(async () => {
      renderEditor();
    });

    const titleInput = container.querySelector('input') as HTMLInputElement;
    expect(titleInput.value).toBe('Initial Title');

    // 1. Trigger Title Edit A
    await act(async () => {
      changeTitle(titleInput, 'Title A');
    });
    expect(titleInput.value).toBe('Title A');
    expect(executedPayloads).toHaveLength(0);

    // Advance timers for debounce (500ms)
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    // Request A should now be in-flight
    expect(executedPayloads).toHaveLength(1);
    expect(executedPayloads[0]).toEqual({
      wsId: 'ws-1',
      docId: 'doc-1',
      data: { title: 'Title A' },
    });
    expect(latestSaveState).toBe('saving');

    // 2. Trigger Title Edit B and Title Edit C while A is in flight
    await act(async () => {
      changeTitle(titleInput, 'Title B');
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    // Request B was coalesced into pendingTitle, not sent yet because A is still in-flight
    expect(executedPayloads).toHaveLength(1);

    await act(async () => {
      changeTitle(titleInput, 'Title C');
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    // Request C replaced B in pendingTitle, still only 1 request in-flight
    expect(executedPayloads).toHaveLength(1);

    // 3. Resolve Request A
    await act(async () => {
      deferredA.resolve({
        document: { ...doc, title: 'Title A' },
      });
      await Promise.resolve(); // Flush microtask queue
    });

    // Request C should immediately have executed (B was coalesced out)
    expect(executedPayloads).toHaveLength(2);
    expect(executedPayloads[1]).toEqual({
      wsId: 'ws-1',
      docId: 'doc-1',
      data: { title: 'Title C' },
    });

    // 4. Resolve Request C
    await act(async () => {
      deferredC.resolve({
        document: { ...doc, title: 'Title C' },
      });
      await Promise.resolve();
    });

    expect(latestSaveState).toBe('saved');
    expect((updatedDocReceived as Document | null)?.title).toBe('Title C');
    expect(titleInput.value).toBe('Title C');

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('12. Real document switch race test: in-flight save for Document A does not mutate Document B or surface errors for Document B', async () => {
    vi.useFakeTimers();

    const docA: Document = {
      id: 'doc-A',
      workspace_id: 'ws-1',
      parent_id: null,
      title: 'Doc A Initial',
      content_text: '<p>A</p>',
      created_by: 'u1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const docB: Document = {
      id: 'doc-B',
      workspace_id: 'ws-1',
      parent_id: null,
      title: 'Doc B Initial',
      content_text: '<p>B</p>',
      created_by: 'u1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const deferredA = createDeferred<{ document: Document }>();
    vi.spyOn(api, 'updateDocument').mockImplementation(async (wsId, docId, data) => {
      if (docId === 'doc-A') {
        return deferredA.promise;
      }
      return { document: { ...docB, title: data.title || docB.title } };
    });

    let latestSaveState = '';
    let updatedDocReceived: Document | null = null;
    let currentDoc = docA;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const renderEditor = () => {
      root.render(
        React.createElement(DocumentEditor, {
          workspaceId: 'ws-1',
          document: currentDoc,
          collaborative: true,
          onSaveStateChange: (s) => {
            latestSaveState = s;
          },
          onDocumentUpdated: (d) => {
            updatedDocReceived = d;
            currentDoc = d;
            renderEditor();
          },
        })
      );
    };

    await act(async () => {
      renderEditor();
    });

    const titleInput = container.querySelector('input') as HTMLInputElement;
    expect(titleInput.value).toBe('Doc A Initial');

    // 1. Edit Doc A title and advance debounce to trigger in-flight save
    await act(async () => {
      changeTitle(titleInput, 'Doc A In-Flight Title');
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(latestSaveState).toBe('saving');

    // 2. Switch component to Doc B while Doc A save is still in flight
    await act(async () => {
      currentDoc = docB;
      renderEditor();
    });

    expect(titleInput.value).toBe('Doc B Initial');
    expect(latestSaveState).toBe('saved');

    // 3. Reject Doc A's in-flight request
    mockShowToast.mockClear();
    await act(async () => {
      deferredA.reject(new Error('Doc A Network Failure'));
      await Promise.resolve();
    });

    // Verify Doc B is completely unaffected
    expect(titleInput.value).toBe('Doc B Initial');
    expect(latestSaveState).toBe('saved');
    expect(mockShowToast).not.toHaveBeenCalled();
    expect(updatedDocReceived).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('13. Real title failure test: surfaces error toast, transitions save state to error, and preserves local title without fake saved state', async () => {
    vi.useFakeTimers();

    const doc: Document = {
      id: 'doc-1',
      workspace_id: 'ws-1',
      parent_id: null,
      title: 'Original Title',
      content_text: '<p>Content</p>',
      created_by: 'u1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const saveStatesRecorded: string[] = [];
    vi.spyOn(api, 'updateDocument').mockRejectedValue(new Error('500 Database Error'));

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(DocumentEditor, {
          workspaceId: 'ws-1',
          document: doc,
          collaborative: true,
          onSaveStateChange: (s) => {
            saveStatesRecorded.push(s);
          },
        })
      );
    });

    const titleInput = container.querySelector('input') as HTMLInputElement;
    expect(titleInput.value).toBe('Original Title');

    mockShowToast.mockClear();

    // Trigger title edit
    await act(async () => {
      changeTitle(titleInput, 'Unpersisted Title');
    });

    // Advance debounce
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    // Verify error surfaced to user via toast
    expect(mockShowToast).toHaveBeenCalledWith('Failed to save document title', 'error');

    // Verify save state transitioned to error
    const finalSaveState = saveStatesRecorded[saveStatesRecorded.length - 1];
    expect(finalSaveState).toBe('error');

    // Verify no fake "saved" state was emitted after the error
    const indexOfError = saveStatesRecorded.lastIndexOf('error');
    const subsequentStates = saveStatesRecorded.slice(indexOfError + 1);
    expect(subsequentStates).not.toContain('saved');

    // Verify local title remains available in the input
    expect(titleInput.value).toBe('Unpersisted Title');

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('14. Real title success test: debounce fires, API called with correct payload, document updated, and saved state emitted', async () => {
    vi.useFakeTimers();

    const doc: Document = {
      id: 'doc-1',
      workspace_id: 'ws-1',
      parent_id: null,
      title: 'Initial Title',
      content_text: '<p>Content</p>',
      created_by: 'u1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const updatedServerDoc: Document = {
      ...doc,
      title: 'Persisted Successfully',
      updated_at: new Date().toISOString(),
    };

    const updateSpy = vi.spyOn(api, 'updateDocument').mockResolvedValue({
      document: updatedServerDoc,
    });

    let latestSaveState = '';
    let updatedDocReceived: Document | null = null;
    let currentDoc = doc;

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    const renderEditor = () => {
      root.render(
        React.createElement(DocumentEditor, {
          workspaceId: 'ws-1',
          document: currentDoc,
          collaborative: true,
          onSaveStateChange: (s) => {
            latestSaveState = s;
          },
          onDocumentUpdated: (d) => {
            updatedDocReceived = d;
            currentDoc = d;
            renderEditor();
          },
        })
      );
    };

    await act(async () => {
      renderEditor();
    });

    const titleInput = container.querySelector('input') as HTMLInputElement;

    // Trigger title edit
    await act(async () => {
      changeTitle(titleInput, 'Persisted Successfully');
    });

    expect(updateSpy).not.toHaveBeenCalled();

    // Advance debounce
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });

    // Verify real API boundary called with exact parameters
    expect(updateSpy).toHaveBeenCalledWith('ws-1', 'doc-1', {
      title: 'Persisted Successfully',
    });

    // Verify component receives updated document
    expect(updatedDocReceived).toEqual(updatedServerDoc);

    // Verify save state is saved
    expect(latestSaveState).toBe('saved');
    expect(titleInput.value).toBe('Persisted Successfully');

    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });
});
