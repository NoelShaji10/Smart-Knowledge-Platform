'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, ApiError, PublicInvitationDetails, AcceptInvitationResponse } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { Button } from '@/components/ui';
import styles from './page.module.css';

interface PageProps {
  params: {
    token: string;
  };
}

interface ErrorDetails {
  title: string;
  message: string;
  status?: number;
  code?: string;
  canRetry?: boolean;
}

export default function InvitationAcceptancePage({ params }: PageProps) {
  const router = useRouter();
  const token = params?.token || '';

  const { user, loading: authLoading, refreshUser } = useAuth();
  const { refreshWorkspaces } = useWorkspace();

  const [invitation, setInvitation] = useState<PublicInvitationDetails | null>(null);
  const [resolving, setResolving] = useState<boolean>(true);
  const [resolveError, setResolveError] = useState<ErrorDetails | null>(null);

  const [accepting, setAccepting] = useState<boolean>(false);
  const [acceptSuccess, setAcceptSuccess] = useState<AcceptInvitationResponse | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  const [emailNotVerified, setEmailNotVerified] = useState<boolean>(false);
  const [resendingVerification, setResendingVerification] = useState<boolean>(false);
  const [resendVerificationSuccess, setResendVerificationSuccess] = useState<string | null>(null);
  const [resendVerificationError, setResendVerificationError] = useState<string | null>(null);
  const [checkingVerification, setCheckingVerification] = useState<boolean>(false);

  const abortControllerRef = useRef<AbortController | null>(null);

  const loadInvitation = useCallback(async () => {
    if (!token || typeof token !== 'string' || token.trim() === '') {
      setResolving(false);
      setResolveError({
        title: 'Invalid Invitation Link',
        message: 'No invitation token was provided in the URL.',
        status: 400,
        code: 'VALIDATION_ERROR',
        canRetry: false,
      });
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setResolving(true);
    setResolveError(null);
    setAcceptError(null);

    try {
      const res = await api.resolveInvitation(token, { signal: controller.signal });
      setInvitation(res.invitation);
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError') {
        return;
      }

      if (err instanceof ApiError) {
        const data = err.data as { error?: string; code?: string } | undefined;
        const code = data?.code;

        if (err.status === 404 || code === 'INVITATION_NOT_FOUND') {
          setResolveError({
            title: 'Invalid Invitation Link',
            message: 'This invitation link does not exist, has expired, or may have been mistyped.',
            status: 404,
            code: 'INVITATION_NOT_FOUND',
            canRetry: false,
          });
        } else if (err.status === 410 && code === 'INVITATION_EXPIRED') {
          setResolveError({
            title: 'Invitation Expired',
            message: 'This invitation link has expired. Workspace invitations expire after 7 days for security.',
            status: 410,
            code: 'INVITATION_EXPIRED',
            canRetry: false,
          });
        } else if (err.status === 410 && code === 'INVITATION_REVOKED') {
          setResolveError({
            title: 'Invitation Revoked',
            message: 'This invitation has been revoked by a workspace administrator and can no longer be used.',
            status: 410,
            code: 'INVITATION_REVOKED',
            canRetry: false,
          });
        } else if (err.status === 409 && code === 'INVITATION_ALREADY_ACCEPTED') {
          setResolveError({
            title: 'Invitation Already Accepted',
            message: 'This invitation has already been accepted and cannot be used again.',
            status: 409,
            code: 'INVITATION_ALREADY_ACCEPTED',
            canRetry: false,
          });
        } else if (err.status === 429) {
          setResolveError({
            title: 'Rate Limit Exceeded',
            message: 'Too many requests have been made to inspect invitations. Please wait a moment and try again.',
            status: 429,
            code: 'RATE_LIMIT_EXCEEDED',
            canRetry: true,
          });
        } else if (err.status === 0 || err.status >= 500) {
          setResolveError({
            title: 'Unable to Connect',
            message: 'A network or server error occurred while resolving this invitation. Your link is intact.',
            status: err.status,
            canRetry: true,
          });
        } else {
          setResolveError({
            title: 'Unable to Resolve Invitation',
            message: err.message || 'An unexpected error occurred while loading this invitation.',
            status: err.status,
            canRetry: true,
          });
        }
      } else {
        setResolveError({
          title: 'Unable to Connect',
          message: 'A network error prevented loading this invitation. Please check your connection.',
          canRetry: true,
        });
      }
    } finally {
      setResolving(false);
    }
  }, [token]);

  useEffect(() => {
    loadInvitation();

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [loadInvitation]);

  const handleAccept = async () => {
    if (!token || accepting || !user) return;

    setAccepting(true);
    setAcceptError(null);

    try {
      const result = await api.acceptWorkspaceInvitation(token);
      setAcceptSuccess(result);

      // Refresh workspace context cache so the new workspace appears in the sidebar
      try {
        await refreshWorkspaces();
      } catch {
        // Non-blocking for navigation since backend membership was successfully created
      }

      // Safe navigation using the trusted server-provided workspaceId
      router.push(`/workspaces/${result.workspaceId}`);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        const data = err.data as { error?: string; code?: string } | undefined;
        const code = data?.code;

        if (err.status === 403 && code === 'EMAIL_NOT_VERIFIED') {
          setEmailNotVerified(true);
          setAcceptError(
            'Account email must be verified to accept an email-bound invitation. Authoritative email verification is not supported in this environment.',
          );
        } else if (err.status === 403 && code === 'EMAIL_MISMATCH') {
          setEmailNotVerified(false);
          setAcceptError(
            `This invitation is intended for a different email address (${invitation?.maskedEmail || 'reserved email'}). You are currently signed in as ${user.email}.`,
          );
        } else if (err.status === 409) {
          setEmailNotVerified(false);
          setAcceptError(
            err.message || 'This invitation has already been accepted or you are already a member.',
          );
        } else if (err.status === 410) {
          setEmailNotVerified(false);
          setAcceptError('This invitation has expired or was revoked.');
        } else if (err.status === 429) {
          setAcceptError('Rate limit exceeded. Please wait a moment before trying to accept again.');
        } else if (err.status === 401) {
          setEmailNotVerified(false);
          setAcceptError('Your session has expired. Please sign in again.');
        } else {
          setEmailNotVerified(false);
          setAcceptError(
            err.message || 'Failed to accept invitation due to a server error. Please try again.',
          );
        }
      } else {
        setEmailNotVerified(false);
        setAcceptError('Network error or server unavailable. Please try again.');
      }
    } finally {
      setAccepting(false);
    }
  };

  const handleResendVerification = async () => {
    setResendingVerification(true);
    setResendVerificationSuccess(null);
    setResendVerificationError(null);
    try {
      await api.requestEmailVerification();
      setResendVerificationSuccess(`Verification email sent to ${user?.email || 'your email'}. Please check your inbox.`);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 429) {
        setResendVerificationError('Too many verification requests. Please wait a moment before trying again.');
      } else {
        setResendVerificationError('Failed to send verification email. Please try again.');
      }
    } finally {
      setResendingVerification(false);
    }
  };

  const handleCheckAndRetry = async () => {
    setCheckingVerification(true);
    setResendVerificationError(null);
    try {
      const refreshedUser = await refreshUser();
      if (refreshedUser?.emailVerified) {
        setEmailNotVerified(false);
        setAcceptError(null);
        await handleAccept();
      } else {
        setAcceptError('Your email address is not yet verified. Please click the link sent to your inbox.');
      }
    } catch {
      setAcceptError('Failed to refresh account status. Please try again.');
    } finally {
      setCheckingVerification(false);
    }
  };

  const getRoleBadgeClass = (role: string) => {
    switch (role) {
      case 'admin':
        return styles.roleAdmin;
      case 'editor':
        return styles.roleEditor;
      case 'viewer':
      default:
        return styles.roleViewer;
    }
  };

  const getRoleDescription = (role: string) => {
    switch (role) {
      case 'admin':
        return 'Admin access allows managing members, workspace settings, invitations, and documents.';
      case 'editor':
        return 'Editor access allows creating, modifying, organizing, and collaborating on workspace documents.';
      case 'viewer':
      default:
        return 'Viewer access allows viewing published workspace documents and comments.';
    }
  };

  const returnUrl = `/invitations/${encodeURIComponent(token)}`;
  const loginUrl = `/login?returnUrl=${encodeURIComponent(returnUrl)}`;
  const registerUrl = `/register?returnUrl=${encodeURIComponent(returnUrl)}`;

  return (
    <main id="main-content" className={styles.pageWrapper}>
      <div className={styles.cardContainer}>
        <header className={styles.brandHeader}>
          <div className={styles.logoBadge} aria-hidden="true">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              <path d="M9 7h6" />
              <path d="M9 11h6" />
            </svg>
          </div>
          <span className={styles.wordmark}>Knowledge Platform</span>
        </header>

        <section className={styles.card} aria-labelledby="invitation-card-title">
          {resolving ? (
            <div className={styles.loadingSkeleton} role="status" aria-live="polite">
              <span className="kp-spinner" aria-hidden="true" />
              <span>Verifying workspace invitation...</span>
            </div>
          ) : resolveError ? (
            <div>
              <div
                className={`${styles.stateIconCenter} ${
                  resolveError.status === 429
                    ? styles.stateIconWarning
                    : resolveError.status && resolveError.status >= 500
                    ? styles.stateIconDanger
                    : styles.stateIconNeutral
                }`}
                aria-hidden="true"
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>

              <div className={styles.cardHeader}>
                <h1 id="invitation-card-title" className={styles.cardTitle}>
                  {resolveError.title}
                </h1>
                <p className={styles.cardSubtitle}>{resolveError.message}</p>
              </div>

              <div className={styles.actions}>
                {resolveError.canRetry ? (
                  <Button variant="primary" onClick={loadInvitation} fullWidth>
                    Try Again
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    onClick={() => router.push(user ? '/workspaces' : '/login')}
                    fullWidth
                  >
                    {user ? 'Go to Workspaces' : 'Sign In'}
                  </Button>
                )}
              </div>
            </div>
          ) : acceptSuccess ? (
            <div className={styles.successBox} role="status">
              <div className={styles.successIconBadge} aria-hidden="true">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <h1 id="invitation-card-title" className={styles.successTitle}>
                {acceptSuccess.status === 'already_member'
                  ? 'Already a Member'
                  : 'Invitation Accepted!'}
              </h1>
              <p className={styles.successDescription}>
                {acceptSuccess.status === 'already_member'
                  ? `You already have access to ${invitation?.workspaceName || 'this workspace'} as a ${acceptSuccess.role}.`
                  : `You have joined ${invitation?.workspaceName || 'the workspace'} as a ${acceptSuccess.role}.`}
              </p>
              <div className={styles.actions} style={{ width: '100%', marginTop: 'var(--space-4)' }}>
                <Button
                  variant="primary"
                  onClick={() => router.push(`/workspaces/${acceptSuccess.workspaceId}`)}
                  fullWidth
                >
                  Open Workspace
                </Button>
              </div>
            </div>
          ) : invitation ? (
            <div>
              <div className={styles.cardHeader}>
                <h1 id="invitation-card-title" className={styles.cardTitle}>
                  Join {invitation.workspaceName}
                </h1>
                <p className={styles.cardSubtitle}>
                  {invitation.inviterName} has invited you to collaborate
                </p>
              </div>

              <div className={styles.detailsBox}>
                <div className={styles.workspaceRow}>
                  <div className={styles.workspaceInfo}>
                    <div className={styles.workspaceAvatar} aria-hidden="true">
                      {invitation.workspaceName.charAt(0).toUpperCase()}
                    </div>
                    <div className={styles.workspaceNames}>
                      <span className={styles.workspaceName}>{invitation.workspaceName}</span>
                      <span className={styles.inviterName}>Invited by {invitation.inviterName}</span>
                    </div>
                  </div>
                  <span className={`${styles.rolePill} ${getRoleBadgeClass(invitation.role)}`}>
                    {invitation.role}
                  </span>
                </div>

                <div className={styles.roleDescription}>
                  {getRoleDescription(invitation.role)}
                </div>

                <div className={styles.expiryMeta}>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                  <span>
                    Expires on {new Date(invitation.expiresAt).toLocaleDateString(undefined, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </div>
              </div>

              {invitation.isEmailBound && (
                <div className={styles.warningBox} role="note">
                  <svg
                    className={styles.warningIcon}
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  <div>
                    <strong>Email-Bound Invitation:</strong> This invitation is restricted to{' '}
                    <strong>{invitation.maskedEmail}</strong>. Authoritative email verification is not
                    currently established in this environment, so accepting email-bound invitations is
                    strictly blocked by security policy.
                  </div>
                </div>
              )}

              {authLoading ? (
                <div className={styles.loadingSkeleton} style={{ padding: 'var(--space-4)' }}>
                  <span className="kp-spinner" aria-hidden="true" />
                  <span>Checking authentication...</span>
                </div>
              ) : user ? (
                <>
                  <div className={styles.sessionBanner}>
                    <span>Signed in as</span>
                    <span className={styles.sessionEmail}>{user.email}</span>
                  </div>

                  {acceptError && (
                    <div className={styles.errorBox} role="alert">
                      <svg
                        className={styles.errorIcon}
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                      <div>{acceptError}</div>
                    </div>
                  )}

                  {emailNotVerified && (
                    <div className={styles.verificationPromptBox} role="region" aria-label="Email Verification Required">
                      {resendVerificationSuccess && (
                        <div className={styles.successNote} role="status">
                          {resendVerificationSuccess}
                        </div>
                      )}
                      {resendVerificationError && (
                        <div className={styles.errorNote} role="alert">
                          {resendVerificationError}
                        </div>
                      )}
                      <div className={styles.verificationActions}>
                        <Button
                          variant="secondary"
                          onClick={handleResendVerification}
                          loading={resendingVerification}
                          disabled={resendingVerification || checkingVerification}
                        >
                          Resend Verification Email
                        </Button>
                        <Button
                          variant="primary"
                          onClick={handleCheckAndRetry}
                          loading={checkingVerification}
                          disabled={checkingVerification || resendingVerification}
                        >
                          I've Verified, Retry
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className={styles.actions}>
                    <Button
                      variant="primary"
                      onClick={handleAccept}
                      loading={accepting}
                      disabled={accepting}
                      fullWidth
                    >
                      Accept Invitation
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.infoBox} role="note">
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ flexShrink: 0, marginTop: '2px' }}
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="16" x2="12" y2="12" />
                      <line x1="12" y1="8" x2="12.01" y2="8" />
                    </svg>
                    <div>
                      You must be signed in to accept this invitation. Sign in with your existing account or
                      create a new one to join.
                    </div>
                  </div>

                  <div className={styles.actions}>
                    <Button variant="primary" onClick={() => router.push(loginUrl)} fullWidth>
                      Sign In to Accept
                    </Button>
                  </div>

                  <div className={styles.footerActions}>
                    <span>Need an account?</span>
                    <Link href={registerUrl} className={styles.footerLink}>
                      Create an account
                    </Link>
                  </div>
                </>
              )}
            </div>
          ) : null}
        </section>

        <footer className={styles.footerNote}>
          Smart Knowledge Platform &bull; End-to-end encrypted collaboration
        </footer>
      </div>
    </main>
  );
}
