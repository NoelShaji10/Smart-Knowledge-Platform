// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError, Document, setAccessToken, Workspace } from '../lib/api';
import { AuthContext } from '../contexts/AuthContext';
import { WorkspaceProvider, WorkspaceContext, useWorkspace } from '../contexts/WorkspaceContext';
import {
  DocumentNavigationProvider,
  useDocumentNavigation,
  computeAncestors,
} from '../contexts/DocumentNavigationContext';
import { DocumentTree } from '../components/documents/DocumentTree';
import { Breadcrumbs } from '../components/documents/Breadcrumbs';
import { Sidebar } from '../components/layout/Sidebar';
import { AppShell } from '../components/layout/AppShell';

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

const el = React.createElement as any;

describe('Phase 5 T6 — Workspace Navigation & Application Shell Tests', () => {
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

  const renderWithContext = async (
    ui: React.ReactElement,
    wsOverrides?: any,
  ) => {
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

  const createMockDoc = (overrides: Partial<Document> = {}): Document => ({
    id: overrides.id || `doc-${Math.random().toString(36).slice(2, 8)}`,
    workspace_id: overrides.workspace_id || 'ws-1',
    parent_id: overrides.parent_id !== undefined ? overrides.parent_id : null,
    title: overrides.title !== undefined ? overrides.title : 'Document Title',
    content_text: overrides.content_text || '',
    is_archived: overrides.is_archived || false,
    created_by: overrides.created_by || 'usr-1',
    created_at: overrides.created_at || new Date().toISOString(),
    updated_at: overrides.updated_at || new Date().toISOString(),
  });

  // =========================================================================
  // 1. WORKSPACE SWITCHING & RACE CONDITIONS
  // =========================================================================

  it('1. WorkspaceContext loads workspace list and sets active workspace correctly', async () => {
    const wsA = createMockWorkspace({ id: 'ws-a', name: 'Workspace Alpha' });
    const wsB = createMockWorkspace({ id: 'ws-b', name: 'Workspace Beta' });

    vi.spyOn(api, 'getWorkspaces').mockResolvedValue({ workspaces: [wsA, wsB] });
    vi.spyOn(api, 'getWorkspace').mockResolvedValue({
      workspace: wsA,
      userRole: 'editor',
    });

    function TestConsumer() {
      const { workspaces, activeWorkspace, userRole, loading, loadWorkspace } = useWorkspace();
      React.useEffect(() => {
        loadWorkspace('ws-a');
      }, [loadWorkspace]);

      if (loading) return el('div', null, 'Loading Workspaces...');
      return el(
        'div',
        null,
        el('span', { 'data-testid': 'active-ws' }, activeWorkspace?.name || 'none'),
        el('span', { 'data-testid': 'user-role' }, userRole || 'none'),
        el('span', { 'data-testid': 'count' }, String(workspaces.length)),
      );
    }

    await renderComponent(
      el(
        AuthContext.Provider,
        { value: mockAuthValue },
        el(
          WorkspaceProvider,
          null,
          el(TestConsumer),
        ),
      ),
    );

    await act(async () => {
      await Promise.resolve();
    });

    const activeEl = container.querySelector('[data-testid="active-ws"]');
    expect(activeEl?.textContent).toBe('Workspace Alpha');
    const roleEl = container.querySelector('[data-testid="user-role"]');
    expect(roleEl?.textContent).toBe('editor');
    const countEl = container.querySelector('[data-testid="count"]');
    expect(countEl?.textContent).toBe('2');
  });

  it('2. Workspace switching updates active workspace and handles role transition', async () => {
    const wsA = createMockWorkspace({ id: 'ws-a', name: 'Workspace Alpha' });
    const wsB = createMockWorkspace({ id: 'ws-b', name: 'Workspace Beta' });

    vi.spyOn(api, 'getWorkspaces').mockResolvedValue({ workspaces: [wsA, wsB] });
    const getWorkspaceSpy = vi.spyOn(api, 'getWorkspace').mockImplementation(async (id: string) => {
      if (id === 'ws-a') return { workspace: wsA, userRole: 'editor' as const };
      if (id === 'ws-b') return { workspace: wsB, userRole: 'viewer' as const };
      throw new ApiError('Workspace not found', 404);
    });

    let switchFn: (id: string) => Promise<Workspace | null>;

    function TestConsumer() {
      const { activeWorkspace, userRole, loadWorkspace } = useWorkspace();
      switchFn = loadWorkspace;
      React.useEffect(() => {
        loadWorkspace('ws-a');
      }, [loadWorkspace]);

      return el(
        'div',
        null,
        el('span', { 'data-testid': 'active-ws' }, activeWorkspace?.name || 'none'),
        el('span', { 'data-testid': 'user-role' }, userRole || 'none'),
      );
    }

    await renderComponent(
      el(
        AuthContext.Provider,
        { value: mockAuthValue },
        el(
          WorkspaceProvider,
          null,
          el(TestConsumer),
        ),
      ),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="active-ws"]')?.textContent).toBe('Workspace Alpha');
    expect(container.querySelector('[data-testid="user-role"]')?.textContent).toBe('editor');

    // Switch to Workspace B
    await act(async () => {
      await switchFn('ws-b');
    });

    expect(getWorkspaceSpy).toHaveBeenCalledWith('ws-b');
    expect(container.querySelector('[data-testid="active-ws"]')?.textContent).toBe('Workspace Beta');
    expect(container.querySelector('[data-testid="user-role"]')?.textContent).toBe('viewer');
  });

  it('3. Rapid workspace switching race: stale in-flight response from older request is discarded', async () => {
    const wsA = createMockWorkspace({ id: 'ws-a', name: 'Workspace Alpha' });
    const wsB = createMockWorkspace({ id: 'ws-b', name: 'Workspace Beta' });

    vi.spyOn(api, 'getWorkspaces').mockResolvedValue({ workspaces: [wsA, wsB] });

    let resolveWsB: (val: any) => void;
    const wsBPromise = new Promise((resolve) => {
      resolveWsB = resolve;
    });

    vi.spyOn(api, 'getWorkspace').mockImplementation(async (id: string) => {
      if (id === 'ws-a') {
        return { workspace: wsA, userRole: 'editor' as const };
      }
      if (id === 'ws-b') {
        return wsBPromise as Promise<{ workspace: Workspace; userRole: 'editor' }>;
      }
      throw new ApiError('Not found', 404);
    });

    let switchFn: (id: string) => Promise<Workspace | null>;

    function TestConsumer() {
      const { activeWorkspace, loadWorkspace } = useWorkspace();
      switchFn = loadWorkspace;
      React.useEffect(() => {
        loadWorkspace('ws-a');
      }, [loadWorkspace]);

      return el('div', { 'data-testid': 'active-ws' }, activeWorkspace?.name || 'none');
    }

    await renderComponent(
      el(
        AuthContext.Provider,
        { value: mockAuthValue },
        el(
          WorkspaceProvider,
          null,
          el(TestConsumer),
        ),
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="active-ws"]')?.textContent).toBe('Workspace Alpha');

    // Initiate switch to B (starts async request that is delayed)
    let pSwitchB: Promise<Workspace | null>;
    act(() => {
      pSwitchB = switchFn('ws-b');
    });

    // Immediately switch back to A before B finishes
    await act(async () => {
      await switchFn('ws-a');
    });
    expect(container.querySelector('[data-testid="active-ws"]')?.textContent).toBe('Workspace Alpha');

    // Now delayed B request finally resolves
    await act(async () => {
      resolveWsB!({ workspace: wsB, userRole: 'viewer' });
      await pSwitchB!;
    });

    // Invariant: B must NOT overwrite A because request was superseded
    expect(container.querySelector('[data-testid="active-ws"]')?.textContent).toBe('Workspace Alpha');
  });

  it('4. Unauthorized workspace returns truthful 403 error without fabricating workspace', async () => {
    vi.spyOn(api, 'getWorkspaces').mockResolvedValue({ workspaces: [] });
    vi.spyOn(api, 'getWorkspace').mockRejectedValue(new ApiError('Forbidden', 403));

    function TestConsumer() {
      const { activeWorkspace, error, loadWorkspace } = useWorkspace();
      React.useEffect(() => {
        loadWorkspace('unauth-ws');
      }, [loadWorkspace]);

      return el(
        'div',
        null,
        el('span', { 'data-testid': 'ws-state' }, activeWorkspace ? 'active' : 'null'),
        el('span', { 'data-testid': 'err-state' }, error || 'no-error'),
      );
    }

    await renderComponent(
      el(
        AuthContext.Provider,
        { value: mockAuthValue },
        el(
          WorkspaceProvider,
          null,
          el(TestConsumer),
        ),
      ),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="ws-state"]')?.textContent).toBe('null');
    expect(container.querySelector('[data-testid="err-state"]')?.textContent).toContain(
      'Access denied: You do not have permission',
    );
  });

  // =========================================================================
  // 2. DOCUMENT NAVIGATION CONTEXT & STATE UNIFICATION
  // =========================================================================

  it('5. DocumentNavigationProvider fetches documents and exposes active, archived, and ancestors', async () => {
    const docRoot = createMockDoc({ id: 'doc-1', title: 'Root Overview' });
    const docChild = createMockDoc({ id: 'doc-2', title: 'Architecture', parent_id: 'doc-1' });
    const docArchived = createMockDoc({ id: 'doc-3', title: 'Legacy Specs', is_archived: true });

    vi.spyOn(api, 'listDocuments').mockResolvedValue({
      documents: [docRoot, docChild, docArchived],
    });

    function NavConsumer() {
      const { documents, activeDocuments, archivedDocuments, getAncestors, loading } =
        useDocumentNavigation();
      if (loading) return el('div', null, 'Loading Docs...');
      const childAncestors = getAncestors('doc-2');

      return el(
        'div',
        null,
        el('span', { 'data-testid': 'total-docs' }, String(documents.length)),
        el('span', { 'data-testid': 'active-docs' }, String(activeDocuments.length)),
        el('span', { 'data-testid': 'archived-docs' }, String(archivedDocuments.length)),
        el(
          'span',
          { 'data-testid': 'child-ancestor' },
          childAncestors.map((a) => a.title).join(' > '),
        ),
      );
    }

    await renderComponent(
      el(
        DocumentNavigationProvider,
        { workspaceId: 'ws-1' },
        el(NavConsumer),
      ),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="total-docs"]')?.textContent).toBe('3');
    expect(container.querySelector('[data-testid="active-docs"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-testid="archived-docs"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-testid="child-ancestor"]')?.textContent).toBe('Root Overview');
  });

  it('6. Document mutations (add, update, remove) keep navigation synchronized', async () => {
    const doc1 = createMockDoc({ id: 'doc-1', title: 'Original Doc' });
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [doc1] });

    let navActions: {
      addDocument: (doc: Document) => void;
      updateDocument: (doc: Document) => void;
      removeDocument: (id: string) => void;
    };

    function NavConsumer() {
      const nav = useDocumentNavigation();
      navActions = nav;
      return el(
        'div',
        null,
        nav.activeDocuments.map((d) =>
          el('div', { key: d.id, 'data-testid': `doc-${d.id}` }, d.title),
        ),
      );
    }

    await renderComponent(
      el(
        DocumentNavigationProvider,
        { workspaceId: 'ws-1' },
        el(NavConsumer),
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="doc-doc-1"]')?.textContent).toBe('Original Doc');

    // Add document
    const doc2 = createMockDoc({ id: 'doc-2', title: 'New Doc' });
    await act(async () => {
      navActions.addDocument(doc2);
    });
    expect(container.querySelector('[data-testid="doc-doc-2"]')?.textContent).toBe('New Doc');

    // Update document
    const updatedDoc1 = { ...doc1, title: 'Renamed Doc' };
    await act(async () => {
      navActions.updateDocument(updatedDoc1);
    });
    expect(container.querySelector('[data-testid="doc-doc-1"]')?.textContent).toBe('Renamed Doc');

    // Remove document
    await act(async () => {
      navActions.removeDocument('doc-2');
    });
    expect(container.querySelector('[data-testid="doc-doc-2"]')).toBeNull();
  });

  it('7. Stale document request discarded when switching workspaces in DocumentNavigationProvider', async () => {
    const ws1Docs = [createMockDoc({ id: 'ws1-doc', title: 'Doc in WS 1', workspace_id: 'ws-1' })];
    const ws2Docs = [createMockDoc({ id: 'ws2-doc', title: 'Doc in WS 2', workspace_id: 'ws-2' })];

    let resolveWs2: (val: any) => void;
    const ws2Promise = new Promise((resolve) => {
      resolveWs2 = resolve;
    });

    vi.spyOn(api, 'listDocuments').mockImplementation(async (wsId: string) => {
      if (wsId === 'ws-1') return { documents: ws1Docs };
      if (wsId === 'ws-2') return ws2Promise as Promise<{ documents: Document[] }>;
      return { documents: [] };
    });

    function TestWrapper({ wsId }: { wsId: string }) {
      return el(
        DocumentNavigationProvider,
        { workspaceId: wsId },
        el(NavList),
      );
    }

    function NavList() {
      const { activeDocuments } = useDocumentNavigation();
      return el(
        'div',
        null,
        activeDocuments.map((d) =>
          el('span', { key: d.id, 'data-testid': 'doc-item' }, d.title),
        ),
      );
    }

    await renderComponent(el(TestWrapper, { wsId: 'ws-1' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="doc-item"]')?.textContent).toBe('Doc in WS 1');

    // Switch to ws-2 (delayed)
    await renderComponent(el(TestWrapper, { wsId: 'ws-2' }));

    // Switch back to ws-1 before ws-2 resolves
    await renderComponent(el(TestWrapper, { wsId: 'ws-1' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="doc-item"]')?.textContent).toBe('Doc in WS 1');

    // Resolve ws-2 delayed response
    await act(async () => {
      resolveWs2!({ documents: ws2Docs });
      await Promise.resolve();
    });

    // Invariant: ws-2 documents MUST NOT overwrite ws-1 documents
    expect(container.querySelector('[data-testid="doc-item"]')?.textContent).toBe('Doc in WS 1');
  });

  // =========================================================================
  // 3. BREADCRUMBS & HIERARCHY SAFETY
  // =========================================================================

  it('8. computeAncestors handles deep hierarchy, missing parent, and cycle prevention', () => {
    const docRoot = createMockDoc({ id: 'root', title: 'Root', parent_id: null });
    const docLevel1 = createMockDoc({ id: 'l1', title: 'Level 1', parent_id: 'root' });
    const docLevel2 = createMockDoc({ id: 'l2', title: 'Level 2', parent_id: 'l1' });
    const docLevel3 = createMockDoc({ id: 'l3', title: 'Level 3', parent_id: 'l2' });

    const allDocs = [docRoot, docLevel1, docLevel2, docLevel3];

    // Standard deep hierarchy
    const ancestors = computeAncestors('l3', allDocs);
    expect(ancestors.map((a) => a.id)).toEqual(['root', 'l1', 'l2']);

    // Missing parent orphan
    const orphanDoc = createMockDoc({ id: 'orphan', title: 'Orphan', parent_id: 'non-existent' });
    const orphanAncestors = computeAncestors('orphan', [...allDocs, orphanDoc]);
    expect(orphanAncestors).toEqual([]);

    // Cyclic hierarchy safety (cycle between node-a and node-b)
    const cycleA = createMockDoc({ id: 'cycle-a', title: 'Cycle A', parent_id: 'cycle-b' });
    const cycleB = createMockDoc({ id: 'cycle-b', title: 'Cycle B', parent_id: 'cycle-a' });
    const cycleAncestors = computeAncestors('cycle-a', [cycleA, cycleB]);
    expect(cycleAncestors.map((a) => a.id)).toEqual(['cycle-b']); // Stops gracefully, no infinite loop
  });

  it('9. Breadcrumbs component renders correct hierarchy with link targets', async () => {
    const docRoot = createMockDoc({ id: 'root-1', title: 'Engineering Handbook' });
    const docChild = createMockDoc({ id: 'child-1', title: 'Infrastructure', parent_id: 'root-1' });

    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [docRoot, docChild] });

    await renderComponent(
      el(
        DocumentNavigationProvider,
        { workspaceId: 'ws-1' },
        el(Breadcrumbs, {
          workspaceId: 'ws-1',
          workspaceName: 'Engineering WS',
          currentDocument: docChild,
        }),
      ),
    );

    await act(async () => {
      await Promise.resolve();
    });

    const links = Array.from(container.querySelectorAll('a'));
    expect(links.length).toBe(2);
    // First link: Workspace
    expect(links[0].textContent).toContain('Engineering WS');
    expect(links[0].getAttribute('href')).toBe('/workspaces/ws-1');

    // Second link: Parent Document
    expect(links[1].textContent).toContain('Engineering Handbook');
    expect(links[1].getAttribute('href')).toBe('/workspaces/ws-1/documents/root-1');

    // Current Document: Plain text / active crumb
    const currentSpan = container.querySelector('[aria-current="page"]');
    expect(currentSpan?.textContent).toBe('Infrastructure');
  });

  // =========================================================================
  // 4. DOCUMENT TREE BEHAVIOR & ANCESTOR EXPANSION
  // =========================================================================

  it('10. DocumentTree auto-expands ancestors when navigating to active document', async () => {
    const parentDoc = createMockDoc({ id: 'parent-1', title: 'Parent Chapter' });
    const childDoc = createMockDoc({ id: 'child-1', title: 'Active Section', parent_id: 'parent-1' });

    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [parentDoc, childDoc] });
    mockCurrentPath = '/workspaces/ws-1/documents/child-1';

    await renderWithContext(
      el(
        DocumentNavigationProvider,
        { workspaceId: 'ws-1' },
        el(DocumentTree, { currentDocId: 'child-1' }),
      ),
    );

    await act(async () => {
      await Promise.resolve();
    });

    // Parent Chapter and Active Section must both be visible
    expect(container.textContent).toContain('Parent Chapter');
    expect(container.textContent).toContain('Active Section');

    // Collapse button should be present for parent-1 since it was auto-expanded
    const collapseBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Collapse sub-documents',
    );
    expect(collapseBtn).toBeDefined();
  });

  // =========================================================================
  // 5. MOBILE APPLICATION SHELL & SIDEBAR INTERACTIONS
  // =========================================================================

  it('11. Mobile sidebar close button invokes onClose', async () => {
    let closeCalled = false;
    const onClose = () => {
      closeCalled = true;
    };

    await renderWithContext(
      el(Sidebar, {
        onClose: onClose,
      }),
    );

    // Mobile close button should trigger onClose
    const closeBtn = container.querySelector('button[aria-label="Close navigation sidebar"]') as HTMLButtonElement;
    expect(closeBtn).toBeDefined();
    await act(async () => {
      closeBtn.click();
    });
    expect(closeCalled).toBe(true);
  });

  it('12. AppShell handles mobile drawer state, backdrop click, and Escape key', async () => {
    await renderWithContext(
      el(
        AppShell,
        { workspaceRole: 'editor' },
        el('div', null, 'Main Workspace Content'),
      ),
    );

    // Main content rendered
    expect(container.textContent).toContain('Main Workspace Content');

    // Initially mobile sidebar is closed: backdrop lacks open modifier
    const backdrop = container.querySelector('div[aria-hidden="true"]');
    expect(backdrop).toBeDefined();
    expect(backdrop?.className).not.toContain('backdropOpen');

    // Trigger mobile hamburger button
    const menuBtn = container.querySelector('button[aria-label="Toggle navigation menu"]') as HTMLButtonElement;
    expect(menuBtn).toBeDefined();

    await act(async () => {
      menuBtn.click();
    });

    // Backdrop should now have backdropOpen class
    expect(backdrop?.className).toContain('backdropOpen');

    // Click backdrop closes sidebar
    await act(async () => {
      (backdrop as HTMLElement).click();
    });

    expect(backdrop?.className).not.toContain('backdropOpen');

    // Reopen and test Escape key
    await act(async () => {
      menuBtn.click();
    });
    expect(backdrop?.className).toContain('backdropOpen');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(backdrop?.className).not.toContain('backdropOpen');
  });

  it('13. Selecting a document link in DocumentTree invokes onNavigate callback', async () => {
    const doc1 = createMockDoc({ id: 'doc-nav-1', title: 'Target Document' });
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [doc1] });

    let navigated = false;
    const onNavigate = () => {
      navigated = true;
    };

    await renderWithContext(
      el(
        DocumentNavigationProvider,
        { workspaceId: 'ws-1' },
        el(DocumentTree, { onNavigate }),
      ),
    );

    await act(async () => {
      await Promise.resolve();
    });

    const docLink = container.querySelector('a[href="/workspaces/ws-1/documents/doc-nav-1"]') as HTMLAnchorElement;
    expect(docLink).toBeDefined();

    await act(async () => {
      docLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(navigated).toBe(true);
  });

  // =========================================================================
  // 6. TRUTHFUL STATES: EMPTY, ERROR, RETRY, STALE PRESERVATION
  // =========================================================================

  it('14. DocumentTree displays truthful empty state when request succeeds with 0 documents', async () => {
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [] });

    await renderWithContext(
      el(
        DocumentNavigationProvider,
        { workspaceId: 'ws-1' },
        el(DocumentTree),
      ),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('No documents in this workspace yet.');
  });

  it('15. DocumentTree displays truthful error state on failure and retries successfully', async () => {
    const listSpy = vi
      .spyOn(api, 'listDocuments')
      .mockRejectedValueOnce(new ApiError('Server offline', 500))
      .mockResolvedValueOnce({
        documents: [createMockDoc({ id: 'doc-recovered', title: 'Recovered Document' })],
      });

    await renderWithContext(
      el(
        DocumentNavigationProvider,
        { workspaceId: 'ws-1' },
        el(DocumentTree),
      ),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Server offline');
    const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Retry'),
    );
    expect(retryBtn).toBeDefined();

    // Click retry
    await act(async () => {
      retryBtn!.click();
    });

    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Recovered Document');
  });

  it('16. Failed refresh preserves existing loaded documents with an explicit stale error toast', async () => {
    const existingDoc = createMockDoc({ id: 'doc-stable', title: 'Stable Working Document' });
    vi.spyOn(api, 'listDocuments')
      .mockResolvedValueOnce({ documents: [existingDoc] })
      .mockRejectedValueOnce(new ApiError('Failed to refresh', 500));

    let triggerRefresh: () => Promise<Document[]>;

    function NavConsumer() {
      const { refreshDocuments } = useDocumentNavigation();
      triggerRefresh = refreshDocuments;
      return el(DocumentTree);
    }

    await renderWithContext(
      el(
        DocumentNavigationProvider,
        { workspaceId: 'ws-1' },
        el(NavConsumer),
      ),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Stable Working Document');

    // Trigger refresh that fails
    await act(async () => {
      await triggerRefresh();
    });

    // Existing document is NOT wiped out
    expect(container.textContent).toContain('Stable Working Document');
    // Stale notice banner is shown
    expect(container.textContent).toContain('Could not refresh documents. Your last loaded data is still shown.');
  });

  // =========================================================================
  // 7. PERMISSION SEMANTICS & UI HONESTY
  // =========================================================================

  it('17. Viewer user does not see document creation affordance in DocumentTree', async () => {
    mockCurrentPath = '/workspaces/ws-1';
    const doc1 = createMockDoc({ id: 'doc-view', title: 'Read-Only Document' });
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [doc1] });

    await renderWithContext(
      el(
        DocumentNavigationProvider,
        { workspaceId: 'ws-1' },
        el(DocumentTree, { workspaceRole: 'viewer' }),
      ),
      { userRole: 'viewer' },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Read-Only Document');
    // "+ New Document" button should NOT be present for viewer
    const newDocBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('New Document'),
    );
    expect(newDocBtn).toBeUndefined();
  });
});
