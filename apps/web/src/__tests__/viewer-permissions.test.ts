// @vitest-environment jsdom
import React, { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, Root } from 'react-dom/client';
import { EditorToolbar } from '../components/editor/EditorToolbar';
import { DocumentTree } from '../components/documents/DocumentTree';
import WorkspacePage from '../app/(app)/workspaces/[workspaceId]/page';
import { WorkspaceContext } from '../contexts/WorkspaceContext';
import { DocumentNavigationContext } from '../contexts/DocumentNavigationContext';
import { api, Document, ApiError } from '../lib/api';

// Configure act environment for React 18
// @ts-expect-error global IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const el = React.createElement as any;

// Mock Toast context
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

// Mock Next.js router & pathname
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
  usePathname: () => '/workspaces/ws-1/documents/doc-1',
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
      listWorkspaceMembers: vi.fn(),
    },
  };
});

describe('Phase 5 — T5: Reliable Permission & Viewer Experience Tests', () => {
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

  describe('EditorToolbar Viewer & Read-Only Experience', () => {
    it('renders clean read-only banner and hides formatting mutation buttons when readOnly=true', async () => {
      const mockEditor = {
        on: vi.fn(),
        off: vi.fn(),
        isActive: vi.fn().mockReturnValue(false),
        can: vi.fn().mockReturnValue({ undo: () => true, redo: () => true }),
        chain: vi.fn(),
      } as any;

      await act(async () => {
        root.render(
          el(EditorToolbar, {
            editor: mockEditor,
            readOnly: true,
            isFocusMode: false,
            onToggleFocusMode: vi.fn(),
          }),
        );
      });

      // 1. Should render the viewer toolbar with Read-only mode text
      const toolbar = container.querySelector('[role="toolbar"][aria-label="Viewer toolbar"]');
      expect(toolbar).toBeTruthy();
      expect(container.textContent).toContain('Read-only mode');

      // 2. Inappropriate formatting mutation buttons must NOT be rendered
      expect(container.querySelector('select[aria-label="Text block style"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Bold"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Italic"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Bullet List"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Undo"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Insert or edit link"]')).toBeNull();

      // 3. Authorized reading controls like Focus Mode remain accessible
      const focusBtn = container.querySelector('button[aria-label="Enter focus mode"]');
      expect(focusBtn).toBeTruthy();
    });

    it('renders full rich text formatting controls when readOnly=false', async () => {
      const mockEditor = {
        on: vi.fn(),
        off: vi.fn(),
        isActive: vi.fn().mockReturnValue(false),
        can: vi.fn().mockReturnValue({ undo: () => true, redo: () => true }),
        chain: vi.fn(),
      } as any;

      await act(async () => {
        root.render(
          el(EditorToolbar, {
            editor: mockEditor,
            readOnly: false,
            isFocusMode: false,
            onToggleFocusMode: vi.fn(),
          }),
        );
      });

      // Standard rich-text toolbar is present
      const toolbar = container.querySelector('[role="toolbar"][aria-label="Rich text editor toolbar"]');
      expect(toolbar).toBeTruthy();
      expect(container.querySelector('button[aria-label="Bold"]')).toBeTruthy();
      expect(container.querySelector('button[aria-label="Italic"]')).toBeTruthy();
      expect(container.querySelector('select[aria-label="Text block style"]')).toBeTruthy();
    });

    it('triggers onToggleFocusMode callback from read-only toolbar', async () => {
      const toggleFocusMock = vi.fn();
      const mockEditor = {
        on: vi.fn(),
        off: vi.fn(),
        isActive: vi.fn().mockReturnValue(false),
        can: vi.fn().mockReturnValue({ undo: () => true, redo: () => true }),
        chain: vi.fn(),
      } as any;

      await act(async () => {
        root.render(
          el(EditorToolbar, {
            editor: mockEditor,
            readOnly: true,
            isFocusMode: false,
            onToggleFocusMode: toggleFocusMock,
          }),
        );
      });

      const focusBtn = container.querySelector('button[aria-label="Enter focus mode"]') as HTMLButtonElement;
      expect(focusBtn).toBeTruthy();

      await act(async () => {
        focusBtn.click();
      });

      expect(toggleFocusMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('DocumentTree Viewer & Permission Isolation', () => {
    it('completely hides mutation actions (add sub-document, rename, move, archive) for Viewer role', async () => {
      const mockDoc: Document = {
        id: 'doc-view',
        workspace_id: 'ws-1',
        parent_id: null,
        title: 'Viewer Doc',
        content_text: 'Content',
        is_archived: false,
        created_by: 'user-1',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const mockNavContext: any = {
        documents: [mockDoc],
        activeDocuments: [mockDoc],
        archivedDocuments: [],
        loading: false,
        error: null,
        refreshDocuments: vi.fn(),
        addDocument: vi.fn(),
        updateDocument: vi.fn(),
        removeDocument: vi.fn(),
        getAncestors: vi.fn().mockReturnValue([]),
      };

      const mockWsContext: any = {
        activeWorkspace: { id: 'ws-1', name: 'Viewer WS', slug: 'viewer-ws' },
        userRole: 'viewer', // Viewer user
      };

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

      // 1. Document title link is rendered for reading
      const titleLink = container.querySelector('[class*="docTitle"]');
      expect(titleLink).toBeTruthy();
      expect(titleLink?.textContent).toBe('Viewer Doc');

      // 2. Mutation controls must NOT be present
      expect(container.querySelector('button[aria-label="Create top-level document"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Add sub-document"]')).toBeNull();
      expect(container.querySelector('span[aria-label="More actions"]')).toBeNull();
      expect(container.querySelector('button[aria-label="Create Document"]')).toBeNull();
    });

    it('displays explicit access-denied message when rename fails with HTTP 403', async () => {
      const mockDoc: Document = {
        id: 'doc-editor',
        workspace_id: 'ws-1',
        parent_id: null,
        title: 'Original Title',
        content_text: 'Content',
        is_archived: false,
        created_by: 'user-1',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const updateDocumentMock = vi.fn();
      const mockNavContext: any = {
        documents: [mockDoc],
        activeDocuments: [mockDoc],
        archivedDocuments: [],
        loading: false,
        error: null,
        refreshDocuments: vi.fn(),
        updateDocument: updateDocumentMock,
        addDocument: vi.fn(),
        removeDocument: vi.fn(),
        getAncestors: vi.fn().mockReturnValue([]),
      };

      const mockWsContext: any = {
        activeWorkspace: { id: 'ws-1', name: 'Test WS', slug: 'test' },
        userRole: 'editor',
      };

      // Server rejects with 403
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

      // Open dropdown and click Rename
      const moreBtn = container.querySelector('button[aria-label="More actions"]') as HTMLButtonElement;
      expect(moreBtn).toBeTruthy();

      await act(async () => {
        moreBtn.click();
      });

      const renameBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent?.trim() === 'Rename',
      ) as HTMLButtonElement;
      expect(renameBtn).toBeTruthy();

      await act(async () => {
        renameBtn.click();
      });

      const renameInput = container.querySelector('input[aria-label="Rename document title"]') as HTMLInputElement;
      expect(renameInput).toBeTruthy();

      // Type new title
      await changeInputValue(renameInput, 'Denied Title');

      // Submit via Enter
      await act(async () => {
        renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await Promise.resolve();
      });

      // Verify specific 403 toast was displayed
      expect(mockShowToast).toHaveBeenCalledWith(
        'Access denied: You do not have permission to rename this document',
        'error',
      );
      // Verify rollback occurred
      expect(updateDocumentMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'doc-editor', title: 'Original Title' }),
      );
    });
  });

  describe('Workspace Dashboard Role Adaptation', () => {
    it('labels member button as "Members" and hides "+ New Document" for Viewer role', async () => {
      const mockDoc: Document = {
        id: 'doc-1',
        workspace_id: 'ws-1',
        parent_id: null,
        title: 'Doc 1',
        content_text: 'Text',
        is_archived: false,
        created_by: 'user-1',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const mockWsContext: any = {
        activeWorkspace: { id: 'ws-1', name: 'Viewer Workspace', slug: 'viewer-ws' },
        userRole: 'viewer',
        loading: false,
        error: null,
        loadWorkspace: vi.fn(),
      };

      const mockNavContext: any = {
        documents: [mockDoc],
        activeDocuments: [mockDoc],
        archivedDocuments: [],
        loading: false,
        error: null,
        refreshDocuments: vi.fn(),
      };

      await act(async () => {
        root.render(
          el(
            WorkspaceContext.Provider,
            { value: mockWsContext },
            el(
              DocumentNavigationContext.Provider,
              { value: mockNavContext },
              el(WorkspacePage, { params: { workspaceId: 'ws-1' } }),
            ),
          ),
        );
      });

      // Viewer button text should be "Members" with aria-label "Workspace Members"
      const memberBtn = container.querySelector('button[aria-label="Workspace Members"]');
      expect(memberBtn).toBeTruthy();
      expect(memberBtn?.textContent?.trim()).toBe('Members');

      // Viewer cannot create documents
      expect(container.querySelector('button[aria-label="Create New Document"]')).toBeNull();
    });

    it('labels member button as "Manage Members" and shows "+ New Document" for Admin role', async () => {
      const mockDoc: Document = {
        id: 'doc-1',
        workspace_id: 'ws-1',
        parent_id: null,
        title: 'Doc 1',
        content_text: 'Text',
        is_archived: false,
        created_by: 'user-1',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const mockWsContext: any = {
        activeWorkspace: { id: 'ws-1', name: 'Admin Workspace', slug: 'admin-ws' },
        userRole: 'admin',
        loading: false,
        error: null,
        loadWorkspace: vi.fn(),
      };

      const mockNavContext: any = {
        documents: [mockDoc],
        activeDocuments: [mockDoc],
        archivedDocuments: [],
        loading: false,
        error: null,
        refreshDocuments: vi.fn(),
      };

      await act(async () => {
        root.render(
          el(
            WorkspaceContext.Provider,
            { value: mockWsContext },
            el(
              DocumentNavigationContext.Provider,
              { value: mockNavContext },
              el(WorkspacePage, { params: { workspaceId: 'ws-1' } }),
            ),
          ),
        );
      });

      // Admin button text should be "Manage Members"
      const memberBtn = container.querySelector('button[aria-label="Manage Members"]');
      expect(memberBtn).toBeTruthy();
      expect(memberBtn?.textContent?.trim()).toBe('Manage Members');

      // Admin can create documents
      const newDocBtn = container.querySelector('button[aria-label="Create New Document"]');
      expect(newDocBtn).toBeTruthy();
      expect(newDocBtn?.textContent?.trim()).toBe('+ New Document');
    });
  });
});
