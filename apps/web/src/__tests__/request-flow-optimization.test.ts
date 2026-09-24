// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  api,
  ApiError,
  Document,
  DocumentCapabilities,
  setAccessToken,
  Workspace,
} from '../lib/api';
import { AuthContext } from '../contexts/AuthContext';
import { WorkspaceContext } from '../contexts/WorkspaceContext';
import {
  DocumentNavigationProvider,
  useDocumentNavigation,
} from '../contexts/DocumentNavigationContext';
import { AppShell } from '../components/layout/AppShell';
import DocumentPage from '../app/(app)/workspaces/[workspaceId]/documents/[documentId]/page';
import { CreateDocumentModal } from '../components/documents/CreateDocumentModal';
import { MoveDocumentModal } from '../components/documents/MoveDocumentModal';
import { DocumentHeader } from '../components/documents/DocumentHeader';

// Configure act environment for React 18
// @ts-expect-error global IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let mockCurrentPath = '/workspaces/ws-1';
const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => mockCurrentPath,
  useRouter: () => ({
    push: mockPush,
  }),
}));

const mockShowToast = vi.fn();
vi.mock('@/components/ui', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui')>('@/components/ui');
  return {
    ...actual,
    useToast: () => ({
      showToast: mockShowToast,
    }),
  };
});

// Mock DocumentEditor to keep tests lightweight and focused on request flow
vi.mock('@/components/editor/DocumentEditor', () => ({
  DocumentEditor: ({ document }: any) =>
    React.createElement('div', { 'data-testid': 'document-editor' }, document.title),
}));

