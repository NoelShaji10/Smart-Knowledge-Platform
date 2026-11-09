// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError } from '../lib/api';
import { AuthContext, AuthProvider } from '../contexts/AuthContext';
import { WorkspaceContext } from '../contexts/WorkspaceContext';
import AuthLayout from '../app/(auth)/layout';
import LoginPage from '../app/(auth)/login/page';
import RegisterPage from '../app/(auth)/register/page';
import VerifyEmailPage from '../app/(auth)/verify-email/page';
import NewWorkspacePage from '../app/(app)/workspaces/new/page';

// Configure act environment for React 18
// @ts-expect-error global IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mockPush = vi.fn();
const mockReplace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
  useSearchParams: () => mockSearchParams,
  usePathname: () => '/login',
}));

const el = React.createElement as any;

function setInputValue(input: HTMLInputElement, value: string) {
  act(() => {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    nativeInputValueSetter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('Phase 6: Authentication & Onboarding UI Redesign Test Suite', () => {
  let container: HTMLDivElement;
  let root: Root;

  const mockLogin = vi.fn();
  const mockRegister = vi.fn();
  const mockRefreshUser = vi.fn();
  const mockRefreshWorkspaces = vi.fn();
  const mockCreateWorkspace = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  const renderWithProviders = async (
    ui: React.ReactElement,
    authOverrides = {},
    workspaceOverrides = {},
  ) => {
    const authValue: any = {
      user: null,
      loading: false,
      isNetworkError: false,
      error: null,
      login: mockLogin,
      register: mockRegister,
      logout: vi.fn(),
      logoutAll: vi.fn(),
      refreshUser: mockRefreshUser,
      clearError: vi.fn(),
      ...authOverrides,
    };

    const workspaceValue: any = {
      workspaces: [],
      currentWorkspace: null,
      loading: false,
      refreshWorkspaces: mockRefreshWorkspaces,
      createWorkspace: mockCreateWorkspace,
      switchWorkspace: vi.fn(),
      ...workspaceOverrides,
    };

    await act(async () => {
      root.render(
        el(
          AuthContext.Provider,
          { value: authValue },
          el(WorkspaceContext.Provider, { value: workspaceValue }, ui),
        ),
      );
    });
  };

  describe('1. AuthLayout & Split-Screen Shell', () => {
    it('renders the left collaborative mesh canvas with branding, editorial heading, and preview cards', async () => {
      await renderWithProviders(
        el(AuthLayout, null, el('div', { id: 'test-child' }, 'Login Form Here')),
      );

      // Verify left canvas exists
      const leftSection = container.querySelector('section[aria-label="Knowledge Platform Overview"]');
      expect(leftSection).not.toBeNull();

      // Brand title and kicker
      expect(container.textContent).toContain('Knowledge Platform');
      expect(container.textContent).toContain('Collaborative Mesh');

      // Editorial headline and narrative
      expect(container.textContent).toContain("Your team's knowledge, connected.");
      expect(container.textContent).toContain(
        'A collaborative workspace to create, organize, and share knowledge with your team.',
      );

      // Knowledge cards
      expect(container.textContent).toContain('Engineering Architecture RFC');
      expect(container.textContent).toContain('Product Specifications & Guidelines');
      expect(container.textContent).toContain('Team Onboarding & Runbooks');
      expect(container.textContent).toContain('Built for real-time collaboration');

      // Child inside right section
      expect(container.querySelector('#test-child')).not.toBeNull();
      expect(container.textContent).toContain('Need assistance?');
      expect(container.textContent).toContain('Contact workspace admin');
    });
  });

  describe('2. Login Page UI & Functionality', () => {
    it('renders the login form with email, password, visibility toggle, and submit button', async () => {
      await renderWithProviders(el(LoginPage));

      expect(container.textContent).toContain('Welcome back');
      expect(container.textContent).toContain(
        'Enter your credentials to access your workspaces and team documents.',
      );

      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
      const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      expect(emailInput).not.toBeNull();
      expect(passwordInput).not.toBeNull();
      expect(submitBtn).not.toBeNull();
      expect(submitBtn.textContent).toContain('Sign In');

      // Register link
      const registerLink = container.querySelector('a[href="/register"]');
      expect(registerLink).not.toBeNull();
    });

    it('toggles password visibility between password and text', async () => {
      await renderWithProviders(el(LoginPage));

      const passwordInput = container.querySelector('input[autocomplete="current-password"]') as HTMLInputElement;
      expect(passwordInput.type).toBe('password');

      const toggleBtn = container.querySelector('button[aria-label="Show password"]') as HTMLButtonElement;
      expect(toggleBtn).not.toBeNull();

      await act(async () => {
        toggleBtn.click();
      });

      expect(passwordInput.type).toBe('text');
      expect(toggleBtn.getAttribute('aria-label')).toBe('Hide password');

      await act(async () => {
        toggleBtn.click();
      });

      expect(passwordInput.type).toBe('password');
      expect(toggleBtn.getAttribute('aria-label')).toBe('Show password');
    });

    it('validates required fields before submitting', async () => {
      await renderWithProviders(el(LoginPage));

      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      await act(async () => {
        submitBtn.click();
      });

      expect(mockLogin).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Email is required');
    });

    it('validates invalid email format', async () => {
      await renderWithProviders(el(LoginPage));

      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      setInputValue(emailInput, 'notanemail');

      await act(async () => {
        submitBtn.click();
      });

      expect(mockLogin).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Please enter a valid email address');
    });

    it('handles 401 invalid credentials error from API', async () => {
      mockLogin.mockRejectedValueOnce(new ApiError('Invalid email or password', 401));

      await renderWithProviders(el(LoginPage));

      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
      const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      setInputValue(emailInput, 'user@example.com');
      setInputValue(passwordInput, 'secret123');

      await act(async () => {
        submitBtn.click();
      });

      expect(mockLogin).toHaveBeenCalledWith('user@example.com', 'secret123');
      expect(container.textContent).toContain('Invalid email or password');
    });

    it('handles 429 rate limit error gracefully', async () => {
      mockLogin.mockRejectedValueOnce(new ApiError('Rate limit exceeded', 429));

      await renderWithProviders(el(LoginPage));

      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
      const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      setInputValue(emailInput, 'user@example.com');
      setInputValue(passwordInput, 'secret123');

      await act(async () => {
        submitBtn.click();
      });

      expect(container.textContent).toContain('Too many attempts. Please try again later.');
    });

    it('preserves returnUrl in registration link and redirects to safeReturnUrl on successful login', async () => {
      mockSearchParams = new URLSearchParams({ returnUrl: '/invitations/tok_safe_destination' });
      mockLogin.mockResolvedValueOnce({ id: 'u1', email: 'user@example.com', displayName: 'User' });

      await renderWithProviders(el(LoginPage));

      const registerLink = container.querySelector('a[href*="/register"]');
      expect(registerLink?.getAttribute('href')).toBe(
        '/register?returnUrl=%2Finvitations%2Ftok_safe_destination',
      );

      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
      const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      setInputValue(emailInput, 'user@example.com');
      setInputValue(passwordInput, 'secret123');

      await act(async () => {
        submitBtn.click();
      });

      expect(mockReplace).toHaveBeenCalledWith('/invitations/tok_safe_destination');
    });

    it('redirects to workspace if available when no returnUrl provided', async () => {
      mockLogin.mockResolvedValueOnce({ id: 'u1', email: 'user@example.com', displayName: 'User' });
      mockRefreshWorkspaces.mockResolvedValueOnce([{ id: 'ws-777', name: 'Alpha Corp' }]);

      await renderWithProviders(el(LoginPage));

      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
      const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      setInputValue(emailInput, 'user@example.com');
      setInputValue(passwordInput, 'secret123');

      await act(async () => {
        submitBtn.click();
      });

      expect(mockReplace).toHaveBeenCalledWith('/workspaces/ws-777');
    });

    it('redirects to /workspaces/new if user has 0 workspaces', async () => {
      mockLogin.mockResolvedValueOnce({ id: 'u1', email: 'user@example.com', displayName: 'User' });
      mockRefreshWorkspaces.mockResolvedValueOnce([]);

      await renderWithProviders(el(LoginPage));

      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
      const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      setInputValue(emailInput, 'user@example.com');
      setInputValue(passwordInput, 'secret123');

      await act(async () => {
        submitBtn.click();
      });

      expect(mockReplace).toHaveBeenCalledWith('/workspaces/new');
    });
  });

  describe('3. Registration Page UI & Functionality', () => {
    it('renders the registration form with display name, email, password, and requirement badge', async () => {
      await renderWithProviders(el(RegisterPage));

      expect(container.textContent).toContain('Create your account');
      expect(container.textContent).toContain('Start collaborating with your team in real time.');

      const nameInput = container.querySelector('input[placeholder="Jane Doe"]') as HTMLInputElement;
      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
      const passwordInput = container.querySelector('input[type="password"]') as HTMLInputElement;
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      expect(nameInput).not.toBeNull();
      expect(emailInput).not.toBeNull();
      expect(passwordInput).not.toBeNull();
      expect(submitBtn.textContent).toContain('Create Account');

      // Password requirement text
      expect(container.textContent).toContain('At least 8 characters');
    });

    it('dynamically marks password requirement as met when length >= 8', async () => {
      await renderWithProviders(el(RegisterPage));

      const passwordInput = container.querySelector('input[autocomplete="new-password"]') as HTMLInputElement;

      setInputValue(passwordInput, 'pass');
      expect(container.textContent).not.toContain('✓');

      setInputValue(passwordInput, 'password123');
      expect(container.textContent).toContain('✓ At least 8 characters');
    });

    it('validates short password (< 8 chars)', async () => {
      await renderWithProviders(el(RegisterPage));

      const nameInput = container.querySelector('input[placeholder="Jane Doe"]') as HTMLInputElement;
      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
      const passwordInput = container.querySelector('input[autocomplete="new-password"]') as HTMLInputElement;
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      setInputValue(nameInput, 'Alex Chen');
      setInputValue(emailInput, 'alex@company.com');
      setInputValue(passwordInput, 'short');

      await act(async () => {
        submitBtn.click();
      });

      expect(mockRegister).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Password must be at least 8 characters');
    });

    it('submits registration successfully and redirects', async () => {
      mockRegister.mockResolvedValueOnce({ id: 'u2', email: 'alex@company.com', displayName: 'Alex Chen' });
      mockRefreshWorkspaces.mockResolvedValueOnce([{ id: 'ws-alex', name: 'Alex Workspace' }]);

      await renderWithProviders(el(RegisterPage));

      const nameInput = container.querySelector('input[placeholder="Jane Doe"]') as HTMLInputElement;
      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
      const passwordInput = container.querySelector('input[autocomplete="new-password"]') as HTMLInputElement;
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      setInputValue(nameInput, 'Alex Chen');
      setInputValue(emailInput, 'alex@company.com');
      setInputValue(passwordInput, 'longpassword123');

      await act(async () => {
        submitBtn.click();
      });

      expect(mockRegister).toHaveBeenCalledWith(
        'Alex Chen',
        'alex@company.com',
        'longpassword123',
        undefined,
      );
      expect(mockReplace).toHaveBeenCalledWith('/workspaces/ws-alex');
    });

    it('handles registration response with verificationEmailSent: true and redirects to destination', async () => {
      mockRegister.mockResolvedValueOnce({
        user: { id: 'u3', email: 'verified@company.com', displayName: 'Taylor Swift' },
        verificationEmailSent: true,
        message: 'Registration successful. A verification email has been sent to your inbox.',
      });
      mockRefreshWorkspaces.mockResolvedValueOnce([{ id: 'ws-taylor', name: 'Taylor Workspace' }]);

      await renderWithProviders(el(RegisterPage));

      const nameInput = container.querySelector('input[placeholder="Jane Doe"]') as HTMLInputElement;
      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
      const passwordInput = container.querySelector('input[autocomplete="new-password"]') as HTMLInputElement;
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      setInputValue(nameInput, 'Taylor Swift');
      setInputValue(emailInput, 'verified@company.com');
      setInputValue(passwordInput, 'longpassword123');

      await act(async () => {
        submitBtn.click();
      });

      expect(mockRegister).toHaveBeenCalledWith(
        'Taylor Swift',
        'verified@company.com',
        'longpassword123',
        undefined,
      );
      expect(mockReplace).toHaveBeenCalledWith('/workspaces/ws-taylor');
    });

    it('handles registration response with verificationEmailSent: false and still completes registration flow', async () => {
      mockRegister.mockResolvedValueOnce({
        user: { id: 'u4', email: 'unverified@company.com', displayName: 'Jordan Lee' },
        verificationEmailSent: false,
        message: 'Account created, but verification email could not be sent. You can request a new link at /verify-email.',
      });
      mockRefreshWorkspaces.mockResolvedValueOnce([]);

      await renderWithProviders(el(RegisterPage));

      const nameInput = container.querySelector('input[placeholder="Jane Doe"]') as HTMLInputElement;
      const emailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
      const passwordInput = container.querySelector('input[autocomplete="new-password"]') as HTMLInputElement;
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      setInputValue(nameInput, 'Jordan Lee');
      setInputValue(emailInput, 'unverified@company.com');
      setInputValue(passwordInput, 'longpassword123');

      await act(async () => {
        submitBtn.click();
      });

      expect(mockRegister).toHaveBeenCalledWith(
        'Jordan Lee',
        'unverified@company.com',
        'longpassword123',
        undefined,
      );
      expect(mockReplace).toHaveBeenCalledWith('/workspaces/new');
    });
  });

  describe('4. Email Verification Page UI & States', () => {
    it('shows verifying state when a token is present in searchParams', async () => {
      mockSearchParams = new URLSearchParams({ token: 'tok_active_verification' });
      vi.spyOn(api, 'verifyEmail').mockImplementationOnce(() => new Promise(() => {})); // Never resolves to inspect verifying state

      await renderWithProviders(el(VerifyEmailPage));

      expect(container.textContent).toContain('Verifying your email');
      expect(container.textContent).toContain('Please wait while we confirm your cryptographic verification challenge...');
    });

    it('renders success state when verification succeeds', async () => {
      mockSearchParams = new URLSearchParams({ token: 'tok_valid_test' });
      vi.spyOn(api, 'verifyEmail').mockResolvedValueOnce({ success: true, message: 'Email verified' } as any);

      await renderWithProviders(el(VerifyEmailPage));

      expect(container.textContent).toContain('Email Verified!');
      expect(container.textContent).toContain(
        'Your email has been authoritatively verified. You now have full access to workspace collaboration.',
      );

      const actionBtn = container.querySelector('button') as HTMLButtonElement;
      expect(actionBtn).not.toBeNull();
      expect(actionBtn.textContent).toContain('Sign In to Continue');
    });

    it('renders expired token error state with clear explanation and resend form', async () => {
      mockSearchParams = new URLSearchParams({ token: 'tok_expired_link' });
      vi.spyOn(api, 'verifyEmail').mockRejectedValueOnce(
        new ApiError('Link expired', 410, { code: 'VERIFICATION_TOKEN_EXPIRED' }),
      );

      await renderWithProviders(el(VerifyEmailPage));

      expect(container.textContent).toContain(
        'This verification link has expired. Please request a new one below.',
      );
      expect(container.textContent).toContain('Account Email');

      const emailInput = container.querySelector('input[name="email"]') as HTMLInputElement;
      expect(emailInput).not.toBeNull();
    });

    it('renders already-consumed token error state', async () => {
      mockSearchParams = new URLSearchParams({ token: 'tok_already_used' });
      vi.spyOn(api, 'verifyEmail').mockRejectedValueOnce(
        new ApiError('Link consumed', 409, { code: 'VERIFICATION_TOKEN_CONSUMED' }),
      );

      await renderWithProviders(el(VerifyEmailPage));

      expect(container.textContent).toContain('This verification link has already been used.');
    });

    it('handles resending verification email successfully', async () => {
      const mockRequestVerification = vi
        .spyOn(api, 'requestEmailVerification')
        .mockResolvedValueOnce({ success: true, message: 'Sent' } as any);

      await renderWithProviders(el(VerifyEmailPage));

      const emailInput = container.querySelector('input[name="email"]') as HTMLInputElement;
      const sendBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      setInputValue(emailInput, 'resend@company.com');

      await act(async () => {
        sendBtn.click();
      });

      expect(mockRequestVerification).toHaveBeenCalledWith({
        email: 'resend@company.com',
        returnUrl: undefined,
      });
      expect(container.textContent).toContain(
        'If an account exists, a new verification link has been sent to your email.',
      );
    });
  });

  describe('5. Workspace Onboarding (New Workspace)', () => {
    it('renders the workspace onboarding page with brand lockup, title, and form', async () => {
      await renderWithProviders(el(NewWorkspacePage));

      expect(container.textContent).toContain('Knowledge Platform');
      expect(container.textContent).toContain('Workspace Onboarding');
      expect(container.textContent).toContain('Create your workspace');
      expect(container.textContent).toContain(
        'Workspaces are shared hubs for your team\'s real-time documents, knowledge base, and member permissions.',
      );

      const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      expect(nameInput).not.toBeNull();
      expect(submitBtn.textContent).toContain('Create Workspace');
    });

    it('validates workspace name is required and within 100 characters', async () => {
      await renderWithProviders(el(NewWorkspacePage));

      const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      await act(async () => {
        submitBtn.click();
      });

      expect(mockCreateWorkspace).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Workspace name is required');

      setInputValue(nameInput, 'a'.repeat(101));

      await act(async () => {
        submitBtn.click();
      });

      expect(mockCreateWorkspace).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Workspace name must be 100 characters or less');
    });

    it('creates workspace and navigates to the new workspace dashboard', async () => {
      mockCreateWorkspace.mockResolvedValueOnce({ id: 'ws-new-42', name: 'Hyperion Labs' });

      await renderWithProviders(el(NewWorkspacePage));

      const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      setInputValue(nameInput, 'Hyperion Labs');

      await act(async () => {
        submitBtn.click();
      });

      expect(mockCreateWorkspace).toHaveBeenCalledWith('Hyperion Labs');
      expect(mockReplace).toHaveBeenCalledWith('/workspaces/ws-new-42');
    });

    it('renders error alert when createWorkspace API fails', async () => {
      mockCreateWorkspace.mockRejectedValueOnce(
        new ApiError('Failed to create workspace. Database error.', 500),
      );

      await renderWithProviders(el(NewWorkspacePage));

      const nameInput = container.querySelector('input[type="text"]') as HTMLInputElement;
      const submitBtn = container.querySelector('button[type="submit"]') as HTMLButtonElement;

      setInputValue(nameInput, 'Failed Workspace Project');

      await act(async () => {
        submitBtn.click();
      });

      expect(mockCreateWorkspace).toHaveBeenCalledWith('Failed Workspace Project');
      expect(mockReplace).not.toHaveBeenCalled();
      expect(container.textContent).toContain('Failed to create workspace. Database error.');
      expect(nameInput.value).toBe('Failed Workspace Project');
    });
  });

  describe('6. Registration Delivery Feedback & AuthContext', () => {
    it('exposes verificationEmailSent: true and sets registrationNotice in AuthContext', async () => {
      vi.spyOn(api, 'refresh').mockResolvedValueOnce(null as any);
      const mockApiRegister = vi.spyOn(api, 'register').mockResolvedValueOnce({
        user: { id: 'u5', email: 'newuser@example.com', displayName: 'New User' },
        accessToken: 'mock_jwt_token',
        verificationEmailSent: true,
        message: 'Registration successful. A verification email has been sent to your inbox.',
      } as any);

      let contextVal: any = null;
      function TestConsumer() {
        contextVal = React.useContext(AuthContext);
        return el('div', null, contextVal?.user?.displayName || 'no user');
      }

      await act(async () => {
        root.render(el(AuthProvider, null, el(TestConsumer)));
      });

      let regResult: any = null;
      await act(async () => {
        regResult = await contextVal.register('New User', 'newuser@example.com', 'password123');
      });

      expect(regResult).toEqual({
        user: { id: 'u5', email: 'newuser@example.com', displayName: 'New User' },
        verificationEmailSent: true,
        message: 'Registration successful. A verification email has been sent to your inbox.',
      });
      expect(contextVal.registrationNotice).toEqual({
        sent: true,
        message: 'Registration successful. A verification email has been sent to your inbox.',
      });
      expect(contextVal.user).toEqual({
        id: 'u5',
        email: 'newuser@example.com',
        displayName: 'New User',
      });
      mockApiRegister.mockRestore();
    });

    it('exposes verificationEmailSent: false and sets failure registrationNotice in AuthContext', async () => {
      vi.spyOn(api, 'refresh').mockResolvedValueOnce(null as any);
      const mockApiRegister = vi.spyOn(api, 'register').mockResolvedValueOnce({
        user: { id: 'u6', email: 'smtp_fail@example.com', displayName: 'SMTP Fail' },
        accessToken: 'mock_jwt_token_2',
        verificationEmailSent: false,
      } as any);

      let contextVal: any = null;
      function TestConsumer() {
        contextVal = React.useContext(AuthContext);
        return el('div', null, contextVal?.user?.displayName || 'no user');
      }

      await act(async () => {
        root.render(el(AuthProvider, null, el(TestConsumer)));
      });

      let regResult: any = null;
      await act(async () => {
        regResult = await contextVal.register('SMTP Fail', 'smtp_fail@example.com', 'password123');
      });

      expect(regResult.verificationEmailSent).toBe(false);
      expect(contextVal.registrationNotice?.sent).toBe(false);
      expect(contextVal.registrationNotice?.message).toContain(
        'Account created, but verification email could not be sent',
      );
      expect(contextVal.user).toEqual({
        id: 'u6',
        email: 'smtp_fail@example.com',
        displayName: 'SMTP Fail',
      });
      mockApiRegister.mockRestore();
    });
  });
});
