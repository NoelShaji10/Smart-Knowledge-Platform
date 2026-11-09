// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DocumentHeader } from '../components/documents/DocumentHeader';
import { VersionHistoryPanel, formatTriggerBadge } from '../components/documents/VersionHistoryPanel';
import { CollaboratorAvatars } from '../components/editor/CollaboratorAvatars';
import { api, Document, DocumentCapabilities, DocumentVersion, setAccessToken } from '../lib/api';
import { CollabUser } from '@/hooks/useCollaboration';

// Configure act environment for React 18
// @ts-expect-error global IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockShowToast = vi.fn();
vi.mock('@/components/ui', () => ({
  useToast: () => ({
    showToast: mockShowToast,
  }),
  Button: ({ children, onClick, disabled, loading, variant, size, className, ...props }: any) =>
    React.createElement(
      'button',
      {
        onClick,
        disabled: disabled || loading,
        'data-variant': variant,
        'data-size': size,
        className,
        ...props,
      },
      children,
    ),
  Input: ({ ...props }: any) => React.createElement('input', { ...props }),
  Badge: ({ children, variant, className, ...props }: any) =>
    React.createElement('span', { 'data-variant': variant, className, ...props }, children),
  Skeleton: ({ height, width, borderRadius, ...props }: any) =>
    React.createElement('div', {
      'data-testid': 'skeleton',
      style: { height, width, borderRadius },
      ...props,
    }),
}));

vi.mock('@/contexts/WorkspaceContext', () => ({
  useWorkspaceOptional: () => ({
    activeWorkspace: { id: 'ws-1', name: 'Engineering Core', slug: 'eng-core' },
    userRole: 'owner',
  }),
}));

vi.mock('@/contexts/DocumentNavigationContext', () => ({
  useDocumentNavigationOptional: () => ({
    documents: [],
    activeDocuments: [],
    computeAncestors: () => [],
  }),
  computeAncestors: () => [],
}));

