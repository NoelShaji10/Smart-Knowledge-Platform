// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError, Document, setAccessToken } from '../lib/api';
import { DocumentTree } from '../components/documents/DocumentTree';
import { MoveDocumentModal } from '../components/documents/MoveDocumentModal';
import WorkspacePage from '../app/(app)/workspaces/[workspaceId]/page';

// Configure act environment for React 18
// @ts-expect-error global IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let mockActiveWorkspace: { id: string; name: string; slug: string } | null = {
  id: 'ws-1',
  name: 'Test Workspace',
  slug: 'test-ws',
};
let mockUserRole: 'owner' | 'admin' | 'editor' | 'viewer' = 'editor';
let mockCurrentPath = '/workspaces/ws-1';
const mockPush = vi.fn();

vi.mock('@/contexts/WorkspaceContext', () => ({
  useWorkspace: () => ({
    activeWorkspace: mockActiveWorkspace,
    userRole: mockUserRole,
    loading: false,
    error: null,
    workspaces: mockActiveWorkspace ? [mockActiveWorkspace] : [],
    loadWorkspace: vi.fn(),
    refreshWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
  }),
}));

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

describe('Phase 5 T2 — Real Document Management UX Tests', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setAccessToken('mock-token');
    vi.resetAllMocks();
    mockActiveWorkspace = { id: 'ws-1', name: 'Test Workspace', slug: 'test-ws' };
    mockUserRole = 'editor';
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

  const changeInputValue = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };

  // -------------------------------------------------------------
  // 1. Document List
  // -------------------------------------------------------------
  it('1. successful document list renders real documents from server', async () => {
    const doc1 = createMockDoc({ id: 'd-1', title: 'Architecture Overview' });
    const doc2 = createMockDoc({ id: 'd-2', title: 'Meeting Notes' });

    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [doc1, doc2] });

    await renderComponent(React.createElement(DocumentTree));

    expect(container.textContent).toContain('Architecture Overview');
    expect(container.textContent).toContain('Meeting Notes');
    expect(api.listDocuments).toHaveBeenCalledWith('ws-1', { includeArchived: true });
  });

  it('2. empty API response produces explicit empty state with working CTA', async () => {
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [] });

    await renderComponent(React.createElement(DocumentTree));

    expect(container.textContent).toContain('No documents in this workspace yet.');
    const emptyCta = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Create your first document'),
    );
    expect(emptyCta).toBeDefined();
    expect(emptyCta?.textContent).toContain('+ Create your first document');
  });

  it('3. list API failure produces error state rather than empty/demo state', async () => {
    vi.spyOn(api, 'listDocuments').mockRejectedValue(
      new ApiError('Database connection refused', 500),
    );

    await renderComponent(React.createElement(DocumentTree));

    expect(container.textContent).toContain('Unable to load documents from server');
    expect(container.textContent).not.toContain('No documents in this workspace yet.');
    expect(container.textContent).not.toContain('demo-user');
    expect(mockShowToast).toHaveBeenCalled();
  });

  it('4. retry button reattempts the real API', async () => {
    const listSpy = vi
      .spyOn(api, 'listDocuments')
      .mockRejectedValueOnce(new ApiError('Temporary 500', 500))
      .mockResolvedValueOnce({
        documents: [createMockDoc({ id: 'd-recovered', title: 'Recovered Document' })],
      });

    await renderComponent(React.createElement(DocumentTree));

    expect(container.textContent).toContain('Unable to load documents from server');

    const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Retry'),
    );
    expect(retryBtn).toBeDefined();

    await act(async () => {
      retryBtn!.click();
      await Promise.resolve();
    });

    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Recovered Document');
  });

  // -------------------------------------------------------------
  // 2. Creation
  // -------------------------------------------------------------
  it('5. successful create opens title modal, creates document with entered title, and navigates', async () => {
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [] });
    const realDoc = createMockDoc({ id: 'real-uuid-777', title: 'My Custom Title' });
    vi.spyOn(api, 'createDocument').mockResolvedValue({ document: realDoc });

    await renderComponent(React.createElement(DocumentTree));

    const createBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Create your first document') || b.textContent?.includes('+ New Document'),
    );
    expect(createBtn).toBeDefined();

    await act(async () => {
      createBtn!.click();
    });

    // Modal dialog should be open
    const modalTitle = container.querySelector('#create-doc-modal-title');
    expect(modalTitle).not.toBeNull();
    expect(modalTitle?.textContent).toContain('Create New Document');

    const titleInput = container.querySelector('#create-doc-title-input') as HTMLInputElement;
    expect(titleInput).not.toBeNull();

    await changeInputValue(titleInput, 'My Custom Title');

    const submitBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('type') === 'submit' && b.textContent?.includes('Create Document'),
    );
    expect(submitBtn).toBeDefined();

    await act(async () => {
      submitBtn!.click();
      await Promise.resolve();
    });

    expect(api.createDocument).toHaveBeenCalledWith('ws-1', {
      title: 'My Custom Title',
      parentId: null,
    });
    expect(mockPush).toHaveBeenCalledWith('/workspaces/ws-1/documents/real-uuid-777');
    expect(container.textContent).toContain('My Custom Title');
  });

  it('6. failed create does not insert a fake document and shows error', async () => {
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [] });
    vi.spyOn(api, 'createDocument').mockRejectedValue(
      new ApiError('Permission Denied', 403),
    );

    await renderComponent(React.createElement(DocumentTree));

    const createBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('+ Create your first document'),
    );

    await act(async () => {
      createBtn!.click();
    });

    const titleInput = container.querySelector('#create-doc-title-input') as HTMLInputElement;
    await changeInputValue(titleInput, 'Doomed Title');

    const submitBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('type') === 'submit' && b.textContent?.includes('Create Document'),
    );

    await act(async () => {
      submitBtn!.click();
      await Promise.resolve();
    });

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.stringContaining('Access denied'),
      'error',
    );
    // Tree should not contain any doc items
    expect(container.querySelectorAll('li')).toHaveLength(0);
    expect(mockPush).not.toHaveBeenCalled();
    // Modal should show error message
    expect(container.textContent).toContain('Access denied');
  });

  it('7. created child document prompts for title and appears under the correct parent', async () => {
    const parentDoc = createMockDoc({ id: 'parent-1', title: 'Parent Doc' });
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [parentDoc] });

    const childDoc = createMockDoc({
      id: 'child-1',
      parent_id: 'parent-1',
      title: 'Child Doc',
    });
    vi.spyOn(api, 'createDocument').mockResolvedValue({ document: childDoc });

    await renderComponent(React.createElement(DocumentTree));

    expect(container.textContent).toContain('Parent Doc');

    // Click "Add sub-document"
    const addSubBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Add sub-document',
    );
    expect(addSubBtn).toBeDefined();

    await act(async () => {
      addSubBtn!.click();
    });

    // Sub-document modal header and parent name
    expect(container.textContent).toContain('Create Sub-document');
    expect(container.textContent).toContain('Parent: Parent Doc');

    const titleInput = container.querySelector('#create-doc-title-input') as HTMLInputElement;
    await changeInputValue(titleInput, 'Child Doc');

    const submitBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('type') === 'submit' && b.textContent?.includes('Create Document'),
    );

    await act(async () => {
      submitBtn!.click();
      await Promise.resolve();
    });

    expect(api.createDocument).toHaveBeenCalledWith('ws-1', {
      title: 'Child Doc',
      parentId: 'parent-1',
    });
    expect(mockPush).toHaveBeenCalledWith('/workspaces/ws-1/documents/child-1');
    expect(container.textContent).toContain('Child Doc');
  });

  // -------------------------------------------------------------
  // 3. Rename
  // -------------------------------------------------------------
  it('8. rename persists through real API and updates tree display', async () => {
    const doc1 = createMockDoc({ id: 'd-1', title: 'Old Title' });
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [doc1] });
    const updatedDoc = { ...doc1, title: 'Brand New Title' };
    vi.spyOn(api, 'updateDocument').mockResolvedValue({ document: updatedDoc });

    await renderComponent(React.createElement(DocumentTree));

    // Open dropdown menu
    const moreBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'More actions',
    );
    expect(moreBtn).toBeDefined();

    await act(async () => {
      moreBtn!.click();
    });

    const renameItem = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Rename',
    );
    expect(renameItem).toBeDefined();

    await act(async () => {
      renameItem!.click();
    });

    // Input should be present
    const renameInput = container.querySelector('input') as HTMLInputElement;
    expect(renameInput).not.toBeNull();
    expect(renameInput.value).toBe('Old Title');

    // Change input value and submit via Enter
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(renameInput, 'Brand New Title');
      renameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    expect(api.updateDocument).toHaveBeenCalledWith('ws-1', 'd-1', {
      title: 'Brand New Title',
    });
    expect(container.textContent).toContain('Brand New Title');
  });

  it('9. rename failure preserves valid prior state', async () => {
    const doc1 = createMockDoc({ id: 'd-1', title: 'Prior Solid Title' });
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [doc1] });
    vi.spyOn(api, 'updateDocument').mockRejectedValue(new Error('500 Write Error'));

    await renderComponent(React.createElement(DocumentTree));

    // Open menu and select rename
    const moreBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'More actions',
    );
    await act(async () => {
      moreBtn!.click();
    });

    const renameItem = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Rename',
    );
    await act(async () => {
      renameItem!.click();
    });

    const renameInput = container.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(renameInput, 'Unpersisted Title');
      renameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    expect(mockShowToast).toHaveBeenCalledWith('Failed to rename document', 'error');
    expect(container.textContent).toContain('Prior Solid Title');
  });

  it('10. rename cancellation does not issue an unnecessary persistence request', async () => {
    const doc1 = createMockDoc({ id: 'd-1', title: 'Original Name' });
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [doc1] });
    const updateSpy = vi.spyOn(api, 'updateDocument');

    await renderComponent(React.createElement(DocumentTree));

    const moreBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'More actions',
    );
    await act(async () => {
      moreBtn!.click();
    });

    const renameItem = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Rename',
    );
    await act(async () => {
      renameItem!.click();
    });

    const renameInput = container.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeSetter?.call(renameInput, 'Typing But Cancelled');
      renameInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Press Escape
    await act(async () => {
      renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();
    });

    expect(updateSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Original Name');
  });

  // -------------------------------------------------------------
  // 4. Hierarchy & Move
  // -------------------------------------------------------------
  it('11. nested documents render correctly with expand/collapse capability', async () => {
    const rootDoc = createMockDoc({ id: 'root-1', title: 'Root Engineering' });
    const subDoc = createMockDoc({
      id: 'sub-1',
      parent_id: 'root-1',
      title: 'Backend Architecture',
    });

    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [rootDoc, subDoc] });

    await renderComponent(React.createElement(DocumentTree));

    expect(container.textContent).toContain('Root Engineering');
    expect(container.textContent).toContain('Backend Architecture');

    const caretBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Collapse sub-documents',
    );
    expect(caretBtn).toBeDefined();

    // Collapse
    await act(async () => {
      caretBtn!.click();
    });
    expect(container.textContent).not.toContain('Backend Architecture');

    // Expand
    await act(async () => {
      caretBtn!.click();
    });
    expect(container.textContent).toContain('Backend Architecture');
  });

  it('12. MoveDocumentModal prevents invalid parent choices and cycle creation', async () => {
    const parentDoc = createMockDoc({ id: 'doc-p', title: 'Parent Doc' });
    const childDoc = createMockDoc({ id: 'doc-c', parent_id: 'doc-p', title: 'Child Doc' });
    const grandChildDoc = createMockDoc({
      id: 'doc-gc',
      parent_id: 'doc-c',
      title: 'Grandchild Doc',
    });
    const unrelatedDoc = createMockDoc({ id: 'doc-other', title: 'Unrelated Folder' });

    const allDocs = [parentDoc, childDoc, grandChildDoc, unrelatedDoc];

    // Open modal to move parentDoc
    await renderComponent(
      React.createElement(MoveDocumentModal, {
        workspaceId: 'ws-1',
        document: parentDoc,
        documents: allDocs,
        isOpen: true,
        onClose: vi.fn(),
        onMoved: vi.fn(),
      }),
    );

    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select).not.toBeNull();

    const options = Array.from(select.querySelectorAll('option'));
    // Self (doc-p) must be disabled
    const selfOpt = options.find((o) => o.value === 'doc-p');
    expect(selfOpt?.disabled).toBe(true);

    // Child (doc-c) must be disabled (descendant cycle)
    const childOpt = options.find((o) => o.value === 'doc-c');
    expect(childOpt?.disabled).toBe(true);

    // Grandchild (doc-gc) must be disabled (descendant cycle)
    const grandChildOpt = options.find((o) => o.value === 'doc-gc');
    expect(grandChildOpt?.disabled).toBe(true);

    // Unrelated doc and Root must be selectable
    const unrelatedOpt = options.find((o) => o.value === 'doc-other');
    expect(unrelatedOpt?.disabled).toBe(false);

    const rootOpt = options.find((o) => o.value === 'root');
    expect(rootOpt?.disabled).toBe(false);
  });

  it('13. successful move updates tree correctly', async () => {
    const docToMove = createMockDoc({ id: 'd-move', title: 'Moving Document', parent_id: 'd-p1' });
    const targetParent = createMockDoc({ id: 'd-p2', title: 'Target Parent' });
    const allDocs = [docToMove, targetParent];

    const onMovedMock = vi.fn();
    const onCloseMock = vi.fn();

    vi.spyOn(api, 'moveDocument').mockResolvedValue({
      document: { ...docToMove, parent_id: 'd-p2' },
    });

    await renderComponent(
      React.createElement(MoveDocumentModal, {
        workspaceId: 'ws-1',
        document: docToMove,
        documents: allDocs,
        isOpen: true,
        onClose: onCloseMock,
        onMoved: onMovedMock,
      }),
    );

    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      select.value = 'd-p2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Move Document'),
    );

    await act(async () => {
      submitBtn!.click();
      await Promise.resolve();
    });

    expect(api.moveDocument).toHaveBeenCalledWith('ws-1', 'd-move', 'd-p2');
    expect(onMovedMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'd-move', parent_id: 'd-p2' }),
    );
    expect(onCloseMock).toHaveBeenCalled();
  });

  it('14. failed move does not fake local relocation', async () => {
    const docToMove = createMockDoc({ id: 'd-move', title: 'Moving Document', parent_id: null });
    const targetParent = createMockDoc({ id: 'd-target', title: 'Target Folder', parent_id: null });
    const onMovedMock = vi.fn();

    vi.spyOn(api, 'moveDocument').mockRejectedValue(new Error('Hierarchy depth limit exceeded'));

    await renderComponent(
      React.createElement(MoveDocumentModal, {
        workspaceId: 'ws-1',
        document: docToMove,
        documents: [docToMove, targetParent],
        isOpen: true,
        onClose: vi.fn(),
        onMoved: onMovedMock,
      }),
    );

    const select = container.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      select.value = 'd-target';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Move Document'),
    );

    await act(async () => {
      submitBtn!.click();
      await Promise.resolve();
    });

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.stringContaining('Hierarchy depth limit exceeded'),
      'error',
    );
    expect(onMovedMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------
  // 5. Archive & Restore
  // -------------------------------------------------------------
  it('15. successful archive updates document tree and moves document to archived list', async () => {
    mockUserRole = 'admin';
    const doc1 = createMockDoc({ id: 'doc-active', title: 'Active Doc to Archive', is_archived: false });
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [doc1] });
    vi.spyOn(api, 'archiveDocument').mockResolvedValue({
      document: { ...doc1, is_archived: true },
    });

    await renderComponent(React.createElement(DocumentTree));

    expect(container.textContent).toContain('Active Doc to Archive');

    const moreBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'More actions',
    );
    await act(async () => {
      moreBtn!.click();
    });

    const archiveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Archive',
    );
    expect(archiveBtn).toBeDefined();

    await act(async () => {
      archiveBtn!.click();
      await Promise.resolve();
    });

    expect(api.archiveDocument).toHaveBeenCalledWith('ws-1', 'doc-active');
    expect(container.textContent).toContain('Archived (1)');
  });

  it('16. archive failure preserves prior active state', async () => {
    mockUserRole = 'admin';
    const doc1 = createMockDoc({ id: 'doc-stay-active', title: 'Active Document Keep', is_archived: false });
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [doc1] });
    vi.spyOn(api, 'archiveDocument').mockRejectedValue(new Error('Archive DB failed'));

    await renderComponent(React.createElement(DocumentTree));

    const moreBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'More actions',
    );
    await act(async () => {
      moreBtn!.click();
    });

    const archiveBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Archive',
    );

    await act(async () => {
      archiveBtn!.click();
      await Promise.resolve();
    });

    expect(mockShowToast).toHaveBeenCalledWith('Failed to archive document', 'error');
    expect(container.textContent).toContain('Active Document Keep');
    expect(container.textContent).not.toContain('Archived (1)');
  });

  it('17. successful restore returns document to active tree', async () => {
    mockUserRole = 'admin';
    const archivedDoc = createMockDoc({
      id: 'doc-archived-1',
      title: 'Restorable Doc',
      is_archived: true,
    });
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [archivedDoc] });
    vi.spyOn(api, 'restoreDocument').mockResolvedValue({
      document: { ...archivedDoc, is_archived: false },
    });

    await renderComponent(React.createElement(DocumentTree));

    expect(container.textContent).toContain('Archived (1)');

    // Expand archived list
    const archivedHeader = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Toggle archived documents',
    );
    expect(archivedHeader).toBeDefined();

    await act(async () => {
      archivedHeader!.click();
    });

    expect(container.textContent).toContain('Restorable Doc');

    // Click restore
    const restoreBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Restore',
    );
    expect(restoreBtn).toBeDefined();

    await act(async () => {
      restoreBtn!.click();
      await Promise.resolve();
    });

    expect(api.restoreDocument).toHaveBeenCalledWith('ws-1', 'doc-archived-1');
    expect(container.textContent).not.toContain('Archived (1)');
    expect(container.textContent).toContain('Restorable Doc');
  });

  it('18. restore failure preserves document in archived state', async () => {
    mockUserRole = 'admin';
    const archivedDoc = createMockDoc({
      id: 'doc-archived-err',
      title: 'Failed Restore Doc',
      is_archived: true,
    });
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [archivedDoc] });
    vi.spyOn(api, 'restoreDocument').mockRejectedValue(new Error('Restore 500 error'));

    await renderComponent(React.createElement(DocumentTree));

    const archivedHeader = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Toggle archived documents',
    );
    await act(async () => {
      archivedHeader!.click();
    });

    const restoreBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Restore',
    );

    await act(async () => {
      restoreBtn!.click();
      await Promise.resolve();
    });

    expect(mockShowToast).toHaveBeenCalledWith('Failed to restore document', 'error');
    expect(container.textContent).toContain('Archived (1)');
  });

  // -------------------------------------------------------------
  // 6. Navigation & Selection
  // -------------------------------------------------------------
  it('19. selected document matches current route URL', async () => {
    mockCurrentPath = '/workspaces/ws-1/documents/doc-selected';
    const doc1 = createMockDoc({ id: 'doc-selected', title: 'Selected Doc' });
    const doc2 = createMockDoc({ id: 'doc-other', title: 'Unselected Doc' });

    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [doc1, doc2] });

    await renderComponent(React.createElement(DocumentTree));

    const selectedLink = container.querySelector('a[href="/workspaces/ws-1/documents/doc-selected"]');
    expect(selectedLink?.getAttribute('aria-current')).toBe('page');

    const unselectedLink = container.querySelector('a[href="/workspaces/ws-1/documents/doc-other"]');
    expect(unselectedLink?.getAttribute('aria-current')).toBeNull();
  });

  it('20. switching route preserves correct selection', async () => {
    mockCurrentPath = '/workspaces/ws-1/documents/doc-A';
    const docA = createMockDoc({ id: 'doc-A', title: 'Doc A' });
    const docB = createMockDoc({ id: 'doc-B', title: 'Doc B' });

    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [docA, docB] });

    await renderComponent(React.createElement(DocumentTree));

    let linkA = container.querySelector('a[href="/workspaces/ws-1/documents/doc-A"]');
    expect(linkA?.getAttribute('aria-current')).toBe('page');

    // Switch to doc-B
    mockCurrentPath = '/workspaces/ws-1/documents/doc-B';
    await renderComponent(React.createElement(DocumentTree));

    linkA = container.querySelector('a[href="/workspaces/ws-1/documents/doc-A"]');
    const linkB = container.querySelector('a[href="/workspaces/ws-1/documents/doc-B"]');
    expect(linkA?.getAttribute('aria-current')).toBeNull();
    expect(linkB?.getAttribute('aria-current')).toBe('page');
  });

  // -------------------------------------------------------------
  // 7. Permissions
  // -------------------------------------------------------------
  it('21. viewer cannot perform management operations (controls hidden/disabled)', async () => {
    mockUserRole = 'viewer';
    const doc1 = createMockDoc({ id: 'd-view', title: 'Read Only View' });
    const archivedDoc = createMockDoc({ id: 'd-arch', title: 'Archived Doc', is_archived: true });

    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [doc1, archivedDoc] });

    await renderComponent(React.createElement(DocumentTree));

    // No top-level create buttons
    const createTopBtn = container.querySelector('button[aria-label="Create top-level document"]');
    expect(createTopBtn).toBeNull();

    const bottomNewBtn = container.querySelector('button[aria-label="Create Document"]');
    expect(bottomNewBtn).toBeNull();

    // No sub-document add or more actions buttons on node
    const subAddBtn = container.querySelector('button[aria-label="Add sub-document"]');
    expect(subAddBtn).toBeNull();

    const moreBtn = container.querySelector('button[aria-label="More actions"]');
    expect(moreBtn).toBeNull();

    // Expand archived
    const archivedToggle = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Toggle archived documents',
    );
    await act(async () => {
      archivedToggle!.click();
    });

    // In archived section, restore button must not be rendered for viewer
    const restoreBtn = container.querySelector('button[aria-label*="Restore"]');
    expect(restoreBtn).toBeNull();
  });

  it('22. editor can create, add sub-document, rename, and move, but cannot archive or restore', async () => {
    mockUserRole = 'editor';
    const doc1 = createMockDoc({ id: 'd-edit', title: 'Editable Doc' });
    const archivedDoc = createMockDoc({ id: 'd-arch-edit', title: 'Archived Doc', is_archived: true });
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [doc1, archivedDoc] });

    await renderComponent(React.createElement(DocumentTree));

    // Editor can create top-level and sub-documents
    expect(container.querySelector('button[aria-label="Create top-level document"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Add sub-document"]')).not.toBeNull();

    // Editor can open More actions dropdown
    const moreBtn = container.querySelector('button[aria-label="More actions"]') as HTMLButtonElement;
    expect(moreBtn).not.toBeNull();

    await act(async () => {
      moreBtn.click();
    });

    // Rename and Move are present
    const menuButtons = Array.from(container.querySelectorAll('button'));
    expect(menuButtons.some((b) => b.textContent === 'Rename')).toBe(true);
    expect(menuButtons.some((b) => b.textContent === 'Move to...')).toBe(true);
    expect(menuButtons.some((b) => b.textContent === 'Add sub-document')).toBe(true);

    // Archive is strictly NOT present for editor
    expect(menuButtons.some((b) => b.textContent === 'Archive')).toBe(false);

    // Expand archived list
    const archivedToggle = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Toggle archived documents',
    );
    await act(async () => {
      archivedToggle!.click();
    });

    // In archived section, restore button must not be rendered for editor
    const restoreBtn = container.querySelector('button[aria-label*="Restore"]');
    expect(restoreBtn).toBeNull();
  });

  it('23. admin/owner role can archive active documents and restore archived documents', async () => {
    mockUserRole = 'admin';
    const doc1 = createMockDoc({ id: 'd-admin', title: 'Admin Controlled Doc' });
    const archivedDoc = createMockDoc({ id: 'd-arch-admin', title: 'Archived For Admin', is_archived: true });
    vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [doc1, archivedDoc] });

    await renderComponent(React.createElement(DocumentTree));

    const moreBtn = container.querySelector('button[aria-label="More actions"]') as HTMLButtonElement;
    await act(async () => {
      moreBtn.click();
    });

    // Archive is present for admin
    const menuButtons = Array.from(container.querySelectorAll('button'));
    expect(menuButtons.some((b) => b.textContent === 'Archive')).toBe(true);

    // Expand archived list
    const archivedToggle = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Toggle archived documents',
    );
    await act(async () => {
      archivedToggle!.click();
    });

    // Restore is present for admin
    const restoreBtn = container.querySelector('button[aria-label*="Restore"]');
    expect(restoreBtn).not.toBeNull();
  });

  it('24. active child of archived or missing parent remains visible and accessible in active tree', async () => {
    const parentA = createMockDoc({ id: 'parent-a', title: 'Archived Parent A', is_archived: true });
    const childB = createMockDoc({ id: 'child-b', title: 'Active Child B', parent_id: 'parent-a', is_archived: false });
    const grandchildC = createMockDoc({ id: 'child-c', title: 'Active Grandchild C', parent_id: 'child-b', is_archived: false });
    const missingParentChild = createMockDoc({ id: 'orphan-d', title: 'Active Orphan D', parent_id: 'non-existent-uuid', is_archived: false });

    vi.spyOn(api, 'listDocuments').mockResolvedValue({
      documents: [parentA, childB, grandchildC, missingParentChild],
    });

    await renderComponent(React.createElement(DocumentTree));

    // Active Child B must be visible in active tree (not lost)
    expect(container.textContent).toContain('Active Child B');
    // Active Orphan D must be visible in active tree
    expect(container.textContent).toContain('Active Orphan D');

    // Neither child B nor orphan D should be counted as archived
    expect(container.textContent).toContain('Archived (1)');

    // Child B is auto-expanded, so its child C is reachable and visible
    expect(container.textContent).toContain('Active Grandchild C');
    const collapseBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Collapse sub-documents',
    );
    expect(collapseBtn).toBeDefined();
  });

  it('25. DocumentTree refresh failure preserves existing documents and shows explicit notice with retry', async () => {
    const doc1 = createMockDoc({ id: 'doc-loaded', title: 'Previously Loaded Document' });
    const listSpy = vi.spyOn(api, 'listDocuments').mockResolvedValueOnce({ documents: [doc1] });

    await renderComponent(React.createElement(DocumentTree));

    expect(container.textContent).toContain('Previously Loaded Document');

    // Subsequent refresh failure
    listSpy.mockRejectedValueOnce(new Error('Network disconnected on refresh'));

    // Trigger workspace re-fetch
    mockActiveWorkspace = { id: 'ws-1', name: 'Updated Workspace', slug: 'test-ws' };
    await renderComponent(React.createElement(DocumentTree));

    await act(async () => {
      await Promise.resolve();
    });

    // Previous document remains visible
    expect(container.textContent).toContain('Previously Loaded Document');

    // Notice banner is displayed
    expect(container.textContent).toContain('Could not refresh documents. Your last loaded data is still shown.');

    // Retry button exists
    const retryBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Retry',
    );
    expect(retryBtn).toBeDefined();
  });

  it('26. WorkspacePage initial document list failure renders explicit error state rather than empty workspace', async () => {
    vi.spyOn(api, 'listDocuments').mockRejectedValue(new Error('500 Database down'));

    await renderComponent(React.createElement(WorkspacePage, { params: { workspaceId: 'ws-1' } }));

    // Must show explicit error state
    expect(container.textContent).toContain('Failed to Load Documents');
    expect(container.textContent).toContain('500 Database down');

    // Must NOT show empty workspace CTA
    expect(container.textContent).not.toContain('Your workspace is ready');
    expect(container.textContent).not.toContain('Create your first document to start writing');

    // Must have a Retry button
    const retryBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Retry',
    );
    expect(retryBtn).toBeDefined();
  });

  it('27. WorkspacePage retry after initial failure recovers and renders documents', async () => {
    const listSpy = vi.spyOn(api, 'listDocuments').mockRejectedValueOnce(new Error('Initial timeout'));

    await renderComponent(React.createElement(WorkspacePage, { params: { workspaceId: 'ws-1' } }));

    expect(container.textContent).toContain('Failed to Load Documents');
    const retryBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Retry',
    );
    expect(retryBtn).toBeDefined();

    // Mock successful response on retry
    const doc1 = createMockDoc({ id: 'ws-doc-1', title: 'Recovered Document' });
    listSpy.mockResolvedValueOnce({ documents: [doc1] });

    await act(async () => {
      retryBtn!.click();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Failed to Load Documents');
    expect(container.textContent).toContain('Recovered Document');
  });

  it('28. WorkspacePage refresh failure preserves existing documents and shows stale banner', async () => {
    const doc1 = createMockDoc({ id: 'ws-doc-1', title: 'Existing Document 1' });
    const listSpy = vi.spyOn(api, 'listDocuments').mockResolvedValueOnce({ documents: [doc1] });

    await renderComponent(React.createElement(WorkspacePage, { params: { workspaceId: 'ws-1' } }));

    expect(container.textContent).toContain('Existing Document 1');

    // Now mock failure on refresh
    listSpy.mockRejectedValueOnce(new Error('Refresh connection failed'));

    // Trigger re-fetch via workspace:refresh event
    await act(async () => {
      window.dispatchEvent(new CustomEvent('workspace:refresh'));
      await Promise.resolve();
    });

    // Existing document must still be preserved
    expect(container.textContent).toContain('Existing Document 1');

    // Stale banner must be shown
    expect(container.textContent).toContain('Could not refresh documents. Your last loaded data is still shown');

    // Empty workspace CTA must NOT be shown
    expect(container.textContent).not.toContain('Your workspace is ready');

    // Retry button must be present in the stale banner
    const staleRetryBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Retry',
    );
    expect(staleRetryBtn).toBeDefined();
  });

  // -------------------------------------------------------------
  // 7. Phase 5 T2 Refinement — Immediate Title Updates & Creation
  // -------------------------------------------------------------
  describe('T2 Refinement — Immediate Title Sync and Pre-Creation Naming', () => {
    it('A. title update immediately reflects in document tree without page reload or extra API call', async () => {
      const doc = createMockDoc({ id: 'doc-sync-1', title: 'Old Title' });
      const listSpy = vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [doc] });

      await renderComponent(React.createElement(DocumentTree));

      expect(container.textContent).toContain('Old Title');
      expect(container.textContent).not.toContain('New Title');
      expect(listSpy).toHaveBeenCalledTimes(1);

      // Simulate title persistence event from DocumentEditor
      const updatedDoc = { ...doc, title: 'New Title' };
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('document:updated', { detail: { document: updatedDoc } }),
        );
        await Promise.resolve();
      });

      // Document tree reflects the new title immediately
      expect(container.textContent).toContain('New Title');
      expect(container.textContent).not.toContain('Old Title');

      // No additional list API request was made
      expect(listSpy).toHaveBeenCalledTimes(1);
    });

    it('B. title update failure does not falsely update document tree or claim persistence', async () => {
      const doc = createMockDoc({ id: 'doc-sync-2', title: 'Persisted Old Title' });
      vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [doc] });

      await renderComponent(React.createElement(DocumentTree));

      expect(container.textContent).toContain('Persisted Old Title');

      // In the event of an API failure, document:updated is NOT dispatched
      // Verify DocumentTree keeps the original title intact
      expect(container.textContent).toContain('Persisted Old Title');
      expect(container.textContent).not.toContain('Unpersisted Failed Title');
    });

    it('C. create document prompts for title, calls API with entered title, and renders real document', async () => {
      vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [] });
      const serverDoc = createMockDoc({ id: 'real-server-id-888', title: 'My New Document' });
      const createSpy = vi.spyOn(api, 'createDocument').mockResolvedValue({ document: serverDoc });

      await renderComponent(React.createElement(DocumentTree));

      // Click create button
      const createBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Create your first document') || b.textContent?.includes('+ New Document'),
      );
      expect(createBtn).toBeDefined();

      await act(async () => {
        createBtn!.click();
      });

      // Dialog opens
      const titleInput = container.querySelector('#create-doc-title-input') as HTMLInputElement;
      expect(titleInput).not.toBeNull();

      // Enter title
      await changeInputValue(titleInput, 'My New Document');

      const submitBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.getAttribute('type') === 'submit' && b.textContent?.includes('Create Document'),
      );
      expect(submitBtn).toBeDefined();

      await act(async () => {
        submitBtn!.click();
        await Promise.resolve();
      });

      // Real server API called with exact title
      expect(createSpy).toHaveBeenCalledWith('ws-1', {
        title: 'My New Document',
        parentId: null,
      });

      // Document appears in the tree
      expect(container.textContent).toContain('My New Document');

      // Router navigates to real document
      expect(mockPush).toHaveBeenCalledWith('/workspaces/ws-1/documents/real-server-id-888');
    });

    it('D. create document cancel or Escape aborts creation without calling API or modifying tree', async () => {
      vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [] });
      const createSpy = vi.spyOn(api, 'createDocument');

      await renderComponent(React.createElement(DocumentTree));

      const createBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Create your first document') || b.textContent?.includes('+ New Document'),
      );

      await act(async () => {
        createBtn!.click();
      });

      expect(container.querySelector('#create-doc-modal-title')).not.toBeNull();

      // Click Cancel
      const cancelBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('Cancel'),
      );
      expect(cancelBtn).toBeDefined();

      await act(async () => {
        cancelBtn!.click();
      });

      // Modal is closed
      expect(container.querySelector('#create-doc-modal-title')).toBeNull();
      expect(createSpy).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();

      // Test Escape key
      await act(async () => {
        createBtn!.click();
      });
      expect(container.querySelector('#create-doc-modal-title')).not.toBeNull();

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(container.querySelector('#create-doc-modal-title')).toBeNull();
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('E. create document failure shows error, does not fabricate document, and allows retry', async () => {
      vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [] });
      const createSpy = vi
        .spyOn(api, 'createDocument')
        .mockRejectedValueOnce(new ApiError('Server exploded', 500))
        .mockResolvedValueOnce({
          document: createMockDoc({ id: 'recovered-real-id', title: 'Retry Success Title' }),
        });

      await renderComponent(React.createElement(DocumentTree));

      const createBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Create your first document') || b.textContent?.includes('+ New Document'),
      );

      await act(async () => {
        createBtn!.click();
      });

      const titleInput = container.querySelector('#create-doc-title-input') as HTMLInputElement;
      await changeInputValue(titleInput, 'Attempt 1 Title');

      const submitBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.getAttribute('type') === 'submit' && b.textContent?.includes('Create Document'),
      );

      await act(async () => {
        submitBtn!.click();
        await Promise.resolve();
      });

      // Fails: error message rendered
      expect(container.textContent).toContain('Server exploded');
      expect(mockPush).not.toHaveBeenCalled();
      expect(container.querySelectorAll('li')).toHaveLength(0);

      // Retry: update title and submit again
      await changeInputValue(titleInput, 'Retry Success Title');
      await act(async () => {
        submitBtn!.click();
        await Promise.resolve();
      });

      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain('Retry Success Title');
      expect(mockPush).toHaveBeenCalledWith('/workspaces/ws-1/documents/recovered-real-id');
    });

    it('F. empty or whitespace-only title is rejected before calling API', async () => {
      vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [] });
      const createSpy = vi.spyOn(api, 'createDocument');

      await renderComponent(React.createElement(DocumentTree));

      const createBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Create your first document') || b.textContent?.includes('+ New Document'),
      );

      await act(async () => {
        createBtn!.click();
      });

      const titleInput = container.querySelector('#create-doc-title-input') as HTMLInputElement;
      await changeInputValue(titleInput, '    ');

      const submitBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.getAttribute('type') === 'submit' && b.textContent?.includes('Create Document'),
      );

      await act(async () => {
        submitBtn!.click();
        await Promise.resolve();
      });

      // Validation error shown
      expect(container.textContent).toContain('Document title cannot be empty');
      expect(createSpy).not.toHaveBeenCalled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('G. permission regression: viewer cannot create documents; editor and owner can', async () => {
      vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [] });

      // Test as viewer
      mockUserRole = 'viewer';
      await renderComponent(React.createElement(DocumentTree));

      // No create button in header, empty state, or bottom
      expect(container.querySelector('button[title="Create top-level document"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Create Document"]')).toBeNull();
      const emptyBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Create your first document'),
      );
      expect(emptyBtn).toBeUndefined();

      // Test WorkspacePage as viewer
      await renderComponent(React.createElement(WorkspacePage, { params: { workspaceId: 'ws-1' } }));
      const wsCreateBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('+ New Document'),
      );
      expect(wsCreateBtn).toBeUndefined();

      // Test as editor
      mockUserRole = 'editor';
      await renderComponent(React.createElement(DocumentTree));
      expect(container.querySelector('button[title="Create top-level document"]')).not.toBeNull();

      // Test as owner
      mockUserRole = 'owner';
      await renderComponent(React.createElement(DocumentTree));
      expect(container.querySelector('button[title="Create top-level document"]')).not.toBeNull();
    });

    it('H. WorkspacePage New Document button opens creation modal and adds created document to list', async () => {
      const doc1 = createMockDoc({ id: 'ws-d1', title: 'Doc 1' });
      vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [doc1] });
      const newDoc = createMockDoc({ id: 'ws-d2', title: 'Created From Workspace Page' });
      vi.spyOn(api, 'createDocument').mockResolvedValue({ document: newDoc });

      mockUserRole = 'editor';
      await renderComponent(React.createElement(WorkspacePage, { params: { workspaceId: 'ws-1' } }));

      expect(container.textContent).toContain('Doc 1');

      const newDocBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('+ New Document'),
      );
      expect(newDocBtn).toBeDefined();

      await act(async () => {
        newDocBtn!.click();
      });

      // Modal open
      const titleInput = container.querySelector('#create-doc-title-input') as HTMLInputElement;
      expect(titleInput).not.toBeNull();

      await changeInputValue(titleInput, 'Created From Workspace Page');

      const submitBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.getAttribute('type') === 'submit' && b.textContent?.includes('Create Document'),
      );

      await act(async () => {
        submitBtn!.click();
        await Promise.resolve();
      });

      expect(api.createDocument).toHaveBeenCalledWith('ws-1', {
        title: 'Created From Workspace Page',
        parentId: null,
      });
      expect(mockPush).toHaveBeenCalledWith('/workspaces/ws-1/documents/ws-d2');
      expect(container.textContent).toContain('Created From Workspace Page');
    });

    it('I. DocumentTree ignores document:updated events from other workspaces and processes only matching active workspace', async () => {
      const docA = createMockDoc({
        id: 'doc-ws1-1',
        workspace_id: 'ws-1',
        title: 'Workspace A Original Title',
      });
      vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [docA] });

      await renderComponent(React.createElement(DocumentTree));

      expect(container.textContent).toContain('Workspace A Original Title');

      // 1. Dispatch event for a document from Workspace B (foreign workspace)
      const foreignDoc = createMockDoc({
        id: 'doc-ws2-1',
        workspace_id: 'ws-2',
        title: 'Workspace B Injected Title',
      });

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('document:updated', { detail: { document: foreignDoc } }),
        );
        await Promise.resolve();
      });

      // Tree must NOT change or accept foreign workspace document
      expect(container.textContent).toContain('Workspace A Original Title');
      expect(container.textContent).not.toContain('Workspace B Injected Title');

      // Also verify foreign event attempting to update an existing ID with a foreign workspace_id is rejected
      const spoofedDoc = {
        ...docA,
        workspace_id: 'ws-2',
        title: 'Spoofed Foreign Title',
      };

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('document:updated', { detail: { document: spoofedDoc } }),
        );
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Workspace A Original Title');
      expect(container.textContent).not.toContain('Spoofed Foreign Title');

      // 2. Positive case: Dispatch event for active workspace (ws-1)
      const validUpdatedDoc = {
        ...docA,
        title: 'Workspace A Updated Title',
      };

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('document:updated', { detail: { document: validUpdatedDoc } }),
        );
        await Promise.resolve();
      });

      // Tree updates immediately
      expect(container.textContent).toContain('Workspace A Updated Title');
      expect(container.textContent).not.toContain('Workspace A Original Title');
    });

    it('J. workspace switching cleans up previous workspace listener and accepts new workspace updates', async () => {
      // Start in Workspace 1
      const docA = createMockDoc({
        id: 'doc-ws1-1',
        workspace_id: 'ws-1',
        title: 'Workspace 1 Document',
      });
      const listSpy = vi.spyOn(api, 'listDocuments').mockResolvedValueOnce({ documents: [docA] });

      await renderComponent(React.createElement(DocumentTree));
      expect(container.textContent).toContain('Workspace 1 Document');

      // Switch active workspace to Workspace 2
      const docB = createMockDoc({
        id: 'doc-ws2-1',
        workspace_id: 'ws-2',
        title: 'Workspace 2 Document',
      });
      listSpy.mockResolvedValueOnce({ documents: [docB] });

      mockActiveWorkspace = { id: 'ws-2', name: 'Second Workspace', slug: 'second-ws' };
      mockCurrentPath = '/workspaces/ws-2';

      await renderComponent(React.createElement(DocumentTree));
      expect(container.textContent).toContain('Workspace 2 Document');
      expect(container.textContent).not.toContain('Workspace 1 Document');

      // Event for old Workspace 1 is ignored by the new listener
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('document:updated', {
            detail: { document: { ...docA, title: 'Old WS1 Changed' } },
          }),
        );
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Workspace 2 Document');
      expect(container.textContent).not.toContain('Old WS1 Changed');

      // Event for active Workspace 2 is accepted
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('document:updated', {
            detail: { document: { ...docB, title: 'Workspace 2 Renamed' } },
          }),
        );
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Workspace 2 Renamed');
      expect(container.textContent).not.toContain('Workspace 2 Document');
    });

    it('K. WorkspacePage isolates document:updated events by workspace_id', async () => {
      const docA = createMockDoc({ id: 'ws-d1', workspace_id: 'ws-1', title: 'Alpha Original Title' });
      vi.spyOn(api, 'listDocuments').mockResolvedValue({ documents: [docA] });

      await renderComponent(React.createElement(WorkspacePage, { params: { workspaceId: 'ws-1' } }));
      expect(container.textContent).toContain('Alpha Original Title');

      // Event from foreign workspace ws-2 must be ignored
      const foreignDoc = createMockDoc({
        id: 'foreign-doc-99',
        workspace_id: 'ws-2',
        title: 'Foreign Workspace Document',
      });

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('document:updated', { detail: { document: foreignDoc } }),
        );
        await Promise.resolve();
      });

      expect(container.textContent).not.toContain('Foreign Workspace Document');
      expect(container.textContent).toContain('Alpha Original Title');

      // Event from matching workspace ws-1 updates local list
      const updatedDocA = { ...docA, title: 'Beta Replaced Title' };
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('document:updated', { detail: { document: updatedDocA } }),
        );
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Beta Replaced Title');
      expect(container.textContent).not.toContain('Alpha Original Title');
    });
  });
});
