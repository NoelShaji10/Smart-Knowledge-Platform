// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WorkspacePage from '../app/(app)/workspaces/[workspaceId]/page';
import { WorkspaceContext } from '../contexts/WorkspaceContext';
import { DocumentNavigationContext, DocumentNavigationContextType } from '../contexts/DocumentNavigationContext';
import { AuthContext } from '../contexts/AuthContext';
import { api, Document, Workspace, WorkspaceMemberListItem } from '../lib/api';

// @ts-expect-error global IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const el = React.createElement as any;

const mockPush = vi.fn();
const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
  usePathname: () => '/workspaces/ws-test',
  useSearchParams: () => new URLSearchParams(),
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

describe('Phase 3: Workspace Dashboard Redesign Tests', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.resetAllMocks();
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

  const createMockWorkspace = (overrides: Partial<Workspace> = {}): Workspace => ({
    id: overrides.id || 'ws-test',
    name: overrides.name || 'Platform Engineering',
    slug: overrides.slug || 'platform-eng',
    created_at: overrides.created_at || new Date().toISOString(),
    updated_at: overrides.updated_at || new Date().toISOString(),
  });

  const createMockDoc = (overrides: Partial<Document> = {}): Document => ({
    id: overrides.id || `doc-${Math.random().toString(36).slice(2, 7)}`,
    workspace_id: overrides.workspace_id || 'ws-test',
    parent_id: overrides.parent_id !== undefined ? overrides.parent_id : null,
    title: overrides.title !== undefined ? overrides.title : 'Architectural Spec',
    content_text: overrides.content_text || 'Core infrastructure architecture and deployment pipelines.',
    is_archived: overrides.is_archived || false,
    created_by: overrides.created_by || 'usr-1',
    created_at: overrides.created_at || new Date().toISOString(),
    updated_at: overrides.updated_at || new Date().toISOString(),
  });

  const mockAuth = {
    user: { id: 'usr-1', email: 'noel@example.com', displayName: 'Noel Anto' },
    loading: false,
    error: null,
    isNetworkError: false,
    clearError: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
  };

  const renderDashboard = async ({
    workspace = createMockWorkspace(),
    userRole = 'owner' as 'owner' | 'admin' | 'editor' | 'viewer' | null,
    documents = [] as Document[],
    members = [{ id: 'usr-1', email: 'noel@example.com', display_name: 'Noel Anto', avatar_url: null, role: 'owner' as const, created_at: new Date().toISOString() }] as WorkspaceMemberListItem[],
  } = {}) => {
    const wsContext: any = {
      workspaces: [workspace],
      activeWorkspace: workspace,
      userRole,
      loading: false,
      error: null,
      refreshWorkspaces: vi.fn().mockResolvedValue([]),
      loadWorkspace: vi.fn().mockResolvedValue(null),
      createWorkspace: vi.fn().mockResolvedValue({} as any),
    };

    const navContext: DocumentNavigationContextType = {
      workspaceId: workspace.id,
      documents,
      activeDocuments: documents.filter((d) => !d.is_archived),
      archivedDocuments: documents.filter((d) => d.is_archived),
      loading: false,
      error: null,
      refreshDocuments: vi.fn().mockResolvedValue([]),
      getAncestors: vi.fn().mockReturnValue([]),
      addDocument: vi.fn(),
      updateDocument: vi.fn(),
      removeDocument: vi.fn(),
    };

    vi.spyOn(api, 'listWorkspaceMembers').mockResolvedValue({ members });
    vi.spyOn(api, 'getWorkspaceMembers').mockResolvedValue({ members });

    await renderComponent(
      el(
        AuthContext.Provider,
        { value: mockAuth },
        el(
          WorkspaceContext.Provider,
          { value: wsContext },
          el(
            DocumentNavigationContext.Provider,
            { value: navContext },
            el(WorkspacePage, { params: { workspaceId: workspace.id } }),
          ),
        ),
      ),
    );
  };

  it('1. Renders editorial workspace header with title, slug, and role badge', async () => {
    const doc1 = createMockDoc({ title: 'Microservices Guide' });
    await renderDashboard({ documents: [doc1] });

    expect(container.textContent).toContain('Platform Engineering');
    expect(container.textContent).toContain('@platform-eng');
    expect(container.textContent).toContain('owner');
    expect(container.textContent).toContain('1 document');
    expect(container.textContent).toContain('Internal Workspace');
  });

  it('2. Renders accurate statistics cards from real workspace data', async () => {
    const doc1 = createMockDoc({ title: 'Doc One', updated_at: new Date().toISOString() });
    const doc2 = createMockDoc({ title: 'Doc Two', updated_at: new Date().toISOString() });
    const doc3 = createMockDoc({
      title: 'Old Doc',
      updated_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    await renderDashboard({
      documents: [doc1, doc2, doc3],
      members: [
        { id: 'u1', email: 'a@x.com', display_name: 'User A', avatar_url: null, role: 'owner', created_at: '' },
        { id: 'u2', email: 'b@x.com', display_name: 'User B', avatar_url: null, role: 'editor', created_at: '' },
      ],
    });

    // Stats Section checks
    expect(container.textContent).toContain('Total Documents');
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain('Active Members');
    expect(container.textContent).toContain('2');
    expect(container.textContent).toContain('Recent Updates');
    // 2 docs were updated within 7 days
    expect(container.textContent).toContain('2 active');
  });

  it('3. Renders document cards with title, text preview, and updated date', async () => {
    const doc1 = createMockDoc({
      id: 'doc-alpha',
      title: 'Kafka Event Pipeline Spec',
      content_text: 'Detailed partitioned event stream design for ingestion pipeline.',
      updated_at: new Date('2026-11-01T10:00:00Z').toISOString(),
    });

    await renderDashboard({ documents: [doc1] });

    const card = container.querySelector('a[href="/workspaces/ws-test/documents/doc-alpha"]');
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain('Kafka Event Pipeline Spec');
    expect(card?.textContent).toContain('Detailed partitioned event stream');
    expect(card?.textContent).toContain('2026');
    expect(card?.textContent).toContain('Nov');
  });

  it('4. Real-time document filter narrows displayed documents without extra network requests', async () => {
    const doc1 = createMockDoc({ id: 'd1', title: 'Authentication Service' });
    const doc2 = createMockDoc({ id: 'd2', title: 'Billing Integration' });

    await renderDashboard({ documents: [doc1, doc2] });

    expect(container.textContent).toContain('Authentication Service');
    expect(container.textContent).toContain('Billing Integration');

    // Type in filter input
    const filterInput = container.querySelector('input[placeholder="Filter recent docs..."]') as HTMLInputElement;
    expect(filterInput).toBeTruthy();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      nativeSetter?.call(filterInput, 'Billing');
      filterInput.dispatchEvent(new Event('input', { bubbles: true }));
      filterInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Should display Billing and hide Authentication
    expect(container.textContent).toContain('Billing Integration');
    expect(container.textContent).not.toContain('Authentication Service');
  });

  it('5. View mode toggle switches between grid view and list view', async () => {
    const doc1 = createMockDoc({ id: 'd1', title: 'Security Architecture' });
    await renderDashboard({ documents: [doc1] });

    const listBtn = container.querySelector('button[title="List view"]') as HTMLButtonElement;
    expect(listBtn).toBeTruthy();

    await act(async () => {
      listBtn.click();
    });

    // List view should be active
    expect(listBtn.getAttribute('aria-pressed')).toBe('true');
  });

  it('6. Empty workspace state renders helpful prompt and creation button for editors', async () => {
    await renderDashboard({ documents: [] });

    expect(container.textContent).toContain('Your workspace is ready.');
    expect(container.textContent).toContain('No documents yet');
    expect(container.textContent).toContain('Create your first document to start writing.');

    const createBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('+ New Document'),
    );
    expect(createBtn).toBeTruthy();
  });

  it('7. Empty workspace state for Viewer hides document creation affordance', async () => {
    await renderDashboard({ documents: [], userRole: 'viewer' });

    expect(container.textContent).toContain('This workspace currently has no active documents.');
    const createBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('+ New Document'),
    );
    expect(createBtn).toBeUndefined();
  });
});
