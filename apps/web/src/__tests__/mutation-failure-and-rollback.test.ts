// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError, Document } from '../lib/api';
import { DocumentTree } from '../components/documents/DocumentTree';
import { CreateDocumentModal } from '../components/documents/CreateDocumentModal';
import { WorkspaceContext } from '../contexts/WorkspaceContext';
import { DocumentNavigationContext } from '../contexts/DocumentNavigationContext';

// Configure act environment for React 18
// @ts-expect-error global IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const el = React.createElement as any;

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

vi.mock('next/navigation', () => ({
  usePathname: () => '/workspaces/ws-1',
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: {
      listDocuments: vi.fn(),
      updateDocument: vi.fn(),
      createDocument: vi.fn(),
      archiveDocument: vi.fn(),
      restoreDocument: vi.fn(),
    },
  };
});

describe('Task 4: Mutation Failure and Rollback', () => {
  let container: HTMLDivElement;
  let root: Root;

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

  beforeEach(() => {
    vi.clearAllMocks();
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

  const dummyDoc: Document = {
    id: 'doc-1',
    workspace_id: 'ws-1',
    parent_id: null,
    title: 'Original Title',
    content_text: 'Content',
    created_by: 'user-1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  it('rolls back document title in navigation state when server rejects rename mutation', async () => {
    let currentDocs = [dummyDoc];
    const updateDocumentMock = vi.fn((doc: Document) => {
      currentDocs = currentDocs.map((d) => (d.id === doc.id ? doc : d));
    });

    const mockNavContext: any = {
      workspaceId: 'ws-1',
      documents: currentDocs,
      activeDocuments: currentDocs,
      archivedDocuments: [],
      loading: false,
      error: null,
      refreshDocuments: vi.fn().mockResolvedValue(currentDocs),
      updateDocument: updateDocumentMock,
      addDocument: vi.fn(),
      removeDocument: vi.fn(),
      getAncestors: vi.fn().mockReturnValue([]),
    };

    const mockWsContext: any = {
      activeWorkspace: { id: 'ws-1', name: 'Test WS', slug: 'test' },
      userRole: 'editor',
    };

    // Simulate server rejecting rename with 403 Forbidden
    vi.mocked(api.updateDocument).mockRejectedValueOnce(
      new ApiError('Forbidden: Read-only document', 403),
    );

    await act(async () => {
      root.render(
        el(
          WorkspaceContext.Provider,
          { value: mockWsContext },
          el(
            DocumentNavigationContext.Provider,
            { value: mockNavContext },
            el(DocumentTree),
          ),
        ),
      );
    });

    // Verify initial render
    const titleEl = container.querySelector('[class*="docTitle"]');
    expect(titleEl?.textContent).toBe('Original Title');

    // 1. Open the dropdown menu on the document item
    const moreBtn = container.querySelector('button[aria-label="More actions"]') as HTMLButtonElement;
    expect(moreBtn).toBeTruthy();

    await act(async () => {
      moreBtn.click();
    });

    // 2. Click the 'Rename' menu item
    const renameBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Rename',
    ) as HTMLButtonElement;
    expect(renameBtn).toBeTruthy();

    await act(async () => {
      renameBtn.click();
    });

    // 3. Document item should now display the inline rename input
    const renameInput = container.querySelector('input[aria-label="Rename document title"]') as HTMLInputElement;
    expect(renameInput).toBeTruthy();
    expect(renameInput.value).toBe('Original Title');

    // 4. User types a new title
    await changeInputValue(renameInput, 'Failed New Title');

    // 5. Submit rename via Enter key
    await act(async () => {
      renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    // Verify api.updateDocument was called through DocumentTree's handleRenameCommit
    expect(api.updateDocument).toHaveBeenCalledWith('ws-1', 'doc-1', {
      title: 'Failed New Title',
    });

    // Verify handleRenameCommit caught the error and rolled back in navigation state
    expect(updateDocumentMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'doc-1', title: 'Original Title' }),
    );
    expect(mockShowToast).toHaveBeenCalledWith('Failed to rename document', 'error');
    expect(mockShowToast).not.toHaveBeenCalledWith('Document renamed', 'success');
  });

  it('CreateDocumentModal prevents duplicate submissions and does not toast success on failure', async () => {
    let resolveCreate: (val: any) => void;
    let rejectCreate: (val: any) => void;
    const createPromise = new Promise((resolve, reject) => {
      resolveCreate = resolve;
      rejectCreate = reject;
    });

    vi.mocked(api.createDocument).mockImplementationOnce(() => createPromise as any);

    const onCreated = vi.fn();
    const onClose = vi.fn();

    await act(async () => {
      root.render(
        el(CreateDocumentModal, {
          workspaceId: 'ws-1',
          isOpen: true,
          onClose,
          onCreated,
        }),
      );
    });

    const input = container.querySelector('input')!;
    const form = container.querySelector('form')!;

    // Type a title using nativeSetter
    await changeInputValue(input, 'New Document');

    // First submission
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // In-flight: submit button disabled, api.createDocument called once
    expect(api.createDocument).toHaveBeenCalledTimes(1);

    // Attempt second submission while in flight
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // Still only 1 call (duplicate prevented)
    expect(api.createDocument).toHaveBeenCalledTimes(1);

    // Reject the promise to simulate failure
    await act(async () => {
      rejectCreate(new ApiError('Creation failed', 500));
      await Promise.resolve();
    });

    // On failure: onCreated NOT called, onClose NOT called, no success toast
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalledWith('Document created', 'success');
  });
});
