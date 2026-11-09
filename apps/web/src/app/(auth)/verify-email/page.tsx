'use client';

import React, { useState, useEffect, FormEvent, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Button, Input } from '@/components/ui';
import { getSafeReturnUrl } from '@/lib/safeRedirect';
import styles from './page.module.css';

function VerifyEmailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const rawReturnUrl = searchParams.get('returnUrl');
  const safeReturnUrl = getSafeReturnUrl(rawReturnUrl);

  const { user, refreshUser } = useAuth();

  const [verifying, setVerifying] = useState<boolean>(Boolean(token));
  const [success, setSuccess] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Resend form state
  const [resendEmail, setResendEmail] = useState<string>(user?.email || '');
  const [resending, setResending] = useState<boolean>(false);
  const [resendSuccess, setResendSuccess] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || typeof token !== 'string' || token.trim() === '') {
      setVerifying(false);
      return;
    }

    let isMounted = true;

    async function performVerification() {
      setVerifying(true);
      setErrorMessage(null);
      try {
        await api.verifyEmail(token!);
        if (isMounted) {
          setSuccess(true);
          try {
            await refreshUser();
          } catch {
            // Ignore refresh error
          }
        }
      } catch (err: unknown) {
        if (!isMounted) return;
        if (err instanceof ApiError) {
          const data = err.data as { error?: string; code?: string } | undefined;
          if (err.status === 410 || data?.code === 'VERIFICATION_TOKEN_EXPIRED') {
            setErrorMessage('This verification link has expired. Please request a new one below.');
          } else if (err.status === 409 || data?.code === 'VERIFICATION_TOKEN_CONSUMED') {
            setErrorMessage('This verification link has already been used.');
          } else {
            setErrorMessage(data?.error || err.message || 'Invalid verification link.');
          }
        } else {
          setErrorMessage('Unable to verify email due to network error. Please try again.');
        }
      } finally {
        if (isMounted) {
          setVerifying(false);
        }
      }
    }

    performVerification();

    return () => {
      isMounted = false;
    };
  }, [token, refreshUser]);

  const handleResend = async (e: FormEvent) => {
    e.preventDefault();
    if (!resendEmail.trim()) {
      setResendError('Email is required');
      return;
    }

    setResending(true);
    setResendSuccess(null);
    setResendError(null);

    try {
      await api.requestEmailVerification({
        email: resendEmail.trim(),
        returnUrl: safeReturnUrl || undefined,
      });
      setResendSuccess('If an account exists, a new verification link has been sent to your email.');
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 429) {
        setResendError('Too many requests. Please wait a few minutes before trying again.');
      } else {
        setResendError('Failed to send verification email. Please try again.');
      }
    } finally {
      setResending(false);
    }
  };

  const loginHref = safeReturnUrl
    ? `/login?returnUrl=${encodeURIComponent(safeReturnUrl)}`
    : '/login';

  if (verifying) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1 className={styles.heading}>Verifying your email</h1>
          <p className={styles.subtext}>
            Please wait while we confirm your cryptographic verification challenge...
          </p>
        </div>
        <div className={styles.loadingBox} role="status" aria-live="polite">
          <span className="kp-spinner" aria-hidden="true" />
          <span>Verifying cryptographic credentials with the security provider...</span>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className={styles.container}>
        <div className={styles.successHeader}>
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
          <h1 className={styles.heading}>Email Verified!</h1>
          <p className={styles.subtext}>
            Your email has been authoritatively verified. You now have full access to workspace collaboration.
          </p>
        </div>

        <div className={styles.actionRow}>
          {safeReturnUrl ? (
            <Button variant="primary" onClick={() => router.push(safeReturnUrl)} fullWidth>
              <span>Continue to Invitation</span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </Button>
          ) : user ? (
            <Button variant="primary" onClick={() => router.push('/workspaces')} fullWidth>
              <span>Go to Workspaces</span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </Button>
          ) : (
            <Button variant="primary" onClick={() => router.push(loginHref)} fullWidth>
              <span>Sign In to Continue</span>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.heading}>Email Verification</h1>
        <p className={styles.subtext}>
          {errorMessage || 'Verify your email address to unlock workspace collaboration.'}
        </p>
      </header>

      {errorMessage && (
        <div className={styles.errorMessage} role="alert">
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
          <div>{errorMessage}</div>
        </div>
      )}

      {resendSuccess && (
        <div className={styles.successMessage} role="status">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <div>{resendSuccess}</div>
        </div>
      )}

      {resendError && (
        <div className={styles.errorMessage} role="alert">
          <svg
            className={styles.errorIcon}
            width="16"
            height="16"
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
          <div>{resendError}</div>
        </div>
      )}

      <form className={styles.form} onSubmit={handleResend} noValidate>
        <Input
          id="resend-email"
          name="email"
          type="email"
          label="Account Email"
          placeholder="name@company.com"
          value={resendEmail}
          onChange={(e) => setResendEmail(e.target.value)}
          disabled={resending}
          required
          autoComplete="email"
          startIcon={
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="20" height="16" x="2" y="4" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
          }
        />

        <Button variant="primary" type="submit" loading={resending} disabled={resending} fullWidth>
          <span>{resending ? 'Sending link...' : 'Send Verification Link'}</span>
        </Button>
      </form>

      <div className={styles.cardFooter}>
        <p className={styles.footerText}>
          Back to{' '}
          <Link href={loginHref} className={styles.footerLink}>
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <div className={styles.container}>
          <div className={styles.loadingBox}>
            <span className="kp-spinner" aria-hidden="true" />
            <span>Loading...</span>
          </div>
        </div>
      }
    >
      <VerifyEmailContent />
    </Suspense>
  );
}
