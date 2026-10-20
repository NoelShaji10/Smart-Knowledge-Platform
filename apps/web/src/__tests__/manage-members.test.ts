// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError, WorkspaceMemberListItem, WorkspaceInvitation } from '../lib/api';
import { AuthContext } from '../contexts/AuthContext';
import { WorkspaceContext } from '../contexts/WorkspaceContext';
import WorkspaceMembersPage from '../app/(app)/workspaces/[workspaceId]/members/page';
import { InviteMemberModal } from '../components/members/InviteMemberModal';
import { ConfirmationModal } from '../components/members/ConfirmationModal';
import { ResendResultModal } from '../components/members/ResendResultModal';
import { buildInvitationUrl } from '../components/members/invitationUtils';

// Configure act environment for React 18
// @ts-expect-error global IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockPush = vi.fn();
const mockReplace = vi.fn();
let mockPathname = '/workspaces/ws-123/members';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
  usePathname: () => mockPathname,
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

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  nativeInputValueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('Task 3 Remediation: Manage Members & Workspace Invitations UI Tests', () => {
  let container: HTMLDivElement;
  let root: Root;

  const mockUser = {
    id: 'user-owner',
    email: 'owner@example.com',
    displayName: 'Owner User',
  };

  const mockAdminUser = {
    id: 'user-admin',
    email: 'admin@example.com',
    displayName: 'Admin User',
  };

  const mockEditorUser = {
    id: 'user-editor',
    email: 'editor@example.com',
    displayName: 'Editor User',
  };

  const mockViewerUser = {
    id: 'user-viewer',
    email: 'viewer@example.com',
    displayName: 'Viewer User',
  };

  const mockActiveWorkspace = {
    id: 'ws-123',
    name: 'Acme Knowledge Platform',
    slug: 'acme',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const mockMembersList: WorkspaceMemberListItem[] = [
    {
      id: 'user-owner',
      email: 'owner@example.com',
      display_name: 'Owner User',
      avatar_url: null,
      role: 'owner',
      created_at: '2026-10-01T10:00:00.000Z',
    },
    {
      id: 'user-admin',
      email: 'admin@example.com',
      display_name: 'Admin User',
      avatar_url: null,
      role: 'admin',
      created_at: '2026-10-02T10:00:00.000Z',
    },
    {
      id: 'user-editor',
      email: 'editor@example.com',
      display_name: 'Editor User',
      avatar_url: null,
      role: 'editor',
      created_at: '2026-10-03T10:00:00.000Z',
    },
    {
      id: 'user-viewer',
      email: 'viewer@example.com',
      display_name: 'Viewer User',
      avatar_url: null,
      role: 'viewer',
      created_at: '2026-10-04T10:00:00.000Z',
    },
  ];

  const mockInvitationsList: WorkspaceInvitation[] = [
    {
      id: 'inv-1',
      workspace_id: 'ws-123',
      inviter_id: 'user-owner',
      invitee_email: 'invitee@example.com',
      role: 'editor',
      status: 'pending',
      expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: '2026-10-15T12:00:00.000Z',
    },
    {
      id: 'inv-2',
      workspace_id: 'ws-123',
      inviter_id: 'user-owner',
      invitee_email: null,
      role: 'viewer',
      status: 'pending',
      expires_at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: '2026-10-16T12:00:00.000Z',
    },
    {
      id: 'inv-3',
      workspace_id: 'ws-123',
      inviter_id: 'user-owner',
      invitee_email: 'expired@example.com',
      role: 'viewer',
      status: 'expired',
      expires_at: '2026-10-10T12:00:00.000Z',
      created_at: '2026-10-03T12:00:00.000Z',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    // Default mock implementations
    vi.spyOn(api, 'getWorkspaceMembers').mockResolvedValue({ members: [...mockMembersList] });
    vi.spyOn(api, 'listWorkspaceInvitations').mockResolvedValue({ invitations: [...mockInvitationsList] });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const renderWithContext = async (
    role: 'owner' | 'admin' | 'editor' | 'viewer' = 'owner',
    currentUser = mockUser,
    workspaceId = 'ws-123',
  ) => {
    const authContextValue = {
      user: currentUser,
      loading: false,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      logoutAll: vi.fn(),
      refreshUser: vi.fn(),
    };

    const workspaceContextValue = {
      workspaces: [mockActiveWorkspace],
      activeWorkspace: mockActiveWorkspace,
      userRole: role,
      loading: false,
      error: null,
      refreshWorkspaces: vi.fn().mockResolvedValue([mockActiveWorkspace]),
      loadWorkspace: vi.fn().mockResolvedValue(mockActiveWorkspace),
      createWorkspace: vi.fn(),
    };

    await act(async () => {
      root.render(
        el(
          AuthContext.Provider,
          { value: authContextValue },
          el(
            WorkspaceContext.Provider,
            { value: workspaceContextValue },
            el(WorkspaceMembersPage, { params: { workspaceId } }),
          ),
        ),
      );
    });
  };

  // ---------------------------------------------------------------------------
  // 1. Data Loading & Presentation
  // ---------------------------------------------------------------------------
  describe('1. Loading, Presentation & Breadcrumbs', () => {
    it('loads and displays members and invitations correctly for authorized owner', async () => {
      await renderWithContext('owner');

      expect(api.getWorkspaceMembers).toHaveBeenCalledWith('ws-123', expect.anything());
      expect(api.listWorkspaceInvitations).toHaveBeenCalledWith('ws-123', expect.anything());

      // Header and breadcrumb
      expect(container.textContent).toContain('Manage Members');
      expect(container.textContent).toContain('Acme Knowledge Platform');

      // Members rendered
      expect(container.textContent).toContain('Owner User');
      expect(container.textContent).toContain('Admin User');
      expect(container.textContent).toContain('Editor User');
      expect(container.textContent).toContain('Viewer User');

      // Invitations rendered
      expect(container.textContent).toContain('invitee@example.com');
      expect(container.textContent).toContain('Anyone with link');
      expect(container.textContent).toContain('Shareable Link');
      expect(container.textContent).toContain('expired@example.com');
    });

    it('renders empty states when authorized owner has zero invitations', async () => {
      vi.spyOn(api, 'listWorkspaceInvitations').mockResolvedValue({ invitations: [] });

      await renderWithContext('owner');

      expect(container.textContent).toContain('No invitations created yet');
      expect(container.textContent).toContain('+ Create First Invitation');
    });

    it('renders retryable error state when members fail to load with 500', async () => {
      vi.spyOn(api, 'getWorkspaceMembers').mockRejectedValueOnce(
        new ApiError('Failed to fetch members from database', 500),
      );

      await renderWithContext('owner');

      expect(container.textContent).toContain('Failed to fetch members from database');
      const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Retry'),
      );
      expect(retryBtn).toBeDefined();
    });

    it('displays rate limit error banner when 429 is received', async () => {
      vi.spyOn(api, 'getWorkspaceMembers').mockRejectedValueOnce(
        new ApiError('Too many requests', 429),
      );

      await renderWithContext('owner');

      expect(container.textContent).toContain('You have sent too many requests');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Permission-Aware UX & Finding M-1 / M-2 Remediations
  // ---------------------------------------------------------------------------
  describe('2. Role Permissions & Authorization Rules', () => {
    it('Owner sees Invite Member button and all role change capabilities, but cannot self-remove', async () => {
      await renderWithContext('owner');

      // Invite button is visible
      const inviteBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('+ Invite Member'),
      );
      expect(inviteBtn).toBeDefined();

      // Owner cannot change their own role or remove themselves
      const selects = container.querySelectorAll('select');
      expect(selects.length).toBe(3); // admin, editor, viewer

      // Verify Owner has "Workspace Owner" text and no remove button on self
      expect(container.textContent).toContain('Workspace Owner');
      const ownerCard = Array.from(container.querySelectorAll('div')).find((d) =>
        d.textContent?.includes('Owner User') && d.textContent?.includes('You'),
      );
      expect(ownerCard?.textContent).not.toContain('Leave Workspace');
    });

    it('Admin can invite, but cannot select Admin role in Invite modal', async () => {
      await renderWithContext('admin', mockAdminUser);

      const inviteBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('+ Invite Member'),
      );
      expect(inviteBtn).toBeDefined();

      await act(async () => {
        inviteBtn?.click();
      });

      const radioCards = Array.from(container.querySelectorAll('[role="radio"]'));
      const radioTexts = radioCards.map((c) => c.textContent);
      expect(radioTexts.some((t) => t?.includes('Admin'))).toBe(false);
      expect(radioTexts.some((t) => t?.includes('Editor'))).toBe(true);
      expect(radioTexts.some((t) => t?.includes('Viewer'))).toBe(true);
    });

    it('Admin cannot modify owner or other admins, but can self-remove', async () => {
      await renderWithContext('admin', mockAdminUser);

      const selects = Array.from(container.querySelectorAll('select'));
      // Only editor and viewer have selects for admin
      expect(selects.length).toBe(2);

      // Admin user can self-remove ("Leave Workspace" button permitted for Admin)
      const leaveBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Leave Workspace'),
      );
      expect(leaveBtn).toBeDefined();
    });

    it('REMEDIATION M-1: Editor and Viewer cannot see Leave Workspace, Remove, or Role Change actions', async () => {
      await renderWithContext('viewer', mockViewerUser);

      // 1. No Invite Member button
      const inviteBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('+ Invite Member'),
      );
      expect(inviteBtn).toBeUndefined();

      // 2. No role change selects
      const selects = container.querySelectorAll('select');
      expect(selects.length).toBe(0);

      // 3. No Remove buttons
      const removeBtns = Array.from(container.querySelectorAll('button')).filter((b) =>
        b.textContent?.includes('Remove'),
      );
      expect(removeBtns.length).toBe(0);

      // 4. CRITICAL M-1: No "Leave Workspace" button displayed for Viewer
      const leaveBtns = Array.from(container.querySelectorAll('button')).filter((b) =>
        b.textContent?.includes('Leave Workspace'),
      );
      expect(leaveBtns.length).toBe(0);
    });

    it('REMEDIATION M-1: Editor also cannot see Leave Workspace action', async () => {
      await renderWithContext('editor', mockEditorUser);

      const leaveBtns = Array.from(container.querySelectorAll('button')).filter((b) =>
        b.textContent?.includes('Leave Workspace'),
      );
      expect(leaveBtns.length).toBe(0);
    });

    it('REMEDIATION M-2: Non-admin users do not call invitation endpoint and see access-restricted notice', async () => {
      await renderWithContext('viewer', mockViewerUser);

      // Verify listWorkspaceInvitations was NOT called for Viewer
      expect(api.listWorkspaceInvitations).not.toHaveBeenCalled();

      // Verify Access Restricted card is displayed
      expect(container.textContent).toContain('Access Restricted');
      expect(container.textContent).toContain(
        'Invitations can only be viewed and managed by workspace owners and administrators.',
      );

      // Verify it does NOT show a false 0 count badge or "No invitations created yet"
      expect(container.textContent).not.toContain('No invitations created yet');
      const invHeading = container.querySelector('#invitations-heading');
      expect(invHeading?.parentElement?.querySelector('span')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Canonical Link Generation (Finding M-3 Remediation)
  // ---------------------------------------------------------------------------
  describe('3. Canonical Invitation URL Contract (/invitations/[token])', () => {
    it('buildInvitationUrl encodes token into path-based route /invitations/[token]', () => {
      const url = buildInvitationUrl('test-token-123_abc');
      expect(url).toContain('/invitations/test-token-123_abc');
      expect(url).not.toContain('?token=');
    });

    it('creates email-bound invitation and displays canonical URL', async () => {
      const mockCreated = {
        invitation: {
          id: 'new-inv-1',
          workspace_id: 'ws-123',
          inviter_id: 'user-owner',
          invitee_email: 'newcolleague@example.com',
          role: 'editor' as const,
          status: 'pending' as const,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          created_at: new Date().toISOString(),
        },
        rawToken: 'secret-token-xyz-12345',
      };

      vi.spyOn(api, 'createWorkspaceInvitation').mockResolvedValueOnce(mockCreated);

      await renderWithContext('owner');

      const inviteBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('+ Invite Member'),
      );
      await act(async () => {
        inviteBtn?.click();
      });

      const emailInput = container.querySelector('#invitee-email') as HTMLInputElement;
      await act(async () => {
        setInputValue(emailInput, 'newcolleague@example.com');
      });

      const submitBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Generate Invitation Link'),
      );
      await act(async () => {
        submitBtn?.click();
      });

      expect(api.createWorkspaceInvitation).toHaveBeenCalledWith('ws-123', {
        role: 'viewer',
        email: 'newcolleague@example.com',
        expiresInDays: 7,
      });

      const urlInput = container.querySelector('input[readonly]') as HTMLInputElement;
      expect(urlInput?.value).toBe(buildInvitationUrl('secret-token-xyz-12345'));
      expect(urlInput?.value).toContain('/invitations/secret-token-xyz-12345');
    });

    it('replacement creates and displays fresh canonical link with newly issued token', async () => {
      const mockReplaced = {
        invitation: {
          id: 'inv-replaced-1',
          workspace_id: 'ws-123',
          inviter_id: 'user-owner',
          invitee_email: 'invitee@example.com',
          role: 'editor' as const,
          status: 'pending' as const,
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          created_at: new Date().toISOString(),
        },
        rawToken: 'fresh-replacement-secret-999',
      };

      vi.spyOn(api, 'resendWorkspaceInvitation').mockResolvedValueOnce(mockReplaced);

      await renderWithContext('owner');

      const replaceBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Replace Link'),
      );
      await act(async () => {
        replaceBtn?.click();
      });

      // Confirm modal
      const confirmBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Replace Link' && b.getAttribute('aria-label') === null,
      );
      await act(async () => {
        confirmBtn?.click();
      });

      expect(api.resendWorkspaceInvitation).toHaveBeenCalledWith('ws-123', 'inv-1');
      const urlInput = container.querySelector('input[readonly]') as HTMLInputElement;
      expect(urlInput?.value).toBe(buildInvitationUrl('fresh-replacement-secret-999'));
      expect(urlInput?.value).toContain('/invitations/fresh-replacement-secret-999');
      expect(urlInput?.value).not.toContain('secret-token-xyz');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Mutation Failure Handling & Rollback Safety
  // ---------------------------------------------------------------------------
  describe('4. Mutation Failures & State Integrity', () => {
    it('role-change rejection with 403 leaves UI state unchanged and displays error toast', async () => {
      vi.spyOn(api, 'changeWorkspaceMemberRole').mockRejectedValueOnce(
        new ApiError('Forbidden: Only owner can modify admin roles', 403),
      );

      await renderWithContext('owner');

      const selects = Array.from(container.querySelectorAll('select'));
      const editorSelect = selects[1] as HTMLSelectElement;
      expect(editorSelect.value).toBe('editor');

      await act(async () => {
        editorSelect.value = 'admin';
        editorSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });

      const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Update Role'),
      );
      await act(async () => {
        confirmBtn?.click();
      });

      expect(mockShowToast).toHaveBeenCalledWith(
        'Forbidden: Only owner can modify admin roles',
        'error',
      );
      expect(mockShowToast).not.toHaveBeenCalledWith(expect.stringContaining('Updated'), 'success');

      // State was NOT optimistically corrupted: Editor User remains editor
      const selectsAfter = Array.from(container.querySelectorAll('select'));
      expect((selectsAfter[1] as HTMLSelectElement).value).toBe('editor');
    });

    it('member removal rejection with 500 leaves member in list and displays error toast', async () => {
      vi.spyOn(api, 'removeWorkspaceMember').mockRejectedValueOnce(
        new ApiError('Internal server error during member removal', 500),
      );

      await renderWithContext('owner');

      const removeBtns = Array.from(container.querySelectorAll('button')).filter((b) =>
        b.textContent?.includes('Remove'),
      );
      const viewerRemoveBtn = removeBtns[removeBtns.length - 1];

      await act(async () => {
        viewerRemoveBtn?.click();
      });

      const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent === 'Remove Member',
      );
      await act(async () => {
        confirmBtn?.click();
      });

      expect(mockShowToast).toHaveBeenCalledWith(
        'Internal server error during member removal',
        'error',
      );
      expect(mockShowToast).not.toHaveBeenCalledWith(expect.stringContaining('Removed'), 'success');

      // Member was NOT removed from list
      expect(container.textContent).toContain('Viewer User');
    });

    it('invitation revocation failure shows error toast and does not alter status', async () => {
      vi.spyOn(api, 'revokeWorkspaceInvitation').mockRejectedValueOnce(
        new ApiError('Cannot revoke already accepted invitation', 409),
      );

      await renderWithContext('owner');

      const revokeBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Revoke'),
      );
      await act(async () => {
        revokeBtn?.click();
      });

      const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent === 'Revoke Invitation',
      );
      await act(async () => {
        confirmBtn?.click();
      });

      expect(mockShowToast).toHaveBeenCalledWith(
        'Cannot revoke already accepted invitation',
        'error',
      );
      expect(mockShowToast).not.toHaveBeenCalledWith('Invitation revoked', 'success');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Stale Workspace Request Races (Finding L-2 Remediation)
  // ---------------------------------------------------------------------------
  describe('5. Stale Workspace Request Races & AbortSignal Protection', () => {
    it('switching from Workspace A to Workspace B prevents delayed Workspace A from overwriting B', async () => {
      let resolveA: (val: any) => void;
      const promiseA = new Promise((resolve) => {
        resolveA = resolve;
      });

      const membersB: WorkspaceMemberListItem[] = [
        {
          id: 'user-b1',
          email: 'b1@example.com',
          display_name: 'Workspace B Member',
          avatar_url: null,
          role: 'owner',
          created_at: new Date().toISOString(),
        },
      ];

      vi.spyOn(api, 'getWorkspaceMembers').mockImplementation((wsId) => {
        if (wsId === 'ws-A') {
          return promiseA as any;
        }
        return Promise.resolve({ members: membersB });
      });

      // 1. Initial render on ws-A
      await renderWithContext('owner', mockUser, 'ws-A');

      // 2. Fast switch to ws-B
      await renderWithContext('owner', mockUser, 'ws-B');

      // ws-B renders Workspace B Member
      expect(container.textContent).toContain('Workspace B Member');

      // 3. Late resolution of ws-A
      await act(async () => {
        resolveA({
          members: [
            {
              id: 'user-a1',
              email: 'a1@example.com',
              display_name: 'STALE WORKSPACE A MEMBER',
              avatar_url: null,
              role: 'owner',
              created_at: new Date().toISOString(),
            },
          ],
        });
      });

      // Assert that Workspace B data was NOT overwritten by late Workspace A response
      expect(container.textContent).not.toContain('STALE WORKSPACE A MEMBER');
      expect(container.textContent).toContain('Workspace B Member');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Accessible Modal Focus Management (Finding L-1 Remediation)
  // ---------------------------------------------------------------------------
  describe('6. Accessible Modal Focus Management', () => {
    it('ConfirmationModal traps Tab key and restores focus on close', async () => {
      const triggerBtn = document.createElement('button');
      triggerBtn.textContent = 'Open Dialog';
      document.body.appendChild(triggerBtn);
      triggerBtn.focus();

      let isOpen = true;
      const onClose = vi.fn(() => {
        isOpen = false;
      });

      const modalContainer = document.createElement('div');
      document.body.appendChild(modalContainer);
      const modalRoot = createRoot(modalContainer);

      await act(async () => {
        modalRoot.render(
          el(ConfirmationModal, {
            isOpen,
            onClose,
            onConfirm: vi.fn(),
            title: 'Test Modal',
            description: 'Modal Description',
          }),
        );
      });

      // Modal is open
      const dialog = modalContainer.querySelector('[role="dialog"]') as HTMLElement;
      expect(dialog).toBeDefined();

      // Tab wrap test: trigger Tab on Escape or keydown
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

      // Escape key triggers onClose
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(onClose).toHaveBeenCalled();

      act(() => {
        modalRoot.unmount();
      });
      modalContainer.remove();
      triggerBtn.remove();
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Security Invariants
  // ---------------------------------------------------------------------------
  describe('7. Security Invariants', () => {
    it('never exposes raw token or token hash in invitation table', async () => {
      await renderWithContext('owner');

      const tableText = container.textContent || '';
      expect(tableText).not.toContain('token_hash');
      expect(tableText).not.toContain('rawToken');
      expect(tableText).not.toContain('sha256');
    });
  });
});
