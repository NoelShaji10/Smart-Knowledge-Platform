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
        <p className={styles.subtext}>Sign in to your workspace</p>
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
          label="Email"
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
        />

        <Input
          label="Password"
          type="password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (passwordError) validatePassword(e.target.value);
          }}
          onBlur={(e) => validatePassword(e.target.value)}
          errorText={passwordError}
          required
          autoComplete="current-password"
        />

        <div className={styles.actionRow}>
          <Button type="submit" loading={submitting} fullWidth>
            Sign In
          </Button>
        </div>
      </form>

      <p className={styles.footerText}>
        Don&apos;t have an account?{' '}
        <Link href={registerHref} className={styles.footerLink}>
          Sign up
        </Link>
      </p>
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
