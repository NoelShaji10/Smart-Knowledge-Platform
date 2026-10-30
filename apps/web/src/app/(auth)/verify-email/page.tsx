'use client';

import React, { useState, useEffect, FormEvent, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { Button, Input } from '@/components/ui';
import styles from './page.module.css';

function VerifyEmailContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

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
            setErrorMessage('This verification link has expired. Please request a new one.');
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
      await api.requestEmailVerification({ email: resendEmail.trim() });
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

  if (verifying) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1 className={styles.heading}>Verifying your email</h1>
          <p className={styles.subtext}>Please wait while we confirm your account...</p>
        </div>
        <div className={styles.loadingBox}>
          <span className="kp-spinner" aria-hidden="true" />
          <span>Confirming cryptographic verification challenge...</span>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <div className={styles.successIconBadge} aria-hidden="true">
            <svg
              width="32"
              height="32"
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
          {user ? (
            <Button variant="primary" onClick={() => router.push('/workspaces')} fullWidth>
              Go to Workspaces
            </Button>
          ) : (
            <Button variant="primary" onClick={() => router.push('/login')} fullWidth>
              Sign In to Continue
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.heading}>Email Verification</h1>
        <p className={styles.subtext}>
          {errorMessage || 'Verify your email address to unlock workspace collaboration.'}
        </p>
      </div>

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
          {resendSuccess}
        </div>
      )}

      {resendError && (
        <div className={styles.errorMessage} role="alert">
          {resendError}
        </div>
      )}

      <form className={styles.form} onSubmit={handleResend}>
        <Input
          id="resend-email"
          name="email"
          type="email"
          label="Account Email"
          placeholder="name@example.com"
          value={resendEmail}
          onChange={(e) => setResendEmail(e.target.value)}
          disabled={resending}
          required
        />

        <Button variant="primary" type="submit" loading={resending} disabled={resending} fullWidth>
          Send Verification Link
        </Button>
      </form>

      <div className={styles.footerText}>
        <span>Back to </span>
        <Link href="/login" className={styles.footerLink}>
          Sign in
        </Link>
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
