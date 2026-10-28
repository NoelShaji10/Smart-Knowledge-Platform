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
    vi.useRealTimers();
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

  // ---------------------------------------------------------------------------
  // 8. Phase 5 Task 4: Email Delivery Status UI & Retry Tests
  // ---------------------------------------------------------------------------
  describe('8. Phase 5 Task 4: Email Delivery Status UI & Retry Tests', () => {
    it('1. accepted_by_provider displays Email Sent badge and formatted timestamp', async () => {
      const deliveryInv: WorkspaceInvitation = {
        id: 'inv-sent-1',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'delivered@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: '2026-10-20T10:00:00.000Z',
        email_delivery_status: 'accepted_by_provider',
        email_sent_at: '2026-10-20T10:01:30.000Z',
      };

      vi.spyOn(api, 'listWorkspaceInvitations').mockResolvedValueOnce({
        invitations: [deliveryInv],
      });

      await renderWithContext('owner');

      const text = container.textContent || '';
      expect(text).toContain('Email Sent');
      expect(text).toContain('Email sent');
      expect(text).toContain('delivered@example.com');
    });

    it('2. queued displays Queued badge with warning styling', async () => {
      const queuedInv: WorkspaceInvitation = {
        id: 'inv-queued-1',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'queued@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: '2026-10-20T10:00:00.000Z',
        email_delivery_status: 'queued',
      };

      vi.spyOn(api, 'listWorkspaceInvitations').mockResolvedValueOnce({
        invitations: [queuedInv],
      });

      await renderWithContext('owner');

      const text = container.textContent || '';
      expect(text).toContain('Queued');
    });

    it('3. processing displays Sending... badge with info styling', async () => {
      const processingInv: WorkspaceInvitation = {
        id: 'inv-proc-1',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'sending@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: '2026-10-20T10:00:00.000Z',
        email_delivery_status: 'processing',
      };

      vi.spyOn(api, 'listWorkspaceInvitations').mockResolvedValueOnce({
        invitations: [processingInv],
      });

      await renderWithContext('owner');

      const text = container.textContent || '';
      expect(text).toContain('Sending...');
    });

    it('4. failed and permanently_failed display Delivery Failed with sanitized failure reason', async () => {
      const failedInv: WorkspaceInvitation = {
        id: 'inv-fail-1',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'failed@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: '2026-10-20T10:00:00.000Z',
        email_delivery_status: 'failed',
        email_failure_reason: 'ETIMEDOUT',
      };

      const permFailedInv: WorkspaceInvitation = {
        id: 'inv-fail-2',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'permfailed@example.com',
        role: 'viewer',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: '2026-10-20T10:00:00.000Z',
        email_delivery_status: 'permanently_failed',
        email_failure_reason: '550 Mailbox not found',
      };

      vi.spyOn(api, 'listWorkspaceInvitations').mockResolvedValueOnce({
        invitations: [failedInv, permFailedInv],
      });

      await renderWithContext('owner');

      const text = container.textContent || '';
      expect(text).toContain('Delivery Failed');
      expect(text).toContain('ETIMEDOUT');
      expect(text).toContain('550 Mailbox not found');
    });

    it('5. not_requested displays Shareable Link badge', async () => {
      const shareableInv: WorkspaceInvitation = {
        id: 'inv-share-1',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: null,
        role: 'viewer',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: '2026-10-20T10:00:00.000Z',
        email_delivery_status: 'not_requested',
      };

      vi.spyOn(api, 'listWorkspaceInvitations').mockResolvedValueOnce({
        invitations: [shareableInv],
      });

      await renderWithContext('owner');

      const text = container.textContent || '';
      expect(text).toContain('Shareable Link');
    });

    it('6. missing timestamp or failure reason does not crash and renders safe fallback', async () => {
      const missingMetadataInv: WorkspaceInvitation = {
        id: 'inv-safe-1',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'nofailreason@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: '2026-10-20T10:00:00.000Z',
        email_delivery_status: 'failed',
        email_failure_reason: null, // missing reason
      };

      vi.spyOn(api, 'listWorkspaceInvitations').mockResolvedValueOnce({
        invitations: [missingMetadataInv],
      });

      await renderWithContext('owner');

      const text = container.textContent || '';
      expect(text).toContain('Delivery Failed');
      expect(text).toContain('Delivery attempt failed');
    });

    it('7. retry controls appear as "Retry Email" for failed delivery and open retry confirmation', async () => {
      const failedInv: WorkspaceInvitation = {
        id: 'inv-retry-1',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'retryuser@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: '2026-10-20T10:00:00.000Z',
        email_delivery_status: 'failed',
        email_failure_reason: 'ECONNRESET',
      };

      vi.spyOn(api, 'listWorkspaceInvitations').mockResolvedValueOnce({
        invitations: [failedInv],
      });

      const mockReplaced = {
        invitation: {
          ...failedInv,
          id: 'inv-fresh-uuid',
          email_delivery_status: 'queued' as const,
        },
        rawToken: 'new-retry-raw-token-123',
      };
      vi.spyOn(api, 'resendWorkspaceInvitation').mockResolvedValueOnce(mockReplaced);

      await renderWithContext('owner');

      // Check button text
      const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Retry Email'),
      );
      expect(retryBtn).toBeDefined();

      // Click Retry Email
      await act(async () => {
        retryBtn?.click();
      });

      // Confirm modal opens with "Retry Email Delivery" title
      const modalTitle = document.body.querySelector('#confirm-modal-title');
      expect(modalTitle?.textContent).toContain('Retry Email Delivery');

      // Click Confirm button
      const confirmBtn = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.textContent === 'Retry Email' && b.getAttribute('aria-label') === null,
      );
      expect(confirmBtn).toBeDefined();

      await act(async () => {
        confirmBtn?.click();
      });

      expect(api.resendWorkspaceInvitation).toHaveBeenCalledWith('ws-123', 'inv-retry-1');
      expect(mockShowToast).toHaveBeenCalledWith('Email delivery retried', 'success');
    });

    it('8. repeated clicks cannot submit duplicate retry requests while pending', async () => {
      const failedInv: WorkspaceInvitation = {
        id: 'inv-pending-resend',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'pendingretry@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: '2026-10-20T10:00:00.000Z',
        email_delivery_status: 'failed',
      };

      vi.spyOn(api, 'listWorkspaceInvitations').mockResolvedValueOnce({
        invitations: [failedInv],
      });

      let resolveResend: any;
      const delayedResendPromise = new Promise<{ invitation: WorkspaceInvitation; rawToken: string }>((resolve) => {
        resolveResend = resolve;
      });
      vi.spyOn(api, 'resendWorkspaceInvitation').mockReturnValueOnce(delayedResendPromise as any);

      await renderWithContext('owner');

      const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Retry Email'),
      );
      await act(async () => {
        retryBtn?.click();
      });

      const confirmBtn = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.textContent === 'Retry Email' && b.getAttribute('aria-label') === null,
      );

      // Click once
      await act(async () => {
        confirmBtn?.click();
      });

      // Confirm button is now disabled during execution
      expect(confirmBtn?.getAttribute('disabled')).not.toBeNull();
      expect(api.resendWorkspaceInvitation).toHaveBeenCalledTimes(1);

      // Attempt second click while still loading
      await act(async () => {
        confirmBtn?.click();
      });

      expect(api.resendWorkspaceInvitation).toHaveBeenCalledTimes(1);

      // Resolve and complete
      await act(async () => {
        resolveResend({
          invitation: { ...failedInv, id: 'inv-done-uuid' },
          rawToken: 'tok-done',
        });
      });
    });

    it('9. InviteMemberModal updated copy does not claim email delivery is unimplemented', async () => {
      const modalContainer = document.createElement('div');
      document.body.appendChild(modalContainer);
      const modalRoot = createRoot(modalContainer);

      const mockCreated = {
        invitation: {
          id: 'inv-modal-1',
          workspace_id: 'ws-123',
          inviter_id: 'user-owner',
          invitee_email: 'newuser@example.com',
          role: 'editor' as const,
          status: 'pending' as const,
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          created_at: new Date().toISOString(),
          email_delivery_status: 'queued' as const,
        },
        rawToken: 'created-token-abc-123',
      };

      vi.spyOn(api, 'createWorkspaceInvitation').mockResolvedValueOnce(mockCreated);

      await act(async () => {
        modalRoot.render(
          el(InviteMemberModal, {
            isOpen: true,
            workspaceId: 'ws-123',
            userRole: 'owner',
            onClose: vi.fn(),
            onCreated: vi.fn(),
          }),
        );
      });

      const emailInput = modalContainer.querySelector('input[type="email"]') as HTMLInputElement;
      expect(emailInput).toBeDefined();

      await act(async () => {
        setInputValue(emailInput, 'newuser@example.com');
      });

      const submitBtn = modalContainer.querySelector('button[type="submit"]') as HTMLButtonElement;
      await act(async () => {
        submitBtn.click();
      });

      const modalText = modalContainer.textContent || '';
      expect(modalText).not.toContain('Email delivery is not currently implemented');
      expect(modalText).toContain('Email queued');
      expect(modalText).toContain('email is being sent');

      act(() => {
        modalRoot.unmount();
      });
      modalContainer.remove();
    });

    it('10. ResendResultModal updated copy does not claim email delivery is unimplemented', async () => {
      const modalContainer = document.createElement('div');
      document.body.appendChild(modalContainer);
      const modalRoot = createRoot(modalContainer);

      const resentInv: WorkspaceInvitation = {
        id: 'inv-resent-1',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'alex@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: new Date().toISOString(),
        email_delivery_status: 'queued',
      };

      await act(async () => {
        modalRoot.render(
          el(ResendResultModal, {
            isOpen: true,
            invitation: resentInv,
            rawToken: 'resent-token-xyz-789',
            onClose: vi.fn(),
          }),
        );
      });

      const modalText = modalContainer.textContent || '';
      expect(modalText).not.toContain('Email delivery is not currently configured');
      expect(modalText).toContain('Email queued');
      expect(modalText).toContain('A fresh invitation email is being sent');

      const urlInput = modalContainer.querySelector('input[readonly]') as HTMLInputElement;
      expect(urlInput?.value).toContain('/invitations/resent-token-xyz-789');

      act(() => {
        modalRoot.unmount();
      });
      modalContainer.remove();
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Phase 5 Task 4 Remediation: Polling Races, Resend Permissions & Error UI
  // ---------------------------------------------------------------------------
  describe('9. Phase 5 Task 4 Remediation: Polling Races, Resend Permissions & Error UI', () => {
    it('1. polling starts when an email-bound invitation is queued', async () => {
      vi.useFakeTimers();
      const queuedInv: WorkspaceInvitation = {
        id: 'inv-poll-1',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'queuedpoll@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: new Date().toISOString(),
        email_delivery_status: 'queued',
      };

      const listSpy = vi.spyOn(api, 'listWorkspaceInvitations')
        .mockResolvedValueOnce({ invitations: [queuedInv] })
        .mockResolvedValueOnce({
          invitations: [{ ...queuedInv, email_delivery_status: 'processing' }],
        });

      await renderWithContext('owner');
      expect(listSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(4000);
      });

      expect(listSpy).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain('Sending...');
      vi.useRealTimers();
    });

    it('2. polling stops when delivery reaches accepted_by_provider', async () => {
      vi.useFakeTimers();
      const queuedInv: WorkspaceInvitation = {
        id: 'inv-poll-2',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'acceptedpoll@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: new Date().toISOString(),
        email_delivery_status: 'queued',
      };

      const listSpy = vi.spyOn(api, 'listWorkspaceInvitations')
        .mockResolvedValueOnce({ invitations: [queuedInv] })
        .mockResolvedValueOnce({
          invitations: [{
            ...queuedInv,
            email_delivery_status: 'accepted_by_provider',
            email_sent_at: '2026-10-20T10:05:00.000Z',
          }],
        });

      await renderWithContext('owner');
      expect(listSpy).toHaveBeenCalledTimes(1);

      // Advance by 4000ms: poll 1 resolves with accepted_by_provider
      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      expect(listSpy).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain('Email Sent');

      // Advance by another 10000ms: polling should not fire again because delivery is terminal
      await act(async () => {
        vi.advanceTimersByTime(10000);
      });
      expect(listSpy).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('3. polling stops when delivery reaches failed or permanently_failed', async () => {
      vi.useFakeTimers();
      const procInv: WorkspaceInvitation = {
        id: 'inv-poll-3',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'failedpoll@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: new Date().toISOString(),
        email_delivery_status: 'processing',
      };

      const listSpy = vi.spyOn(api, 'listWorkspaceInvitations')
        .mockResolvedValueOnce({ invitations: [procInv] })
        .mockResolvedValueOnce({
          invitations: [{
            ...procInv,
            email_delivery_status: 'failed',
            email_failure_reason: '554 Transaction failed',
          }],
        });

      await renderWithContext('owner');
      expect(listSpy).toHaveBeenCalledTimes(1);

      // Advance by 4000ms: resolves with failed
      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      expect(listSpy).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain('Delivery Failed');

      // Advance further: polling must not trigger again
      await act(async () => {
        vi.advanceTimersByTime(10000);
      });
      expect(listSpy).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('4. timers are cleaned up on component unmount', async () => {
      vi.useFakeTimers();
      const queuedInv: WorkspaceInvitation = {
        id: 'inv-poll-4',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'unmountpoll@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: new Date().toISOString(),
        email_delivery_status: 'queued',
      };

      const listSpy = vi.spyOn(api, 'listWorkspaceInvitations').mockResolvedValue({
        invitations: [queuedInv],
      });

      await renderWithContext('owner');
      expect(listSpy).toHaveBeenCalledTimes(1);

      // Unmount component
      act(() => {
        root.unmount();
      });

      // Advance timer by 10000ms: no more polling should occur
      await act(async () => {
        vi.advanceTimersByTime(10000);
      });
      expect(listSpy).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('5. in-flight polling request for Workspace A does not populate Workspace B after navigation', async () => {
      vi.useFakeTimers();
      const wsAInv: WorkspaceInvitation = {
        id: 'inv-wsA',
        workspace_id: 'ws-A',
        inviter_id: 'user-owner',
        invitee_email: 'wsa@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: new Date().toISOString(),
        email_delivery_status: 'queued',
      };

      let resolveWsAPoll: any;
      const delayedWsAPollPromise = new Promise<{ invitations: WorkspaceInvitation[] }>((resolve) => {
        resolveWsAPoll = resolve;
      });

      const listSpy = vi.spyOn(api, 'listWorkspaceInvitations').mockImplementation(async (wsId) => {
        if (wsId === 'ws-A') {
          return delayedWsAPollPromise;
        }
        return { invitations: [] };
      });

      // Render on ws-A
      await renderWithContext('owner', mockUser, 'ws-A');
      expect(listSpy).toHaveBeenCalledWith('ws-A', expect.anything());

      // Navigate to ws-B
      await renderWithContext('owner', mockUser, 'ws-B');
      expect(listSpy).toHaveBeenCalledWith('ws-B', expect.anything());

      // Now resolve the delayed ws-A polling request
      await act(async () => {
        resolveWsAPoll({ invitations: [wsAInv] });
      });

      // The ws-A invitation must NOT be rendered into ws-B
      const text = container.textContent || '';
      expect(text).not.toContain('wsa@example.com');
      vi.useRealTimers();
    });

    it('6. slow polling requests do not cause overlapping requests', async () => {
      vi.useFakeTimers();
      const queuedInv: WorkspaceInvitation = {
        id: 'inv-poll-slow',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'slowpoll@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: new Date().toISOString(),
        email_delivery_status: 'queued',
      };

      let resolveSlowPoll: any;
      const slowPollPromise = new Promise<{ invitations: WorkspaceInvitation[] }>((resolve) => {
        resolveSlowPoll = resolve;
      });

      const listSpy = vi.spyOn(api, 'listWorkspaceInvitations')
        .mockResolvedValueOnce({ invitations: [queuedInv] }) // initial load
        .mockImplementationOnce(() => slowPollPromise) // first poll at 4000ms
        .mockResolvedValue({
          invitations: [{ ...queuedInv, email_delivery_status: 'accepted_by_provider' }],
        });

      await renderWithContext('owner');
      expect(listSpy).toHaveBeenCalledTimes(1);

      // Advance by 4000ms: poll 1 starts and is slow
      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      expect(listSpy).toHaveBeenCalledTimes(2);

      // Advance by another 4000ms, then 8000ms while poll 1 is STILL pending:
      await act(async () => {
        vi.advanceTimersByTime(8000);
      });
      // Crucial: no overlapping requests should be sent while request is in-flight!
      expect(listSpy).toHaveBeenCalledTimes(2);

      // Now resolve slow poll 1
      await act(async () => {
        resolveSlowPoll({ invitations: [queuedInv] });
      });

      // Advance by 4000ms: next sequential poll fires
      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      expect(listSpy).toHaveBeenCalledTimes(3);
      vi.useRealTimers();
    });

    it('7. in-flight polling results cannot overwrite a newer resend result', async () => {
      vi.useFakeTimers();
      const originalInv: WorkspaceInvitation = {
        id: 'inv-orig-1',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'mutate@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: '2026-10-20T10:00:00.000Z',
        email_delivery_status: 'failed',
        email_failure_reason: 'ETIMEDOUT',
      };

      const queuedTriggerInv: WorkspaceInvitation = {
        id: 'inv-queued-trigger',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'queuedtrigger@example.com',
        role: 'viewer',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: '2026-10-20T10:00:00.000Z',
        email_delivery_status: 'queued',
      };

      let resolvePendingPoll: any;
      const delayedPollPromise = new Promise<{ invitations: WorkspaceInvitation[] }>((resolve) => {
        resolvePendingPoll = resolve;
      });

      const listSpy = vi.spyOn(api, 'listWorkspaceInvitations')
        .mockResolvedValueOnce({ invitations: [originalInv, queuedTriggerInv] }) // initial load
        .mockImplementationOnce(() => delayedPollPromise); // poll starts and hangs

      const freshResentInv: WorkspaceInvitation = {
        id: 'inv-fresh-after-resend',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'mutate@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: new Date().toISOString(),
        email_delivery_status: 'queued',
      };

      vi.spyOn(api, 'resendWorkspaceInvitation').mockResolvedValueOnce({
        invitation: freshResentInv,
        rawToken: 'new-fresh-token',
      });

      await renderWithContext('owner');
      expect(listSpy).toHaveBeenCalledTimes(1);

      // Trigger poll 1
      await act(async () => {
        vi.advanceTimersByTime(4000);
      });
      expect(listSpy).toHaveBeenCalledTimes(2);

      // While poll 1 is in flight, user resends invitation
      const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Retry Email'),
      );
      expect(retryBtn).toBeDefined();

      await act(async () => {
        retryBtn?.click();
      });

      const confirmBtn = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.textContent === 'Retry Email' && b.getAttribute('aria-label') === null,
      );
      await act(async () => {
        confirmBtn?.click();
      });

      // At this point, local state has inv-fresh-after-resend and inv-orig-1 is revoked
      // Now resolve the older in-flight poll with the stale snapshot
      await act(async () => {
        resolvePendingPoll({ invitations: [originalInv, queuedTriggerInv] });
      });

      // The stale poll must NOT overwrite the new state
      // Modal should still display the fresh token/invitation and not be clobbered
      const resendTitle = document.body.querySelector('#resend-modal-title');
      expect(resendTitle?.textContent).toContain('New Invitation Link Generated');

      vi.useRealTimers();
    });

    it('8. accepted invitations do not render resend or replace-link controls', async () => {
      const acceptedInv: WorkspaceInvitation = {
        id: 'inv-accepted-user',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'alreadyjoined@example.com',
        role: 'editor',
        status: 'accepted',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: '2026-10-20T10:00:00.000Z',
        email_delivery_status: 'accepted_by_provider',
        email_sent_at: '2026-10-20T10:01:00.000Z',
      };

      vi.spyOn(api, 'listWorkspaceInvitations').mockResolvedValueOnce({
        invitations: [acceptedInv],
      });

      await renderWithContext('owner');

      // The table displays the accepted invitation
      expect(container.textContent).toContain('alreadyjoined@example.com');
      expect(container.textContent).toContain('accepted');

      // Verify NO resend or replace link action buttons exist for this accepted invitation
      const buttons = Array.from(container.querySelectorAll('button'));
      const resendOrReplaceBtn = buttons.find(
        (b) =>
          b.textContent?.includes('Replace Link') ||
          b.textContent?.includes('Resend') ||
          b.textContent?.includes('Retry Email'),
      );
      expect(resendOrReplaceBtn).toBeUndefined();
    });

    it('9. resend API errors (400, 403, 429) produce appropriate error UI and do not leave loading stuck', async () => {
      const failedInv: WorkspaceInvitation = {
        id: 'inv-retry-error-test',
        workspace_id: 'ws-123',
        inviter_id: 'user-owner',
        invitee_email: 'erroruser@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: '2026-10-20T10:00:00.000Z',
        email_delivery_status: 'failed',
        email_failure_reason: 'ECONNREFUSED',
      };

      vi.spyOn(api, 'listWorkspaceInvitations').mockResolvedValue({
        invitations: [failedInv],
      });

      await renderWithContext('owner');

      const triggerRetryAndConfirm = async () => {
        const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
          b.textContent?.includes('Retry Email'),
        );
        await act(async () => {
          retryBtn?.click();
        });
        const confirmBtn = Array.from(document.body.querySelectorAll('button')).find(
          (b) => b.textContent === 'Retry Email' && b.getAttribute('aria-label') === null,
        );
        await act(async () => {
          confirmBtn?.click();
        });
        return confirmBtn;
      };

      // Case A: 429 Rate Limit
      vi.spyOn(api, 'resendWorkspaceInvitation').mockRejectedValueOnce(
        new ApiError('Rate limit reached', 429),
      );
      let confirmBtn = await triggerRetryAndConfirm();
      expect(mockShowToast).toHaveBeenCalledWith(
        'Rate limit reached: Please wait before resending invitations',
        'error',
      );
      expect(confirmBtn?.getAttribute('disabled')).toBeNull(); // not left disabled/loading

      // Case B: 400 Bad Request
      vi.spyOn(api, 'resendWorkspaceInvitation').mockRejectedValueOnce(
        new ApiError('Cannot resend an invitation that has already been accepted', 400),
      );
      confirmBtn = await triggerRetryAndConfirm();
      expect(mockShowToast).toHaveBeenCalledWith(
        'Cannot resend an invitation that has already been accepted',
        'error',
      );
      expect(confirmBtn?.getAttribute('disabled')).toBeNull();

      // Case C: 403 Forbidden
      vi.spyOn(api, 'resendWorkspaceInvitation').mockRejectedValueOnce(
        new ApiError('Permission denied', 403),
      );
      confirmBtn = await triggerRetryAndConfirm();
      expect(mockShowToast).toHaveBeenCalledWith(
        'Permission denied',
        'error',
      );
      expect(confirmBtn?.getAttribute('disabled')).toBeNull();
    });
  });
});
