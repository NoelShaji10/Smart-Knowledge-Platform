'use client';

import React, { useState, FormEvent, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { Button, Input } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { getSafeReturnUrl } from '@/lib/safeRedirect';
import styles from './page.module.css';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawReturnUrl = searchParams.get('returnUrl');
  const safeReturnUrl = getSafeReturnUrl(rawReturnUrl);

  const { login } = useAuth();
  const { refreshWorkspaces } = useWorkspace();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [generalError, setGeneralError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const validateEmail = (val: string): boolean => {
    if (!val.trim()) {
      setEmailError('Email is required');
      return false;
    }
    if (!/\S+@\S+\.\S+/.test(val)) {
      setEmailError('Please enter a valid email address');
      return false;
    }
    setEmailError('');
    return true;
  };

  const validatePassword = (val: string): boolean => {
    if (!val) {
      setPasswordError('Password is required');
      return false;
    }
    setPasswordError('');
    return true;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setGeneralError('');

    const isEmailValid = validateEmail(email);
    const isPasswordValid = validatePassword(password);

    if (!isEmailValid || !isPasswordValid) {
      return;
    }

    setSubmitting(true);

    try {
      await login(email, password);

      // If a safe return destination was requested (e.g. an invitation route),
      // navigate directly there without auto-accepting.
      if (safeReturnUrl) {
        router.replace(safeReturnUrl);
        return;
      }

      const workspaces = await refreshWorkspaces();

      if (workspaces.length === 0) {
        router.replace('/workspaces/new');
      } else {
        router.replace(`/workspaces/${workspaces[0].id}`);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setGeneralError('Too many attempts. Please try again later.');
        } else if (err.status === 401) {
          setGeneralError('Invalid email or password');
        } else {
          setGeneralError(err.message || 'Login failed. Please try again.');
        }
      } else {
        setGeneralError('An unexpected error occurred');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const registerHref = safeReturnUrl
    ? `/register?returnUrl=${encodeURIComponent(safeReturnUrl)}`
    : '/register';

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1 className={styles.heading}>Welcome back</h1>
        <p className={styles.subtext}>
          Enter your credentials to access your workspaces and team documents.
        </p>
      </header>

      <form onSubmit={handleSubmit} className={styles.form} noValidate>
        {generalError && (
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
            <span>{generalError}</span>
          </div>
        )}

        <Input
          label="Email address"
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (emailError) validateEmail(e.target.value);
          }}
          onBlur={(e) => validateEmail(e.target.value)}
          errorText={emailError}
          placeholder="name@company.com"
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

        <Input
          label="Password"
          type={showPassword ? 'text' : 'password'}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (passwordError) validatePassword(e.target.value);
          }}
          onBlur={(e) => validatePassword(e.target.value)}
          errorText={passwordError}
          placeholder="Enter your password"
          required
          autoComplete="current-password"
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
              <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          }
          endAction={
            <button
              type="button"
              className={styles.visibilityToggle}
              onClick={() => setShowPassword((prev) => !prev)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              tabIndex={0}
            >
              {showPassword ? (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                  <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                  <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                  <line x1="2" y1="2" x2="22" y2="22" />
                </svg>
              ) : (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          }
        />

        <div className={styles.actionRow}>
          <Button type="submit" loading={submitting} fullWidth>
            <span>{submitting ? 'Signing in...' : 'Sign In'}</span>
            {!submitting && (
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
            )}
          </Button>
        </div>
      </form>

      <div className={styles.cardFooter}>
        <p className={styles.footerText}>
          Don&apos;t have an account?{' '}
          <Link href={registerHref} className={styles.footerLink}>
            Sign up
          </Link>
        </p>
        <p className={styles.redirectHint}>
          You will be directed straight to your team&apos;s workspaces and documents.
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className={styles.container} />}>
      <LoginForm />
    </Suspense>
  );
}
