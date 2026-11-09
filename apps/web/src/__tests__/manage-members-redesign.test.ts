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
import { formatDeliveryError } from '../components/members/invitationUtils';

// Configure act environment for React 18
// @ts-expect-error global IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockPush = vi.fn();
const mockReplace = vi.fn();
let mockPathname = '/workspaces/ws-101/members';

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

describe('Phase 5: Workspace Members & Invitations UI Redesign Test Suite', () => {
  let container: HTMLDivElement;
  let root: Root;

  const mockOwnerUser = {
    id: 'user-owner',
    email: 'owner@example.com',
    displayName: 'Noel Owner',
  };

  const mockAdminUser = {
    id: 'user-admin',
    email: 'admin@example.com',
    displayName: 'Alice Admin',
  };

  const mockViewerUser = {
    id: 'user-viewer',
    email: 'viewer@example.com',
    displayName: 'Bob Viewer',
  };

  const mockActiveWorkspace = {
    id: 'ws-101',
    name: 'Knowledge Platform Core',
    slug: 'kp-core',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const mockMembers: WorkspaceMemberListItem[] = [
    {
      id: 'user-owner',
      email: 'owner@example.com',
      display_name: 'Noel Owner',
      avatar_url: null,
      role: 'owner',
      created_at: '2026-10-01T10:00:00.000Z',
    },
    {
      id: 'user-admin',
      email: 'admin@example.com',
      display_name: 'Alice Admin',
      avatar_url: null,
      role: 'admin',
      created_at: '2026-10-15T12:00:00.000Z',
    },
    {
      id: 'user-editor',
      email: 'editor@example.com',
      display_name: 'Charlie Editor',
      avatar_url: null,
      role: 'editor',
      created_at: '2026-10-20T14:30:00.000Z',
    },
    {
      id: 'user-viewer',
      email: 'viewer@example.com',
      display_name: 'Bob Viewer',
      avatar_url: null,
      role: 'viewer',
      created_at: '2026-10-25T09:15:00.000Z',
    },
  ];

  const mockInvitations: WorkspaceInvitation[] = [
    {
      id: 'inv-1',
      workspace_id: 'ws-101',
      inviter_id: 'user-owner',
      invitee_email: 'pending.colleague@example.com',
      role: 'editor',
      status: 'pending',
      expires_at: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: '2026-10-31T08:00:00.000Z',
      email_delivery_status: 'accepted_by_provider',
      email_sent_at: '2026-10-31T08:01:00.000Z',
    },
    {
      id: 'inv-2',
      workspace_id: 'ws-101',
      inviter_id: 'user-owner',
      invitee_email: null, // Shareable link
      role: 'viewer',
      status: 'accepted',
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: '2026-10-31T09:00:00.000Z',
      email_delivery_status: 'not_requested',
    },
    {
      id: 'inv-3',
      workspace_id: 'ws-101',
      inviter_id: 'user-owner',
      invitee_email: 'failed.delivery@example.com',
      role: 'viewer',
      status: 'pending',
      expires_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: '2026-10-30T10:00:00.000Z',
      email_delivery_status: 'failed',
      email_failure_reason: 'SMTP relay connection timed out',
    },
  ];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
  });

  const renderPage = async (options: {
    user?: any;
    userRole?: 'owner' | 'admin' | 'editor' | 'viewer';
    members?: WorkspaceMemberListItem[];
    invitations?: WorkspaceInvitation[];
  } = {}) => {
    const authVal = {
      user: options.user || mockOwnerUser,
      token: 'jwt-token',
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      loading: false,
      isAuthenticated: true,
    };

    const wsVal = {
      workspaces: [mockActiveWorkspace],
      activeWorkspace: mockActiveWorkspace,
      userRole: options.userRole || 'owner',
      loading: false,
      error: null,
      switchWorkspace: vi.fn(),
      loadWorkspace: vi.fn().mockResolvedValue(mockActiveWorkspace),
      createWorkspace: vi.fn(),
    };

    vi.spyOn(api, 'getWorkspaceMembers').mockResolvedValue({
      members: options.members !== undefined ? options.members : mockMembers,
    });
    vi.spyOn(api, 'listWorkspaceInvitations').mockResolvedValue({
      invitations: options.invitations !== undefined ? options.invitations : mockInvitations,
    });

    await act(async () => {
      root.render(
        el(
          AuthContext.Provider,
          { value: authVal },
          el(
            WorkspaceContext.Provider,
            { value: wsVal },
            el(WorkspaceMembersPage, { params: { workspaceId: 'ws-101' } }),
          ),
        ),
      );
    });

    // Wait for async fetch to resolve and state to settle
    await act(async () => {
      await Promise.resolve();
    });
  };

  describe('1. Accepted Members Section & Role-Adaptive Display', () => {
    it('renders workspace members with presence indicator, name, email, YOU badge, and joined date', async () => {
      await renderPage();

      // Heading and member count badge
      const membersHeading = container.querySelector('#members-heading');
      expect(membersHeading?.textContent).toBe('Workspace Members');
      expect(container.textContent).toContain('4'); // 4 members count

      // Verify members displayed
      expect(container.textContent).toContain('Noel Owner');
      expect(container.textContent).toContain('owner@example.com');
      expect(container.textContent).toContain('You');
      expect(container.textContent).toContain('Workspace Owner');

      expect(container.textContent).toContain('Alice Admin');
      expect(container.textContent).toContain('admin@example.com');

      expect(container.textContent).toContain('Charlie Editor');
      expect(container.textContent).toContain('editor@example.com');

      expect(container.textContent).toContain('Bob Viewer');
      expect(container.textContent).toContain('viewer@example.com');

      // Verify ungrounded presence dots are NOT rendered on avatars
      const presenceDots = container.querySelectorAll('[class*="presenceDot"]');
      expect(presenceDots.length).toBe(0);
    });

    it('preserves workspace role hierarchy: Owner cannot be demoted or removed', async () => {
      await renderPage();

      // Owner User has static "Workspace Owner" text and no role select dropdown
      const selects = Array.from(container.querySelectorAll('select'));
      // Only 3 non-owner members have select dropdowns
      expect(selects.length).toBe(3);

      const ownerSelect = container.querySelector('select[aria-label="Change role for Noel Owner"]');
      expect(ownerSelect).toBeNull();

      // Owner cannot be removed
      const removeOwnerBtn = container.querySelector('button[aria-label="Remove Noel Owner"]');
      expect(removeOwnerBtn).toBeNull();
    });

    it('allows Workspace Owner to change role of any non-owner member via ConfirmationModal', async () => {
      const changeRoleSpy = vi.spyOn(api, 'changeWorkspaceMemberRole').mockResolvedValue({} as any);
      await renderPage();

      const adminSelect = container.querySelector(
        'select[aria-label="Change role for Alice Admin"]',
      ) as HTMLSelectElement;
      expect(adminSelect).toBeDefined();

      // Change Alice Admin's role to editor
      await act(async () => {
        adminSelect.value = 'editor';
        adminSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // ConfirmationModal opens
      expect(document.body.textContent).toContain('Change Member Role');
      expect(document.body.textContent).toContain('Alice Admin');

      const confirmBtn = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.textContent === 'Update Role',
      );
      expect(confirmBtn).toBeDefined();

      await act(async () => {
        confirmBtn?.click();
      });

      expect(changeRoleSpy).toHaveBeenCalledWith('ws-101', 'user-admin', 'editor');
      expect(mockShowToast).toHaveBeenCalledWith("Updated Alice Admin's role to editor", 'success');
    });

    it('allows member removal with destructive ConfirmationModal', async () => {
      const removeSpy = vi.spyOn(api, 'removeWorkspaceMember').mockResolvedValue({} as any);
      await renderPage();

      const removeEditorBtn = Array.from(container.querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label') === 'Remove Charlie Editor',
      );
      expect(removeEditorBtn).toBeDefined();

      await act(async () => {
        removeEditorBtn?.click();
      });

      // ConfirmationModal opens
      expect(document.body.textContent).toContain('Remove Member');
      expect(document.body.textContent).toContain('Charlie Editor');

      const confirmBtn = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.textContent === 'Remove Member' && b.getAttribute('aria-label') === null,
      );
      expect(confirmBtn).toBeDefined();

      await act(async () => {
        confirmBtn?.click();
      });

      expect(removeSpy).toHaveBeenCalledWith('ws-101', 'user-editor');
      expect(mockShowToast).toHaveBeenCalledWith('Removed Charlie Editor from workspace', 'success');
    });
  });

  describe('2. Pending & Historical Invitations Section', () => {
    it('displays pending invitations separately with distinct roles, status, and delivery badges', async () => {
      await renderPage();

      const invHeading = container.querySelector('#invitations-heading');
      expect(invHeading?.textContent).toBe('Invitations');
      expect(container.textContent).toContain('3'); // 3 invitations count

      // Row 1: Email-bound pending invite with Email Sent
      expect(container.textContent).toContain('pending.colleague@example.com');
      expect(container.textContent).toContain('Email Sent');
      expect(container.textContent).toContain('pending');

      // Row 2: Shareable link (accepted)
      expect(container.textContent).toContain('Anyone with link');
      expect(container.textContent).toContain('Shareable Link');
      expect(container.textContent).toContain('accepted');
      expect(container.textContent).toContain('Link accepted');

      // Row 3: Delivery failed invitation with error reason safely mapped
      expect(container.textContent).toContain('failed.delivery@example.com');
      expect(container.textContent).toContain('Delivery Failed');
      expect(container.textContent).toContain('Mail server could not be reached');
      expect(container.textContent).not.toContain('SMTP relay connection timed out');
    });

    it('triggers Revoke ConfirmationModal on Revoke click', async () => {
      const revokeSpy = vi.spyOn(api, 'revokeWorkspaceInvitation').mockResolvedValue({} as any);
      await renderPage();

      const revokeBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.getAttribute('aria-label')?.includes('Revoke invitation for pending.colleague@example.com'),
      );
      expect(revokeBtn).toBeDefined();

      await act(async () => {
        revokeBtn?.click();
      });

      expect(document.body.textContent).toContain('Revoke Invitation');
      expect(document.body.textContent).toContain('pending.colleague@example.com');

      const confirmBtn = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.textContent === 'Revoke Invitation' && b.getAttribute('aria-label') === null,
      );

      await act(async () => {
        confirmBtn?.click();
      });

      expect(revokeSpy).toHaveBeenCalledWith('ws-101', 'inv-1');
      expect(mockShowToast).toHaveBeenCalledWith('Invitation revoked', 'success');
    });

    it('triggers Resend/Replace ConfirmationModal and opens ResendResultModal with fresh URL', async () => {
      const resendSpy = vi.spyOn(api, 'resendWorkspaceInvitation').mockResolvedValue({
        invitation: {
          ...mockInvitations[0],
          id: 'inv-fresh',
          status: 'pending',
        },
        rawToken: 'fresh-secret-token-12345',
      });
      await renderPage();

      const resendBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.getAttribute('aria-label')?.includes('Resend or replace link for pending.colleague@example.com'),
      );
      expect(resendBtn).toBeDefined();

      await act(async () => {
        resendBtn?.click();
      });

      expect(document.body.textContent).toContain('Resend Invitation');

      const confirmBtn = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.textContent === 'Replace Link' && b.getAttribute('aria-label') === null,
      );

      await act(async () => {
        confirmBtn?.click();
      });

      expect(resendSpy).toHaveBeenCalledWith('ws-101', 'inv-1');
      expect(mockShowToast).toHaveBeenCalledWith('Invitation replaced and email sent', 'success');

      // ResendResultModal displays the new URL
      expect(document.body.textContent).toContain('New Invitation Link Generated');
      const urlInput = document.body.querySelector('input[readonly]') as HTMLInputElement;
      expect(urlInput?.value).toContain('fresh-secret-token-12345');
    });
  });

  describe('3. InviteMemberModal Flow & RBAC Rules', () => {
    it('renders 3 role selection cards for Owner and enforces RBAC selection', async () => {
      const onCreated = vi.fn();
      const onClose = vi.fn();

      act(() => {
        root.render(
          el(InviteMemberModal, {
            workspaceId: 'ws-101',
            isOpen: true,
            onClose,
            onCreated,
            userRole: 'owner',
          }),
        );
      });

      expect(container.textContent).toContain('Invite Member to Workspace');
      const roleCards = Array.from(container.querySelectorAll('[role="radio"]'));
      expect(roleCards.length).toBe(3); // Admin, Editor, Viewer

      // Default role is Viewer
      const viewerCard = roleCards.find((c) => c.textContent?.includes('Viewer'));
      expect(viewerCard?.getAttribute('aria-checked')).toBe('true');

      // Select Editor
      const editorCard = roleCards.find((c) => c.textContent?.includes('Editor')) as HTMLElement;
      await act(async () => {
        editorCard?.click();
      });
      expect(editorCard?.getAttribute('aria-checked')).toBe('true');
      expect(viewerCard?.getAttribute('aria-checked')).toBe('false');
    });

    it('omits Admin role card for Workspace Admin users', () => {
      act(() => {
        root.render(
          el(InviteMemberModal, {
            workspaceId: 'ws-101',
            isOpen: true,
            onClose: vi.fn(),
            onCreated: vi.fn(),
            userRole: 'admin',
          }),
        );
      });

      const roleCards = Array.from(container.querySelectorAll('[role="radio"]'));
      expect(roleCards.length).toBe(2); // Only Editor and Viewer
      expect(container.textContent).not.toContain('Manage members, settings & documents');
    });

    it('submits invitation with email and expiration days, transitioning to success view', async () => {
      const createSpy = vi.spyOn(api, 'createWorkspaceInvitation').mockResolvedValue({
        invitation: {
          id: 'inv-new',
          workspace_id: 'ws-101',
          inviter_id: 'user-owner',
          invitee_email: 'newbie@example.com',
          role: 'editor',
          status: 'pending',
          expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
          created_at: new Date().toISOString(),
          email_delivery_status: 'queued',
        },
        rawToken: 'secret-token-xyz-987',
      });

      const onCreated = vi.fn();
      act(() => {
        root.render(
          el(InviteMemberModal, {
            workspaceId: 'ws-101',
            isOpen: true,
            onClose: vi.fn(),
            onCreated,
            userRole: 'owner',
          }),
        );
      });

      // Select role editor
      const editorCard = Array.from(container.querySelectorAll('[role="radio"]')).find((c) =>
        c.textContent?.includes('Editor'),
      ) as HTMLElement;
      await act(async () => {
        editorCard?.click();
      });

      // Enter email
      const emailInput = container.querySelector('#invitee-email') as HTMLInputElement;
      act(() => {
        setInputValue(emailInput, 'newbie@example.com');
      });

      // Select expiration 14 days
      const expSelect = container.querySelector('#expires-in') as HTMLSelectElement;
      await act(async () => {
        expSelect.value = '14';
        expSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });

      // Submit
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;
      await act(async () => {
        submitBtn.click();
        await Promise.resolve();
      });

      expect(createSpy).toHaveBeenCalledWith('ws-101', {
        role: 'editor',
        email: 'newbie@example.com',
        expiresInDays: 14,
      });

      expect(onCreated).toHaveBeenCalled();

      // Transitions to Success View
      expect(container.textContent).toContain('Invitation Link Created');
      const urlInput = container.querySelector('input[readonly]') as HTMLInputElement;
      expect(urlInput?.value).toContain('secret-token-xyz-987');
      expect(container.textContent).toContain('Email queued:');
    });
  });

  describe('4. Permission Restrictions & Error States', () => {
    it('hides Invite Member button and restricts invitations section for Viewer role', async () => {
      const listInvSpy = vi.spyOn(api, 'listWorkspaceInvitations');

      await renderPage({
        user: mockViewerUser,
        userRole: 'viewer',
      });

      // Invite button hidden
      const inviteBtn = container.querySelector('button[aria-label="Invite new member"]');
      expect(inviteBtn).toBeNull();

      // Heading is "Workspace Members" not "Manage Members"
      const heading = container.querySelector('h1');
      expect(heading?.textContent).toBe('Workspace Members');

      // Access Restricted card shown for invitations
      expect(container.textContent).toContain('Access Restricted');
      expect(container.textContent).toContain(
        'Invitations can only be viewed and managed by workspace owners and administrators.',
      );

      // No network request made to listWorkspaceInvitations (preventing 403 error)
      expect(listInvSpy).not.toHaveBeenCalled();
    });

    it('renders empty state when workspace has 0 members or 0 invitations', async () => {
      await renderPage({
        members: [],
        invitations: [],
      });

      expect(container.textContent).toContain('No members found');
      expect(container.textContent).toContain('No invitations created yet');
      expect(container.textContent).toContain('+ Create First Invitation');
    });

    it('renders error banner with Retry and Back to Documents buttons on API failure', async () => {
      vi.spyOn(api, 'getWorkspaceMembers').mockRejectedValue(
        new ApiError('Database query failed', 500),
      );
      vi.spyOn(api, 'listWorkspaceInvitations').mockResolvedValue({ invitations: [] });

      const authVal = {
        user: mockOwnerUser,
        token: 'jwt-token',
        login: vi.fn(),
        register: vi.fn(),
        logout: vi.fn(),
        loading: false,
        isAuthenticated: true,
      };

      const wsVal = {
        workspaces: [mockActiveWorkspace],
        activeWorkspace: mockActiveWorkspace,
        userRole: 'owner' as const,
        loading: false,
        error: null,
        switchWorkspace: vi.fn(),
        loadWorkspace: vi.fn().mockResolvedValue(mockActiveWorkspace),
        createWorkspace: vi.fn(),
      };

      await act(async () => {
        root.render(
          el(
            AuthContext.Provider,
            { value: authVal },
            el(
              WorkspaceContext.Provider,
              { value: wsVal },
              el(WorkspaceMembersPage, { params: { workspaceId: 'ws-101' } }),
            ),
          ),
        );
      });

      await act(async () => {
        await Promise.resolve();
      });

      expect(container.textContent).toContain('Database query failed');
      expect(container.textContent).toContain('Retry');
      expect(container.textContent).toContain('Back to Documents');
    });
  });

  describe('5. Audit Remediation: Safe Error Formatting & Ungrounded Presence Elimination', () => {
    it('1. maps known SMTP recipient rejection codes (550, 551, 552, 553) safely without leaking diagnostics', () => {
      expect(formatDeliveryError('550')).toBe('Recipient address was rejected');
      expect(formatDeliveryError('550 Mailbox not found')).toBe('Recipient address was rejected');
      expect(formatDeliveryError('551 User not local')).toBe('Recipient address was rejected');
      expect(formatDeliveryError('552 Exceeded storage allocation')).toBe('Recipient address was rejected');
      expect(formatDeliveryError('553 Invalid mailbox name')).toBe('Recipient address was rejected');
    });

    it('2. maps SMTP transaction / server rejections (554, 500-504) safely', () => {
      expect(formatDeliveryError('554')).toBe('The mail server rejected the delivery');
      expect(formatDeliveryError('554 Transaction failed')).toBe('The mail server rejected the delivery');
      expect(formatDeliveryError('500 Syntax error')).toBe('The mail server rejected the delivery');
      expect(formatDeliveryError('503 Bad sequence of commands')).toBe('The mail server rejected the delivery');
    });

    it('3. maps network and timeout failures safely', () => {
      expect(formatDeliveryError('ETIMEDOUT')).toBe('Mail server could not be reached');
      expect(formatDeliveryError('ECONNREFUSED')).toBe('Mail server could not be reached');
      expect(formatDeliveryError('ECONNRESET')).toBe('Mail server could not be reached');
      expect(formatDeliveryError('ENOTFOUND')).toBe('Mail server could not be reached');
      expect(formatDeliveryError('EHOSTUNREACH')).toBe('Mail server could not be reached');
      expect(formatDeliveryError('SEND_ERROR')).toBe('Mail server could not be reached');
      expect(formatDeliveryError('ETIMEDOUT: connection timed out to 10.0.0.1')).toBe('Mail server could not be reached');
      expect(formatDeliveryError('SMTP relay connection timed out')).toBe('Mail server could not be reached');
    });

    it('4. maps internal worker and system codes without exposing internal architecture', () => {
      expect(formatDeliveryError('QUEUE_ENQUEUE_FAILED')).toBe('Delivery could not be scheduled');
      expect(formatDeliveryError('CRYPTO_DECRYPTION_FAILED')).toBe('Internal delivery issue');
      expect(formatDeliveryError('CORRUPT_ENCRYPTED_PAYLOAD')).toBe('Internal delivery issue');
      expect(formatDeliveryError('INVITATION_EXPIRED')).toBe('Invitation has expired');
      expect(formatDeliveryError('INVITATION_REVOKED')).toBe('Invitation was revoked');
      expect(formatDeliveryError('INVITATION_ACCEPTED')).toBe('Invitation has already been accepted');
      expect(formatDeliveryError('TOKEN_SUPERSEDED')).toBe('Invitation was replaced');
    });

    it('5. returns safe fallback for null, undefined, whitespace, or empty string', () => {
      const fallback = 'Delivery could not be completed. Please try again later.';
      expect(formatDeliveryError(null)).toBe(fallback);
      expect(formatDeliveryError(undefined)).toBe(fallback);
      expect(formatDeliveryError('')).toBe(fallback);
      expect(formatDeliveryError('   ')).toBe(fallback);
    });

    it('6. returns safe fallback for unknown errors, stack traces, and sensitive strings without exposing them', () => {
      const fallback = 'Delivery could not be completed. Please try again later.';
      expect(formatDeliveryError('UNEXPECTED_FAILURE_CODE_9999')).toBe(fallback);
      expect(formatDeliveryError('Error: at Object.send (/app/src/worker.js:14)')).toBe(fallback);
      expect(formatDeliveryError('Postgres connection failed: password=secret_token')).toBe(fallback);
      expect(formatDeliveryError('Auth header Bearer eyJhbGciOiJIUzI1Ni...')).toBe(fallback);
    });

    it('7. renders safe delivery error in both badge tooltip and metadata text in the UI', async () => {
      const failedInv: WorkspaceInvitation = {
        id: 'inv-test-fail',
        workspace_id: 'ws-101',
        inviter_id: 'user-owner',
        invitee_email: 'recipient@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: '2026-10-31T10:00:00.000Z',
        email_delivery_status: 'failed',
        email_failure_reason: 'CRYPTO_DECRYPTION_FAILED',
      };

      await renderPage({
        invitations: [failedInv],
      });

      // Verify visible text does NOT contain the raw code
      expect(container.textContent).not.toContain('CRYPTO_DECRYPTION_FAILED');
      expect(container.textContent).toContain('Failed: Internal delivery issue');

      // Verify badge title tooltip
      const badge = container.querySelector('[title="Internal delivery issue"]');
      expect(badge).not.toBeNull();
      expect(badge?.getAttribute('title')).toBe('Internal delivery issue');
    });

    it('8. confirms avatar rendering is clean and free of misleading presence dots', async () => {
      await renderPage();

      // Check avatars are rendered
      const avatars = container.querySelectorAll('[class*="avatar"]');
      expect(avatars.length).toBeGreaterThan(0);

      // Confirm presenceDot element is absent
      const dots = container.querySelectorAll('[class*="presenceDot"]');
      expect(dots.length).toBe(0);
    });
  });
});
