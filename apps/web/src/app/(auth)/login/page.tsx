'use client';

import React, { useState, FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { Button, Input } from '@/components/ui';
import { ApiError } from '@/lib/api';
import styles from './page.module.css';

export default function LoginPage() {
  const router = useRouter();
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

  return (
    <div>
      <h1 className={styles.heading}>Welcome back</h1>
      <p className={styles.subtext}>Sign in to your workspace</p>

      <form onSubmit={handleSubmit} className={styles.form} noValidate>
        {generalError && <div className={styles.errorMessage}>{generalError}</div>}

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

        <Button type="submit" loading={submitting} fullWidth>
          Sign In
        </Button>
      </form>

      <p className={styles.footerText}>
        Don&apos;t have an account?{' '}
        <Link href="/register" className={styles.footerLink}>
          Sign up
        </Link>
      </p>
    </div>
  );
}