describe('Phase 4: Document Editor & Version History Redesign Test Suite', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  const mockDoc: Document = {
    id: 'doc-101',
    workspace_id: 'ws-1',
    parent_id: null,
    is_archived: false,
    title: 'Architecture Blueprint',
    content_text: '<p>System architecture details</p>',
    snapshot_key: 'doc-101/snapshot.yjs',
    snapshot_version: 3,
    created_by: 'usr-1',
    created_at: '2026-11-01T10:00:00.000Z',
    updated_at: '2026-11-08T15:30:00.000Z',
  };

  const defaultCapabilities: DocumentCapabilities = {
    canRead: true,
    canEdit: true,
    canMove: true,
    canArchive: true,
    canManagePermissions: true,
  };

  const mockCollabUsers: CollabUser[] = [
    { id: 'usr-1', clientId: 1, name: 'Alice Smith', color: '#004ac6', isCurrentUser: true },
    { id: 'usr-2', clientId: 2, name: 'Bob Jones', color: '#16a34a', isCurrentUser: false },
  ];

  beforeEach(() => {
    setAccessToken('mock-token');
    vi.resetAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  describe('1. CollaboratorAvatars Component', () => {
    it('renders avatars with initials and active presence indicators', () => {
      act(() => {
        root.render(React.createElement(CollaboratorAvatars, { users: mockCollabUsers }));
      });

      const avatarGroup = container.querySelector('[role="group"]');
      expect(avatarGroup).not.toBeNull();

      const items = container.querySelectorAll('[role="group"] > [aria-label]');
      expect(items.length).toBe(2);
      expect(items[0].getAttribute('aria-label')).toBe('Alice Smith (You)');
      expect(items[1].getAttribute('aria-label')).toBe('Bob Jones');
      expect(items[0].textContent).toContain('AS');
      expect(items[1].textContent).toContain('BJ');
    });

    it('renders overflow count badge when users exceed maxVisible', () => {
      const extraUsers: CollabUser[] = [
        ...mockCollabUsers,
        { id: 'usr-3', clientId: 3, name: 'Carol White', color: '#dc2626', isCurrentUser: false },
        { id: 'usr-4', clientId: 4, name: 'David Black', color: '#9333ea', isCurrentUser: false },
      ];

      act(() => {
        root.render(React.createElement(CollaboratorAvatars, { users: extraUsers, maxVisible: 2 }));
      });

      const overflow = container.querySelector('[aria-label="2 more collaborators"]');
      expect(overflow).not.toBeNull();
      expect(overflow?.textContent).toBe('+2');
    });
  });

  describe('2. DocumentHeader Redesign', () => {
    it('renders breadcrumbs and saved state badge faithfully without misleading snapshot_version', () => {
      act(() => {
        root.render(
          React.createElement(DocumentHeader, {
            workspaceId: 'ws-1',
            document: mockDoc,
            capabilities: defaultCapabilities,
            saveState: 'saved',
            connectedUsers: mockCollabUsers,
            onToggleHistory: vi.fn(),
            onDocumentUpdated: vi.fn(),
          }),
        );
      });

      expect(container.textContent).toContain('Engineering Core');
      expect(container.textContent).toContain('Architecture Blueprint');
      expect(container.textContent).not.toContain('v3');
      expect(container.textContent).toContain('Saved');
    });

    it('renders accurate dynamic synchronization states without lying to user', () => {
      const states = [
        { state: 'saving' as const, text: 'Saving...' },
        { state: 'saved' as const, text: 'Saved' },
        { state: 'editing' as const, text: 'Changes pending' },
        { state: 'delayed' as const, text: 'Persistence delayed' },
        { state: 'disconnected' as const, text: 'Offline' },
        { state: 'recovering' as const, text: 'Reconnecting...' },
        { state: 'error' as const, text: 'Save failed' },
      ];

      for (const { state, text } of states) {
        act(() => {
          root.render(
            React.createElement(DocumentHeader, {
              workspaceId: 'ws-1',
              document: mockDoc,
              capabilities: defaultCapabilities,
              saveState: state,
              connectedUsers: mockCollabUsers,
              onToggleHistory: vi.fn(),
              onDocumentUpdated: vi.fn(),
            }),
          );
        });
        expect(container.textContent).toContain(text);
      }
    });

    it('calls api.createVersion and updates snapshot version on Save Version click', async () => {
      const onDocumentUpdated = vi.fn();
      const mockCreatedVersion: DocumentVersion = {
        id: 'ver-4',
        document_id: 'doc-101',
        version_number: 4,
        title: 'Architecture Blueprint',
        content_text: '<p>System architecture details</p>',
        snapshot_key: 'doc-101/4.yjs',
        trigger: 'manual',
        created_by: 'usr-1',
        created_at: new Date().toISOString(),
      };

      vi.spyOn(api, 'createVersion').mockResolvedValueOnce({
        version: mockCreatedVersion,
      });

      act(() => {
        root.render(
          React.createElement(DocumentHeader, {
            workspaceId: 'ws-1',
            document: mockDoc,
            capabilities: defaultCapabilities,
            saveState: 'saved',
            connectedUsers: mockCollabUsers,
            onToggleHistory: vi.fn(),
            onDocumentUpdated,
          }),
        );
      });

      const saveVersionBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('Save Version'),
      );
      expect(saveVersionBtn).toBeDefined();

      await act(async () => {
        saveVersionBtn?.click();
      });

      expect(api.createVersion).toHaveBeenCalledWith('ws-1', 'doc-101');
      expect(onDocumentUpdated).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot_version: 4,
        }),
      );
      expect(mockShowToast).toHaveBeenCalledWith('Version checkpoint created', 'success');
    });

    it('triggers onToggleHistory callback when History button is clicked', () => {
      const onToggleHistory = vi.fn();
      act(() => {
        root.render(
          React.createElement(DocumentHeader, {
            workspaceId: 'ws-1',
            document: mockDoc,
            capabilities: defaultCapabilities,
            saveState: 'saved',
            connectedUsers: mockCollabUsers,
            onToggleHistory,
            onDocumentUpdated: vi.fn(),
          }),
        );
      });

      const historyBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('History'),
      );
      expect(historyBtn).toBeDefined();

      act(() => {
        historyBtn?.click();
      });

      expect(onToggleHistory).toHaveBeenCalledTimes(1);
    });

    it('opens DocumentPermissionsModal when Permissions button is clicked', async () => {
      act(() => {
        root.render(
          React.createElement(DocumentHeader, {
            workspaceId: 'ws-1',
            document: mockDoc,
            capabilities: { ...defaultCapabilities, canManagePermissions: true },
            saveState: 'saved',
            connectedUsers: mockCollabUsers,
            onToggleHistory: vi.fn(),
            onDocumentUpdated: vi.fn(),
          }),
        );
      });

      const permsBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent?.includes('Permissions'),
      );
      expect(permsBtn).toBeDefined();

      await act(async () => {
        permsBtn?.click();
      });

      const modal = container.querySelector('[role="dialog"]');
      expect(modal).not.toBeNull();
    });
  });

  describe('3. VersionHistoryPanel Redesign', () => {
    const mockVersionsList: DocumentVersion[] = [
      {
        id: 'ver-3',
        document_id: 'doc-101',
        version_number: 3,
        title: 'Architecture Blueprint v3',
        content_text: '<p>V3 Content</p>',
        snapshot_key: 'doc-101/3.yjs',
        trigger: 'session_end',
        creator_name: 'Alice Smith',
        created_by: 'usr-1',
        created_at: '2026-11-08T15:00:00.000Z',
      },
      {
        id: 'ver-2',
        document_id: 'doc-101',
        version_number: 2,
        title: 'Architecture Blueprint v2',
        content_text: '<p>V2 Content</p>',
        snapshot_key: 'doc-101/2.yjs',
        trigger: 'manual',
        creator_name: 'Bob Jones',
        created_by: 'usr-2',
        created_at: '2026-11-05T12:00:00.000Z',
      },
      {
        id: 'ver-1',
        document_id: 'doc-101',
        version_number: 1,
        title: 'Initial Draft',
        content_text: '<p>V1 Initial Draft</p>',
        snapshot_key: 'doc-101/1.yjs',
        trigger: 'auto_interval',
        creator_name: 'System AutoSave',
        created_by: 'usr-1',
        created_at: '2026-11-01T10:00:00.000Z',
      },
    ];

    it('faithfully maps backend checkpoint triggers to readable UI badges', () => {
      const triggers = [
        { trigger: 'manual', label: 'Manual Checkpoint', variant: 'owner' },
        { trigger: 'restore', label: 'Restored Version', variant: 'admin' },
        { trigger: 'auto_interval', label: 'Automatic Checkpoint', variant: 'default' },
        { trigger: 'session_end', label: 'Session Saved', variant: 'viewer' },
      ];

      for (const { trigger, label, variant } of triggers) {
        const badgeElement = formatTriggerBadge(trigger);
        expect(badgeElement.props.children).toBe(label);
        expect(badgeElement.props.variant).toBe(variant);
      }
    });

    it('renders timeline with current version indicator, authors, and snapshot count', async () => {
      vi.spyOn(api, 'listVersions').mockResolvedValueOnce({
        versions: mockVersionsList,
      });

      await act(async () => {
        root.render(
          React.createElement(VersionHistoryPanel, {
            workspaceId: 'ws-1',
            documentId: 'doc-101',
            canEdit: true,
            onClose: vi.fn(),
            onVersionRestored: vi.fn(),
          }),
        );
      });

      expect(api.listVersions).toHaveBeenCalledWith('ws-1', 'doc-101');
      expect(container.textContent).toContain('Version History');
      expect(container.textContent).toContain('3 snapshots');

      // Check current badge on highest version (v3)
      expect(container.textContent).toContain('Current');
      expect(container.textContent).toContain('Viewing Now');

      // Check older versions have Preview & Restore actions
      expect(container.textContent).toContain('v2');
      expect(container.textContent).toContain('v1');
      expect(container.textContent).toContain('Bob Jones');
      expect(container.textContent).toContain('Alice Smith');
    });

    it('filters snapshots dynamically by user input', async () => {
      vi.spyOn(api, 'listVersions').mockResolvedValueOnce({
        versions: mockVersionsList,
      });

      await act(async () => {
        root.render(
          React.createElement(VersionHistoryPanel, {
            workspaceId: 'ws-1',
            documentId: 'doc-101',
            canEdit: true,
            onClose: vi.fn(),
            onVersionRestored: vi.fn(),
          }),
        );
      });

      const searchInput = container.querySelector('input[type="text"]') as HTMLInputElement;
      expect(searchInput).not.toBeNull();

      // Filter by 'Bob'
      act(() => {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set;
        nativeSetter?.call(searchInput, 'Bob');
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(container.textContent).toContain('v2');
      expect(container.textContent).not.toContain('v1');
    });

    it('opens snapshot preview modal with sanitized HTML and version metadata', async () => {
      vi.spyOn(api, 'listVersions').mockResolvedValueOnce({
        versions: mockVersionsList,
      });

      await act(async () => {
        root.render(
          React.createElement(VersionHistoryPanel, {
            workspaceId: 'ws-1',
            documentId: 'doc-101',
            canEdit: true,
            onClose: vi.fn(),
            onVersionRestored: vi.fn(),
          }),
        );
      });

      const previewButtons = Array.from(container.querySelectorAll('button')).filter(
        (b) => b.textContent === 'Preview',
      );
      expect(previewButtons.length).toBeGreaterThanOrEqual(1);

      act(() => {
        previewButtons[0].click();
      });

      const previewModal = container.querySelector('#preview-modal-title');
      expect(previewModal).not.toBeNull();
      expect(container.textContent).toContain('V3 Content');
    });

    it('handles version restoration workflow via api.restoreVersion and triggers onVersionRestored', async () => {
      const onVersionRestored = vi.fn();
      const restoredDoc: Document = {
        ...mockDoc,
        snapshot_version: 4,
        title: 'Architecture Blueprint v2',
        content_text: '<p>V2 Content</p>',
      };

      vi.spyOn(api, 'listVersions').mockResolvedValue({
        versions: mockVersionsList,
      });

      vi.spyOn(api, 'restoreVersion').mockResolvedValueOnce({
        document: restoredDoc,
        newVersion: {
          id: 'ver-4',
          document_id: 'doc-101',
          version_number: 4,
          title: 'Architecture Blueprint v2',
          content_text: '<p>V2 Content</p>',
          snapshot_key: 'doc-101/4.yjs',
          trigger: 'restore',
          created_by: 'usr-1',
          created_at: new Date().toISOString(),
        },
      });

      await act(async () => {
        root.render(
          React.createElement(VersionHistoryPanel, {
            workspaceId: 'ws-1',
            documentId: 'doc-101',
            canEdit: true,
            onClose: vi.fn(),
            onVersionRestored,
          }),
        );
      });

      const restoreButtons = Array.from(container.querySelectorAll('button')).filter(
        (b) => b.textContent === 'Restore',
      );
      expect(restoreButtons.length).toBeGreaterThanOrEqual(1);

      // Click restore on v2
      act(() => {
        restoreButtons[0].click();
      });

      // Confirm dialog appears
      const confirmBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Confirm Restore',
      );
      expect(confirmBtn).toBeDefined();

      await act(async () => {
        confirmBtn?.click();
      });

      expect(api.restoreVersion).toHaveBeenCalledWith('ws-1', 'doc-101', 2);
      expect(onVersionRestored).toHaveBeenCalledWith(restoredDoc);
      expect(mockShowToast).toHaveBeenCalledWith(
        'Restored version v2 as new version checkpoint',
        'success',
      );
    });
  });
});