// Mock VersionHistoryPanel
vi.mock('@/components/documents/VersionHistoryPanel', () => ({
  VersionHistoryPanel: () => React.createElement('div', { 'data-testid': 'version-history' }),
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const el = React.createElement as any;

describe('Phase 5 T7 — Performance & Request-Flow Optimization Tests', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setAccessToken('mock-token');
    vi.resetAllMocks();
    mockCurrentPath = '/workspaces/ws-1';

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  const renderComponent = async (ui: React.ReactElement) => {
    await act(async () => {
      root.render(ui);
      await Promise.resolve();
    });
  };

  const mockAuthValue: any = {
    user: { id: 'usr-1', email: 'test@example.com', name: 'Test User' },
    loading: false,
    error: null,
    isNetworkError: false,
    clearError: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
  };

  const createMockWorkspace = (overrides: Partial<Workspace> = {}): Workspace => ({
    id: overrides.id || 'ws-1',
    name: overrides.name || 'Workspace Alpha',
    slug: overrides.slug || 'ws-alpha',
    created_at: overrides.created_at || new Date().toISOString(),
    updated_at: overrides.updated_at || new Date().toISOString(),
  });

  const createMockWorkspaceContext = (overrides?: any) => ({
    workspaces: [createMockWorkspace({ id: 'ws-1', name: 'Workspace Alpha' })],
    activeWorkspace: createMockWorkspace({ id: 'ws-1', name: 'Workspace Alpha' }),
    userRole: 'editor' as const,
    loading: false,
    error: null,
    refreshWorkspaces: vi.fn().mockResolvedValue([]),
    loadWorkspace: vi.fn().mockResolvedValue(null),
    createWorkspace: vi.fn().mockResolvedValue({} as any),
    ...overrides,
  });

  const createMockDoc = (overrides: Partial<Document> = {}): Document => ({
    id: overrides.id || 'doc-1',
    workspace_id: overrides.workspace_id || 'ws-1',
    parent_id: overrides.parent_id !== undefined ? overrides.parent_id : null,
    title: overrides.title || 'Test Document',
    content_text: overrides.content_text || 'Document content here',
    is_archived: overrides.is_archived || false,
    created_by: 'usr-1',
    created_at: overrides.created_at || new Date().toISOString(),
    updated_at: overrides.updated_at || new Date().toISOString(),
    snapshot_version: overrides.snapshot_version || 1,
  });

  const defaultCapabilities: DocumentCapabilities = {
    canRead: true,
    canEdit: true,
    canMove: true,
    canArchive: true,
    canManagePermissions: true,
  };

  const renderWithContext = async (ui: React.ReactElement, wsOverrides?: any) => {
    await renderComponent(
      el(
        AuthContext.Provider,
        { value: mockAuthValue },
        el(
          WorkspaceContext.Provider,
          { value: createMockWorkspaceContext(wsOverrides) },
          ui,
        ),
      ),
    );
  };

  // =========================================================================
  // TASK 2: /workspaces/new ROUTE REQUEST PREVENTION
  // =========================================================================

  describe('Task 2 — /workspaces/new Route Request Prevention', () => {
    it('does NOT trigger document loading when route is /workspaces/new', async () => {
      mockCurrentPath = '/workspaces/new';
      const listDocsSpy = vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [] });

      await renderWithContext(
        el(AppShell, null, el('div', null, 'Create Workspace Page')),
      );

      await act(async () => {
        await Promise.resolve();
      });

      // No document-list request must be made with 'new'
      expect(listDocsSpy).not.toHaveBeenCalledWith('new', expect.anything());
      expect(listDocsSpy).toHaveBeenCalledTimes(0);
      expect(container.textContent).toContain('Create Workspace Page');
    });

    it('triggers document loading normally for legitimate workspace IDs', async () => {
      mockCurrentPath = '/workspaces/ws-legit-123';
      const listDocsSpy = vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [] });

      await renderWithContext(
        el(AppShell, null, el('div', null, 'Workspace Page')),
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(listDocsSpy).toHaveBeenCalledWith('ws-legit-123', expect.anything());
    });

    it('triggers document loading for workspace slug that includes "new-" prefix', async () => {
      mockCurrentPath = '/workspaces/new-project';
      const listDocsSpy = vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [] });

      await renderWithContext(
        el(AppShell, null, el('div', null, 'Workspace Page')),
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(listDocsSpy).toHaveBeenCalledWith('new-project', expect.anything());
    });
  });

  // =========================================================================
  // TASK 3: DOCUMENT FETCH REQUEST FENCING & CANCELLATION
  // =========================================================================

  describe('Task 3 — Document Fetch Request Fencing & Cancellation', () => {
    it('A → B race: Request B resolves first, Request A resolves later -> B is displayed and A is discarded', async () => {
      const deferredA = createDeferred<any>();
      const deferredB = createDeferred<any>();

      const getDocSpy = vi.spyOn(api, 'getDocument').mockImplementation((wsId, docId) => {
        if (docId === 'doc-a') return deferredA.promise;
        if (docId === 'doc-b') return deferredB.promise;
        return Promise.reject(new Error('Unknown document'));
      });

      // 1. Initial render with doc-a
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-a' } }),
      );
      expect(getDocSpy).toHaveBeenCalledWith('ws-1', 'doc-a', expect.anything());

      // 2. Navigate to doc-b while Request A is still pending
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-b' } }),
      );
      expect(getDocSpy).toHaveBeenCalledWith('ws-1', 'doc-b', expect.anything());

      // 3. Request B resolves FIRST
      await act(async () => {
        deferredB.resolve({
          document: createMockDoc({ id: 'doc-b', title: 'Document B Title' }),
          effectiveRole: 'editor',
          capabilities: defaultCapabilities,
        });
        await Promise.resolve();
      });

      // Document B is rendered
      expect(container.textContent).toContain('Document B Title');

      // 4. Request A resolves LATER
      await act(async () => {
        deferredA.resolve({
          document: createMockDoc({ id: 'doc-a', title: 'Document A Title' }),
          effectiveRole: 'editor',
          capabilities: defaultCapabilities,
        });
        await Promise.resolve();
      });

      // Crucial: Document B must NOT be overwritten by stale A
      expect(container.textContent).toContain('Document B Title');
      expect(container.textContent).not.toContain('Document A Title');
    });

    it('A → B race: Request A resolves first, Request B resolves later -> B is displayed once resolved', async () => {
      const deferredA = createDeferred<any>();
      const deferredB = createDeferred<any>();

      vi.spyOn(api, 'getDocument').mockImplementation((wsId, docId) => {
        if (docId === 'doc-a') return deferredA.promise;
        if (docId === 'doc-b') return deferredB.promise;
        return Promise.reject(new Error('Unknown document'));
      });

      // Initial render with doc-a
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-a' } }),
      );

      // Navigate to doc-b
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-b' } }),
      );

      // Request A resolves first
      await act(async () => {
        deferredA.resolve({
          document: createMockDoc({ id: 'doc-a', title: 'Document A Title' }),
          effectiveRole: 'editor',
          capabilities: defaultCapabilities,
        });
        await Promise.resolve();
      });

      // Document A must NOT be displayed because current route is doc-b
      expect(container.textContent).not.toContain('Document A Title');

      // Request B resolves
      await act(async () => {
        deferredB.resolve({
          document: createMockDoc({ id: 'doc-b', title: 'Document B Title' }),
          effectiveRole: 'editor',
          capabilities: defaultCapabilities,
        });
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Document B Title');
    });

    it('Stale error rejection: Request A fails after Request B succeeds -> B preserved, error ignored', async () => {
      const deferredA = createDeferred<any>();
      const deferredB = createDeferred<any>();

      vi.spyOn(api, 'getDocument').mockImplementation((wsId, docId) => {
        if (docId === 'doc-a') return deferredA.promise;
        if (docId === 'doc-b') return deferredB.promise;
        return Promise.reject(new Error('Unknown document'));
      });

      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-a' } }),
      );
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-b' } }),
      );

      // B succeeds
      await act(async () => {
        deferredB.resolve({
          document: createMockDoc({ id: 'doc-b', title: 'Document B Title' }),
          effectiveRole: 'editor',
          capabilities: defaultCapabilities,
        });
        await Promise.resolve();
      });
      expect(container.textContent).toContain('Document B Title');

      // A fails with 500 error after B has already succeeded
      await act(async () => {
        deferredA.reject(new ApiError('Server Error on Doc A', 500));
        await Promise.resolve();
      });

      // State MUST remain Document B, stale error must not overwrite or show error state
      expect(container.textContent).toContain('Document B Title');
      expect(container.textContent).not.toContain('Server Error');
    });

    it('Request B fails after Request A succeeds -> displays error for current route B', async () => {
      const deferredA = createDeferred<any>();
      const deferredB = createDeferred<any>();

      vi.spyOn(api, 'getDocument').mockImplementation((wsId, docId) => {
        if (docId === 'doc-a') return deferredA.promise;
        if (docId === 'doc-b') return deferredB.promise;
        return Promise.reject(new Error('Unknown document'));
      });

      // A succeeds
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-a' } }),
      );
      await act(async () => {
        deferredA.resolve({
          document: createMockDoc({ id: 'doc-a', title: 'Document A Title' }),
          effectiveRole: 'editor',
          capabilities: defaultCapabilities,
        });
        await Promise.resolve();
      });
      expect(container.textContent).toContain('Document A Title');

      // Switch to B, B fails with 403
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-b' } }),
      );
      await act(async () => {
        deferredB.reject(new ApiError('Access Denied to Document', 403));
        await Promise.resolve();
      });

      expect(container.textContent).toContain('403: Access Denied to Document');
      expect(container.textContent).not.toContain('Document A Title');
    });

    it('Rapid A → B → C navigation deterministically renders C regardless of resolution order', async () => {
      const deferredA = createDeferred<any>();
      const deferredB = createDeferred<any>();
      const deferredC = createDeferred<any>();

      vi.spyOn(api, 'getDocument').mockImplementation((wsId, docId) => {
        if (docId === 'doc-a') return deferredA.promise;
        if (docId === 'doc-b') return deferredB.promise;
        if (docId === 'doc-c') return deferredC.promise;
        return Promise.reject(new Error('Unknown document'));
      });

      // Rapidly switch A -> B -> C
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-a' } }),
      );
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-b' } }),
      );
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-c' } }),
      );

      // Resolve in out-of-order sequence: C first, then A, then B
      await act(async () => {
        deferredC.resolve({
          document: createMockDoc({ id: 'doc-c', title: 'Final Document C' }),
          effectiveRole: 'editor',
          capabilities: defaultCapabilities,
        });
        await Promise.resolve();
      });
      expect(container.textContent).toContain('Final Document C');

      await act(async () => {
        deferredA.resolve({
          document: createMockDoc({ id: 'doc-a', title: 'Stale Doc A' }),
          effectiveRole: 'editor',
          capabilities: defaultCapabilities,
        });
        deferredB.resolve({
          document: createMockDoc({ id: 'doc-b', title: 'Stale Doc B' }),
          effectiveRole: 'editor',
          capabilities: defaultCapabilities,
        });
        await Promise.resolve();
      });

      // Document C must remain active and uninterrupted
      expect(container.textContent).toContain('Final Document C');
      expect(container.textContent).not.toContain('Stale Doc A');
      expect(container.textContent).not.toContain('Stale Doc B');
    });

    it('Unmount while request is pending aborts the in-flight controller without state warnings', async () => {
      const deferred = createDeferred<any>();
      let passedSignal: AbortSignal | undefined;

      vi.spyOn(api, 'getDocument').mockImplementation((wsId, docId, options) => {
        passedSignal = options?.signal;
        return deferred.promise;
      });

      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-pending' } }),
      );

      expect(passedSignal).toBeDefined();
      expect(passedSignal?.aborted).toBe(false);

      // Unmount the component while request is still pending
      await act(async () => {
        root.unmount();
      });

      // Abort signal must be fired
      expect(passedSignal?.aborted).toBe(true);

      // Resolving afterwards must not throw or update state
      await act(async () => {
        deferred.resolve({
          document: createMockDoc({ id: 'doc-pending' }),
          effectiveRole: 'editor',
          capabilities: defaultCapabilities,
        });
        await Promise.resolve();
      });
    });

    it('G. Same document requested twice with different generations (e.g. Retry Connection): only latest generation updates state', async () => {
      const deferred1 = createDeferred<any>();
      const deferred2 = createDeferred<any>();

      let callCount = 0;
      vi.spyOn(api, 'getDocument').mockImplementation(() => {
        callCount++;
        if (callCount === 1) return deferred1.promise;
        return deferred2.promise;
      });

      // Initial render triggers Request 1
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-retry' } }),
      );

      // Request 1 fails with server error
      await act(async () => {
        deferred1.reject(new ApiError('Unable to Load Document (Server Error)', 500));
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Unable to Load Document (Server Error)');

      const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Retry Connection'),
      );
      expect(retryBtn).toBeDefined();

      // Click Retry Connection (triggers Request 2)
      await act(async () => {
        retryBtn!.click();
      });

      expect(callCount).toBe(2);

      // Request 2 resolves successfully
      await act(async () => {
        deferred2.resolve({
          document: createMockDoc({ id: 'doc-retry', title: 'Successfully Loaded on Retry' }),
          effectiveRole: 'editor',
          capabilities: defaultCapabilities,
        });
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Successfully Loaded on Retry');
      expect(container.textContent).not.toContain('Server Error');
    });
  });

  // =========================================================================
  // TASK 4 & 5: CONTEXT CANCELLATION & WORKSPACE-SCOPED EVENTS
  // =========================================================================

  describe('Task 5 & 9 — Navigation Context Cancellation & Scoped Events', () => {
    it('Workspace change aborts previous in-flight listDocuments request', async () => {
      const deferred1 = createDeferred<any>();
      const deferred2 = createDeferred<any>();
      const signals: (AbortSignal | undefined)[] = [];

      vi.spyOn(api, 'listDocuments').mockImplementation((wsId, params) => {
        signals.push(params?.signal);
        if (wsId === 'ws-1') return deferred1.promise;
        return deferred2.promise;
      });

      // Render with workspace ws-1
      await renderComponent(
        el(DocumentNavigationProvider, { workspaceId: 'ws-1' }, el('div', null, 'Content')),
      );

      expect(signals.length).toBe(1);
      expect(signals[0]?.aborted).toBe(false);

      // Switch to ws-2
      await renderComponent(
        el(DocumentNavigationProvider, { workspaceId: 'ws-2' }, el('div', null, 'Content')),
      );

      // Previous request signal must be aborted
      expect(signals[0]?.aborted).toBe(true);
      expect(signals.length).toBe(2);
      expect(signals[1]?.aborted).toBe(false);
    });

    it('workspace:refresh event with mismatched workspaceId does not trigger refetch', async () => {
      const listSpy = vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [] });

      await renderComponent(
        el(DocumentNavigationProvider, { workspaceId: 'ws-target' }, el('div', null, 'Content')),
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(listSpy).toHaveBeenCalledTimes(1);

      // Dispatch event targeted at a different workspace
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('workspace:refresh', { detail: { workspaceId: 'ws-other' } }),
        );
        await Promise.resolve();
      });

      // Must NOT have refetched
      expect(listSpy).toHaveBeenCalledTimes(1);

      // Dispatch event matching workspace
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('workspace:refresh', { detail: { workspaceId: 'ws-target' } }),
        );
        await Promise.resolve();
      });

      expect(listSpy).toHaveBeenCalledTimes(2);
    });

    it('document:updated event synchronizes in-memory state without an API request', async () => {
      const docInitial = createMockDoc({ id: 'doc-1', title: 'Original Title' });
      const listSpy = vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [docInitial] });

      let currentDocs: Document[] = [];
      function Consumer() {
        const { documents } = useDocumentNavigation();
        currentDocs = documents;
        return null;
      }

      await renderComponent(
        el(DocumentNavigationProvider, { workspaceId: 'ws-1' }, el(Consumer)),
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(listSpy).toHaveBeenCalledTimes(1);
      expect(currentDocs[0].title).toBe('Original Title');

      // Dispatch document:updated
      const updatedDoc = { ...docInitial, title: 'Optimized Title' };
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('document:updated', { detail: { document: updatedDoc } }),
        );
        await Promise.resolve();
      });

      // In-memory state updated
      expect(currentDocs[0].title).toBe('Optimized Title');
      // No extra listDocuments API request fired
      expect(listSpy).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // TASK 6: MUTATION DOUBLE-CLICK & IN-FLIGHT PROTECTION
  // =========================================================================

  describe('Task 6 — Mutation Double-Click & In-Flight Protection', () => {
    it('CreateDocumentModal ignores duplicate submits while request is in-flight', async () => {
      const deferred = createDeferred<any>();
      const createSpy = vi.spyOn(api, 'createDocument').mockImplementation(() => deferred.promise);

      const onCreated = vi.fn();
      const onClose = vi.fn();

      await renderComponent(
        el(CreateDocumentModal, {
          workspaceId: 'ws-1',
          isOpen: true,
          onClose,
          onCreated,
        }),
      );

      const input = container.querySelector('input')!;
      await act(async () => {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )?.set;
        nativeInputValueSetter?.call(input, 'My New Document');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const form = container.querySelector('form')!;

      // First submit
      await act(async () => {
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      });
      expect(createSpy).toHaveBeenCalledTimes(1);

      // Rapid second submit while still in-flight
      await act(async () => {
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      });
      // Should NOT have triggered a second API call
      expect(createSpy).toHaveBeenCalledTimes(1);

      // Resolve request
      await act(async () => {
        deferred.resolve({ document: createMockDoc({ id: 'doc-new', title: 'My New Document' }) });
        await Promise.resolve();
      });

      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('MoveDocumentModal ignores duplicate submits while request is in-flight', async () => {
      const deferred = createDeferred<any>();
      const moveSpy = vi.spyOn(api, 'moveDocument').mockImplementation(() => deferred.promise);

      const docToMove = createMockDoc({ id: 'doc-moving', parent_id: null });
      const parentDoc = createMockDoc({ id: 'doc-parent', parent_id: null, title: 'Parent Folder' });

      await renderComponent(
        el(MoveDocumentModal, {
          workspaceId: 'ws-1',
          document: docToMove,
          documents: [docToMove, parentDoc],
          isOpen: true,
          onClose: vi.fn(),
          onMoved: vi.fn(),
        }),
      );

      // Select parent
      const select = container.querySelector('select')!;
      await act(async () => {
        const nativeSelectValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLSelectElement.prototype,
          'value',
        )?.set;
        nativeSelectValueSetter?.call(select, 'doc-parent');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });

      const form = container.querySelector('form')!;

      // First submit
      await act(async () => {
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      });
      expect(moveSpy).toHaveBeenCalledTimes(1);

      // Second submit while in-flight
      await act(async () => {
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      });
      // Must NOT double-call API
      expect(moveSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        deferred.resolve({ document: { ...docToMove, parent_id: 'doc-parent' } });
        await Promise.resolve();
      });
    });

    it('DocumentHeader checkpoints ignore duplicate clicks while in-flight', async () => {
      const deferred = createDeferred<any>();
      const createVersionSpy = vi.spyOn(api, 'createVersion').mockImplementation(() => deferred.promise);

      const doc = createMockDoc({ id: 'doc-ver-1' });

      await renderWithContext(
        el(DocumentHeader, {
          workspaceId: 'ws-1',
          document: doc,
          capabilities: defaultCapabilities,
          saveState: 'saved',
          onToggleHistory: vi.fn(),
          onDocumentUpdated: vi.fn(),
        }),
      );

      const saveVerBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Save Version'),
      )!;
      expect(saveVerBtn).toBeDefined();

      // Click once
      await act(async () => {
        saveVerBtn.click();
      });
      expect(createVersionSpy).toHaveBeenCalledTimes(1);

      // Click second time while in flight
      await act(async () => {
        saveVerBtn.click();
      });
      // Must NOT double call
      expect(createVersionSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        deferred.resolve({ version: { id: 'v-1', version_number: 2 } });
        await Promise.resolve();
      });
    });
  });


  // =========================================================================
  // TASK 4: WORKSPACE CONTEXT REQUEST FENCING
  // =========================================================================

  describe('Task 4 — WorkspaceContext Request Fencing', () => {
    it('refreshWorkspaces: Stale list response cannot overwrite newer list', async () => {
      const deferred1 = createDeferred<any>();
      const deferred2 = createDeferred<any>();

      let callCount = 0;
      vi.spyOn(api, 'getWorkspaces').mockImplementation(() => {
        callCount++;
        if (callCount === 1) return deferred1.promise;
        return deferred2.promise;
      });

      const { WorkspaceProvider, useWorkspace } = await import('../contexts/WorkspaceContext');

      let currentWorkspaces: Workspace[] = [];
      let triggerRefresh!: () => Promise<Workspace[]>;

      function WsConsumer() {
        const { workspaces, refreshWorkspaces } = useWorkspace();
        currentWorkspaces = workspaces;
        triggerRefresh = refreshWorkspaces;
        return null;
      }

      await renderComponent(
        el(
          AuthContext.Provider,
          { value: mockAuthValue },
          el(WorkspaceProvider, null, el(WsConsumer)),
        ),
      );

      // Trigger call 1
      await act(async () => {
        triggerRefresh();
      });

      // Trigger call 2
      await act(async () => {
        triggerRefresh();
      });

      // Call 2 resolves first with newer list
      const newerList = [createMockWorkspace({ id: 'ws-new', name: 'Newer Workspace' })];
      await act(async () => {
        deferred2.resolve({ workspaces: newerList });
        await Promise.resolve();
      });

      expect(currentWorkspaces).toEqual(newerList);

      // Call 1 resolves later with older list
      const olderList = [createMockWorkspace({ id: 'ws-old', name: 'Older Workspace' })];
      await act(async () => {
        deferred1.resolve({ workspaces: olderList });
        await Promise.resolve();
      });

      // Newer list must NOT be overwritten by stale older list
      expect(currentWorkspaces).toEqual(newerList);
    });

    it('loadWorkspace: Switching A → B → A ensures stale B error cannot destroy valid A state', async () => {
      const deferredA1 = createDeferred<any>();
      const deferredB = createDeferred<any>();
      const deferredA2 = createDeferred<any>();

      const getWsSpy = vi.spyOn(api, 'getWorkspace').mockImplementation((id: string) => {
        if (id === 'ws-a' && getWsSpy.mock.calls.length === 1) return deferredA1.promise;
        if (id === 'ws-b') return deferredB.promise;
        return deferredA2.promise;
      });

      const { WorkspaceProvider, useWorkspace } = await import('../contexts/WorkspaceContext');

      const stateHolder = {
        activeWs: null as Workspace | null,
        activeError: null as string | null,
      };
      let switchWorkspace!: (id: string) => Promise<Workspace | null>;

      function WsConsumer() {
        const { activeWorkspace, error, loadWorkspace } = useWorkspace();
        stateHolder.activeWs = activeWorkspace;
        stateHolder.activeError = error;
        switchWorkspace = loadWorkspace;
        return null;
      }

      await renderComponent(
        el(
          AuthContext.Provider,
          { value: mockAuthValue },
          el(WorkspaceProvider, null, el(WsConsumer)),
        ),
      );

      // Start loading ws-a
      await act(async () => {
        switchWorkspace('ws-a');
      });

      // Rapidly switch to ws-b
      await act(async () => {
        switchWorkspace('ws-b');
      });

      // Rapidly switch back to ws-a
      await act(async () => {
        switchWorkspace('ws-a');
      });

      // Latest ws-a request (A2) resolves successfully
      const wsA = createMockWorkspace({ id: 'ws-a', name: 'Workspace A' });
      await act(async () => {
        deferredA2.resolve({ workspace: wsA, userRole: 'editor' });
        await Promise.resolve();
      });

      expect(stateHolder.activeWs?.id).toBe('ws-a');
      expect(stateHolder.activeError).toBeNull();

      // Delayed ws-b fails with 403 Forbidden
      await act(async () => {
        deferredB.reject(new ApiError('Access denied', 403));
        await Promise.resolve();
      });

      // Active workspace A must NOT be destroyed by stale B failure!
      expect(stateHolder.activeWs?.id).toBe('ws-a');
      expect(stateHolder.activeError).toBeNull();
    });
  });

  // =========================================================================
  // TASK 6 (CONTINUED): ARCHIVED BANNER RESTORE DOUBLE-CLICK
  // =========================================================================

  describe('Task 6 — Archived Document Banner Restore Double-Click Protection', () => {
    it('Restore Document button in archived banner prevents duplicate API calls while in-flight', async () => {
      const deferred = createDeferred<any>();
      const restoreSpy = vi.spyOn(api, 'restoreDocument').mockImplementation(() => deferred.promise);

      const archivedDoc = createMockDoc({ id: 'doc-archived', is_archived: true });

      vi.spyOn(api, 'getDocument').mockResolvedValue({
        document: archivedDoc,
        effectiveRole: 'editor',
        capabilities: { ...defaultCapabilities, canArchive: true },
      });

      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-archived' } }),
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(container.textContent).toContain('This document is archived and is currently read-only.');

      const restoreBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Restore Document'),
      )!;
      expect(restoreBtn).toBeDefined();

      // Click once
      await act(async () => {
        restoreBtn.click();
      });
      expect(restoreSpy).toHaveBeenCalledTimes(1);

      // Click second time while request is in-flight
      await act(async () => {
        restoreBtn.click();
      });
      // Double call must NOT occur
      expect(restoreSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        deferred.resolve({ document: { ...archivedDoc, is_archived: false } });
        await Promise.resolve();
      });
    });
  });

  // =========================================================================
  // TASK 7: API CLIENT CANCELLATION SEMANTICS
  // =========================================================================

  describe('Task 7 — API Client Cancellation Semantics', () => {
    it('Aborted request throws native AbortError instead of ApiError(0)', async () => {
      const controller = new AbortController();
      controller.abort();

      // Native fetch mock throwing AbortError
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(abortError);

      try {
        await expect(
          api.getDocument('ws-1', 'doc-1', { signal: controller.signal }),
        ).rejects.toSatisfy((err: any) => {
          return err.name === 'AbortError' && !(err instanceof ApiError);
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // =========================================================================
  // TASK 11: DOCUMENT PAGE TRANSITIONS UNDER VARIOUS ERROR STATES
  // =========================================================================

  describe('Task 11 — Document Page Transition Correctness', () => {
    it('A → B → A: correctly restores Document A state without stale spinner or state leakage', async () => {
      const docA = createMockDoc({ id: 'doc-a', title: 'Document A Initial' });
      const docB = createMockDoc({ id: 'doc-b', title: 'Document B Initial' });

      vi.spyOn(api, 'getDocument').mockImplementation(async (wsId, docId) => {
        if (docId === 'doc-a') return { document: docA, effectiveRole: 'editor', capabilities: defaultCapabilities };
        if (docId === 'doc-b') return { document: docB, effectiveRole: 'editor', capabilities: defaultCapabilities };
        throw new ApiError('Not Found', 404);
      });

      // 1. Visit A
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-a' } }),
      );
      expect(container.textContent).toContain('Document A Initial');

      // 2. Visit B
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-b' } }),
      );
      expect(container.textContent).toContain('Document B Initial');
      expect(container.textContent).not.toContain('Document A Initial');

      // 3. Return to A
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-a' } }),
      );
      expect(container.textContent).toContain('Document A Initial');
      expect(container.textContent).not.toContain('Document B Initial');
    });

    it('Transitions under 404 Not Found show truthful error without persisting across navigation', async () => {
      const docA = createMockDoc({ id: 'doc-a', title: 'Valid Document A' });

      vi.spyOn(api, 'getDocument').mockImplementation(async (wsId, docId) => {
        if (docId === 'doc-a') return { document: docA, effectiveRole: 'editor', capabilities: defaultCapabilities };
        if (docId === 'doc-missing') throw new ApiError('Document Not Found', 404);
        throw new ApiError('Error', 500);
      });

      // 1. Valid A
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-a' } }),
      );
      expect(container.textContent).toContain('Valid Document A');

      // 2. Navigate to 404 doc-missing
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-missing' } }),
      );
      expect(container.textContent).toContain('404: Document Not Found');
      expect(container.textContent).not.toContain('Valid Document A');

      // 3. Navigate back to valid A
      await renderWithContext(
        el(DocumentPage, { params: { workspaceId: 'ws-1', documentId: 'doc-a' } }),
      );
      expect(container.textContent).toContain('Valid Document A');
      expect(container.textContent).not.toContain('404');
    });
  });
});
