// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError, PublicInvitationDetails, AcceptInvitationResponse } from '../lib/api';
import { AuthContext } from '../contexts/AuthContext';
import { WorkspaceContext } from '../contexts/WorkspaceContext';
import InvitationAcceptancePage from '../app/invitations/[token]/page';
import { getSafeReturnUrl } from '../lib/safeRedirect';

// Configure act environment for React 18
// @ts-expect-error global IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockPush = vi.fn();
const mockReplace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
  useSearchParams: () => new URLSearchParams(),
}));

describe('Task 4: Workspace Invitation Acceptance Flow & Security Tests', () => {
  let container: HTMLDivElement;
  let root: Root;

  const mockUser = {
    id: 'user-789',
    email: 'invited.user@example.com',
    displayName: 'Invited User',
  };

  const mockShareableInvitation: PublicInvitationDetails = {
    workspaceName: 'Engineering Workspace',
    inviterName: 'Lead Engineer',
    role: 'editor',
    expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    isEmailBound: false,
    maskedEmail: null,
  };

  const mockEmailBoundInvitation: PublicInvitationDetails = {
    workspaceName: 'Security Workspace',
    inviterName: 'SecOps Lead',
    role: 'admin',
    expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    isEmailBound: true,
    maskedEmail: 'i***r@example.com',
  };

  const mockRefreshWorkspaces = vi.fn().mockResolvedValue([]);

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderPage(
    token: string,
    currentUser: typeof mockUser | null = mockUser,
    authLoading = false,
  ) {
    const authContextValue = {
      user: currentUser,
      loading: authLoading,
      isNetworkError: false,
      error: null,
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
      logoutAll: vi.fn(),
      clearError: vi.fn(),
    };

    const workspaceContextValue = {
      workspaces: [],
      activeWorkspace: null,
      userRole: null,
      loading: false,
      error: null,
      refreshWorkspaces: mockRefreshWorkspaces,
      loadWorkspace: vi.fn(),
      createWorkspace: vi.fn(),
    };

    return act(async () => {
      root.render(
        React.createElement(
          AuthContext.Provider,
          { value: authContextValue as any },
          React.createElement(
            WorkspaceContext.Provider,
            { value: workspaceContextValue as any },
            React.createElement(InvitationAcceptancePage, { params: { token } }),
          ),
        ),
      );
    });
  }

  // =========================================================================
  // 1. Safe Return URL & Open Redirect Prevention
  // =========================================================================
  describe('Safe Return URL Validation (getSafeReturnUrl)', () => {
    it('accepts valid internal paths', () => {
      expect(getSafeReturnUrl('/invitations/raw_secret_token_123')).toBe(
        '/invitations/raw_secret_token_123',
      );
      expect(getSafeReturnUrl('/workspaces/ws-456')).toBe('/workspaces/ws-456');
      expect(getSafeReturnUrl('/workspaces/ws-456?view=members')).toBe(
        '/workspaces/ws-456?view=members',
      );
    });

    it('rejects protocol-relative open redirects', () => {
      expect(getSafeReturnUrl('//evil.com')).toBeNull();
      expect(getSafeReturnUrl('//evil.com/phish')).toBeNull();
      expect(getSafeReturnUrl('/\\evil.com')).toBeNull();
      expect(getSafeReturnUrl('/\\\\evil.com')).toBeNull();
    });

    it('rejects external URLs and pseudo-protocols', () => {
      expect(getSafeReturnUrl('https://evil.com')).toBeNull();
      expect(getSafeReturnUrl('http://evil.com')).toBeNull();
      expect(getSafeReturnUrl('javascript:alert(1)')).toBeNull();
      expect(getSafeReturnUrl('/javascript:alert(1)')).toBeNull();
      expect(getSafeReturnUrl('data:text/html,evil')).toBeNull();
      expect(getSafeReturnUrl('/http://evil.com')).toBeNull();
    });

    it('rejects paths with backslashes or path traversal attempts', () => {
      expect(getSafeReturnUrl('/invitations\\evil')).toBeNull();
      expect(getSafeReturnUrl('/../evil')).toBeNull();
      expect(getSafeReturnUrl('/invitations/../admin')).toBeNull();
    });

    it('rejects control characters and empty or non-string values', () => {
      expect(getSafeReturnUrl('')).toBeNull();
      expect(getSafeReturnUrl('   ')).toBeNull();
      expect(getSafeReturnUrl(null)).toBeNull();
      expect(getSafeReturnUrl(undefined)).toBeNull();
      expect(getSafeReturnUrl('/invitations\n/test')).toBeNull();
      expect(getSafeReturnUrl('/invitations\r/test')).toBeNull();
    });
  });

  // =========================================================================
  // 2. Invitation Resolution States
  // =========================================================================
  describe('Invitation Resolution States', () => {
    it('displays loading skeleton while resolving', async () => {
      // Never-resolving promise to inspect in-flight state
      vi.spyOn(api, 'resolveInvitation').mockImplementation(
        () => new Promise(() => {}),
      );

      await renderPage('tok_resolving');

      expect(container.textContent).toContain('Verifying workspace invitation...');
      expect(container.querySelector('.kp-spinner')).not.toBeNull();
    });

    it('displays valid shareable invitation details', async () => {
      vi.spyOn(api, 'resolveInvitation').mockResolvedValue({
        invitation: mockShareableInvitation,
      });

      await renderPage('tok_shareable_valid');

      expect(container.textContent).toContain('Join Engineering Workspace');
      expect(container.textContent).toContain('Lead Engineer has invited you to collaborate');
      expect(container.textContent).toContain('editor');
      expect(container.textContent).toContain('Editor access allows creating, modifying, organizing');
      expect(container.textContent).toContain('Signed in as');
      expect(container.textContent).toContain('invited.user@example.com');
      expect(container.textContent).not.toContain('Email-Bound Invitation');

      const acceptBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Accept Invitation'),
      );
      expect(acceptBtn).toBeDefined();
      expect(acceptBtn?.disabled).toBe(false);
    });

    it('displays warning notice for email-bound invitations and explains verification boundary', async () => {
      vi.spyOn(api, 'resolveInvitation').mockResolvedValue({
        invitation: mockEmailBoundInvitation,
      });

      await renderPage('tok_email_bound');

      expect(container.textContent).toContain('Join Security Workspace');
      expect(container.textContent).toContain('admin');
      expect(container.textContent).toContain('Email-Bound Invitation');
      expect(container.textContent).toContain('i***r@example.com');
      expect(container.textContent).toContain(
        'Authoritative email verification is not currently established in this environment, so accepting email-bound invitations is strictly blocked by security policy',
      );
    });

    it('handles 404 INVITATION_NOT_FOUND safely', async () => {
      vi.spyOn(api, 'resolveInvitation').mockRejectedValue(
        new ApiError('Invalid invitation link', 404, { code: 'INVITATION_NOT_FOUND' }),
      );

      await renderPage('tok_unknown_404');

      expect(container.textContent).toContain('Invalid Invitation Link');
      expect(container.textContent).toContain('does not exist, has expired, or may have been mistyped');
      expect(container.textContent).not.toContain('Accept Invitation');

      const actionBtn = container.querySelector('button');
      expect(actionBtn?.textContent).toContain('Go to Workspaces');
    });

    it('handles 410 INVITATION_EXPIRED safely', async () => {
      vi.spyOn(api, 'resolveInvitation').mockRejectedValue(
        new ApiError('This invitation has expired', 410, { code: 'INVITATION_EXPIRED' }),
      );

      await renderPage('tok_expired_410');

      expect(container.textContent).toContain('Invitation Expired');
      expect(container.textContent).toContain('invitations expire after 7 days');
      expect(container.textContent).not.toContain('Accept Invitation');
    });

    it('handles 410 INVITATION_REVOKED safely', async () => {
      vi.spyOn(api, 'resolveInvitation').mockRejectedValue(
        new ApiError('This invitation has been revoked', 410, { code: 'INVITATION_REVOKED' }),
      );

      await renderPage('tok_revoked_410');

      expect(container.textContent).toContain('Invitation Revoked');
      expect(container.textContent).toContain('revoked by a workspace administrator');
      expect(container.textContent).not.toContain('Accept Invitation');
    });

    it('handles 409 INVITATION_ALREADY_ACCEPTED safely', async () => {
      vi.spyOn(api, 'resolveInvitation').mockRejectedValue(
        new ApiError('This invitation has already been accepted', 409, {
          code: 'INVITATION_ALREADY_ACCEPTED',
        }),
      );

      await renderPage('tok_consumed_409');

      expect(container.textContent).toContain('Invitation Already Accepted');
      expect(container.textContent).toContain('already been accepted and cannot be used again');
      expect(container.textContent).not.toContain('Accept Invitation');
    });

    it('handles 429 RATE_LIMIT_EXCEEDED with retry option', async () => {
      vi.spyOn(api, 'resolveInvitation').mockRejectedValue(
        new ApiError('Rate limit exceeded', 429, { code: 'RATE_LIMIT_EXCEEDED' }),
      );

      await renderPage('tok_rate_limit');

      expect(container.textContent).toContain('Rate Limit Exceeded');
      expect(container.textContent).toContain('Too many requests have been made');

      const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Try Again'),
      );
      expect(retryBtn).toBeDefined();
    });

    it('handles network or server 500 error with retry option', async () => {
      vi.spyOn(api, 'resolveInvitation').mockRejectedValue(
        new ApiError('Internal server error', 500),
      );

      await renderPage('tok_server_err');

      expect(container.textContent).toContain('Unable to Connect');
      const retryBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Try Again'),
      );
      expect(retryBtn).toBeDefined();
    });

    it('handles empty token with immediate validation error without calling API', async () => {
      const resolveSpy = vi.spyOn(api, 'resolveInvitation');

      await renderPage('');

      expect(resolveSpy).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Invalid Invitation Link');
      expect(container.textContent).toContain('No invitation token was provided');
    });
  });

  // =========================================================================
  // 3. Unauthenticated Visitor Flow
  // =========================================================================
  describe('Unauthenticated Visitor Flow', () => {
    it('prompts unauthenticated visitor to sign in with safe returnUrl', async () => {
      vi.spyOn(api, 'resolveInvitation').mockResolvedValue({
        invitation: mockShareableInvitation,
      });

      // Render with user = null (unauthenticated)
      await renderPage('tok_unauth_visitor', null, false);

      expect(container.textContent).toContain('Join Engineering Workspace');
      expect(container.textContent).toContain('You must be signed in to accept this invitation');
      expect(container.textContent).not.toContain('Signed in as');

      // Does not offer a direct accept button
      const acceptBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.trim() === 'Accept Invitation',
      );
      expect(acceptBtn).toBeUndefined();

      const signInBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Sign In to Accept'),
      );
      expect(signInBtn).toBeDefined();

      // Click sign in button
      act(() => {
        signInBtn?.click();
      });

      expect(mockPush).toHaveBeenCalledWith(
        '/login?returnUrl=%2Finvitations%2Ftok_unauth_visitor',
      );

      // Verify register link is present
      const registerLink = container.querySelector('a[href*="/register"]');
      expect(registerLink).not.toBeNull();
      expect(registerLink?.getAttribute('href')).toBe(
        '/register?returnUrl=%2Finvitations%2Ftok_unauth_visitor',
      );
    });
  });

  // =========================================================================
  // 4. Acceptance Flow & Error Handling
  // =========================================================================
  describe('Explicit User Acceptance Flow', () => {
    it('accepts invitation on explicit button click, refreshes workspaces, and navigates', async () => {
      vi.spyOn(api, 'resolveInvitation').mockResolvedValue({
        invitation: mockShareableInvitation,
      });

      const acceptSpy = vi.spyOn(api, 'acceptWorkspaceInvitation').mockResolvedValue({
        status: 'accepted',
        workspaceId: 'ws-target-123',
        role: 'editor',
      });

      await renderPage('tok_accept_flow');

      const acceptBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Accept Invitation'),
      );
      expect(acceptBtn).toBeDefined();

      // Trigger explicit accept
      await act(async () => {
        acceptBtn?.click();
      });

      expect(acceptSpy).toHaveBeenCalledWith('tok_accept_flow');
      expect(mockRefreshWorkspaces).toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledWith('/workspaces/ws-target-123');
      expect(container.textContent).toContain('Invitation Accepted!');
      expect(container.textContent).toContain('You have joined Engineering Workspace as a editor');
    });

    it('handles idempotent already_member response cleanly', async () => {
      vi.spyOn(api, 'resolveInvitation').mockResolvedValue({
        invitation: mockShareableInvitation,
      });

      vi.spyOn(api, 'acceptWorkspaceInvitation').mockResolvedValue({
        status: 'already_member',
        workspaceId: 'ws-existing-456',
        role: 'editor',
      });

      await renderPage('tok_already_member');

      const acceptBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Accept Invitation'),
      );

      await act(async () => {
        acceptBtn?.click();
      });

      expect(mockPush).toHaveBeenCalledWith('/workspaces/ws-existing-456');
      expect(container.textContent).toContain('Already a Member');
      expect(container.textContent).toContain('You already have access to Engineering Workspace as a editor');
    });

    it('prevents duplicate submissions while accept request is in-flight', async () => {
      vi.spyOn(api, 'resolveInvitation').mockResolvedValue({
        invitation: mockShareableInvitation,
      });

      let resolveAcceptPromise: (value: AcceptInvitationResponse) => void;
      const acceptPromise = new Promise<AcceptInvitationResponse>((res) => {
        resolveAcceptPromise = res;
      });

      const acceptSpy = vi
        .spyOn(api, 'acceptWorkspaceInvitation')
        .mockImplementation(() => acceptPromise);

      await renderPage('tok_duplicate_prevent');

      const acceptBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Accept Invitation'),
      );

      // First click
      act(() => {
        acceptBtn?.click();
      });

      expect(acceptSpy).toHaveBeenCalledTimes(1);
      expect(acceptBtn?.disabled).toBe(true);

      // Repeated click while loading should be ignored
      act(() => {
        acceptBtn?.click();
      });

      expect(acceptSpy).toHaveBeenCalledTimes(1);

      // Resolve the request
      await act(async () => {
        resolveAcceptPromise!({
          status: 'accepted',
          workspaceId: 'ws-1',
          role: 'editor',
        });
      });
    });

    it('handles 403 EMAIL_NOT_VERIFIED during email-bound acceptance', async () => {
      vi.spyOn(api, 'resolveInvitation').mockResolvedValue({
        invitation: mockEmailBoundInvitation,
      });

      vi.spyOn(api, 'acceptWorkspaceInvitation').mockRejectedValue(
        new ApiError(
          'Account email must be verified to accept an email-bound invitation',
          403,
          { code: 'EMAIL_NOT_VERIFIED' },
        ),
      );

      await renderPage('tok_email_bound_fail');

      const acceptBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Accept Invitation'),
      );

      await act(async () => {
        acceptBtn?.click();
      });

      expect(mockPush).not.toHaveBeenCalled();
      expect(container.textContent).toContain(
        'Account email must be verified to accept an email-bound invitation. Authoritative email verification is not supported in this environment.',
      );
    });

    it('handles 403 EMAIL_MISMATCH during acceptance', async () => {
      vi.spyOn(api, 'resolveInvitation').mockResolvedValue({
        invitation: mockEmailBoundInvitation,
      });

      vi.spyOn(api, 'acceptWorkspaceInvitation').mockRejectedValue(
        new ApiError('This invitation is intended for a different email address', 403, {
          code: 'EMAIL_MISMATCH',
        }),
      );

      await renderPage('tok_email_mismatch');

      const acceptBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Accept Invitation'),
      );

      await act(async () => {
        acceptBtn?.click();
      });

      expect(mockPush).not.toHaveBeenCalled();
      expect(container.textContent).toContain(
        'This invitation is intended for a different email address (i***r@example.com). You are currently signed in as invited.user@example.com.',
      );
    });

    it('handles 410 expired/revoked during acceptance without navigating', async () => {
      vi.spyOn(api, 'resolveInvitation').mockResolvedValue({
        invitation: mockShareableInvitation,
      });

      vi.spyOn(api, 'acceptWorkspaceInvitation').mockRejectedValue(
        new ApiError('This invitation has expired', 410, { code: 'INVITATION_EXPIRED' }),
      );

      await renderPage('tok_expired_on_accept');

      const acceptBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Accept Invitation'),
      );

      await act(async () => {
        acceptBtn?.click();
      });

      expect(mockPush).not.toHaveBeenCalled();
      expect(container.textContent).toContain('This invitation has expired or was revoked.');
    });

    it('handles 429 rate limit during acceptance', async () => {
      vi.spyOn(api, 'resolveInvitation').mockResolvedValue({
        invitation: mockShareableInvitation,
      });

      vi.spyOn(api, 'acceptWorkspaceInvitation').mockRejectedValue(
        new ApiError('Rate limit exceeded', 429, { code: 'RATE_LIMIT_EXCEEDED' }),
      );

      await renderPage('tok_rate_limited_accept');

      const acceptBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Accept Invitation'),
      );

      await act(async () => {
        acceptBtn?.click();
      });

      expect(mockPush).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Rate limit exceeded. Please wait a moment');
    });
  });

  // =========================================================================
  // 5. Security & Token Confidentiality
  // =========================================================================
  describe('Security & Token Confidentiality', () => {
    it('never stores raw tokens in localStorage or sessionStorage', async () => {
      const sensitiveToken = 'super_secret_raw_token_xyz_987654321';

      vi.spyOn(api, 'resolveInvitation').mockResolvedValue({
        invitation: mockShareableInvitation,
      });

      vi.spyOn(api, 'acceptWorkspaceInvitation').mockResolvedValue({
        status: 'accepted',
        workspaceId: 'ws-safe-1',
        role: 'editor',
      });

      await renderPage(sensitiveToken);

      const acceptBtn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Accept Invitation'),
      );

      await act(async () => {
        acceptBtn?.click();
      });

      // Assert token was NEVER persisted in client storage
      expect(localStorage.getItem('token')).toBeNull();
      expect(localStorage.getItem('invitation_token')).toBeNull();
      expect(sessionStorage.getItem('token')).toBeNull();
      expect(sessionStorage.getItem('invitation_token')).toBeNull();
      expect(Object.values(localStorage)).not.toContain(sensitiveToken);
      expect(Object.values(sessionStorage)).not.toContain(sensitiveToken);
    });

    it('does not display raw token or token hashes in resolution or error UI', async () => {
      const secretToken = 'confidential_token_12345';

      vi.spyOn(api, 'resolveInvitation').mockRejectedValue(
        new ApiError('Invalid invitation link', 404, { code: 'INVITATION_NOT_FOUND' }),
      );

      await renderPage(secretToken);

      expect(container.textContent).not.toContain(secretToken);
      expect(container.innerHTML).not.toContain(secretToken);
    });

    it('aborts previous resolution request on token change to prevent race conditions', async () => {
      let aborted = false;

      vi.spyOn(api, 'resolveInvitation').mockImplementation((_token, options) => {
        options?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise(() => {});
      });

      await renderPage('tok_initial');

      // Change token by re-rendering
      await renderPage('tok_second');

      expect(aborted).toBe(true);
    });
  });
});
