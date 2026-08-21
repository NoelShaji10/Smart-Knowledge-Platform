'use client';

import React, { useState, FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { Button, Input } from '@/components/ui';
import { ApiError } from '@/lib/api';
import styles from './page.module.css';

export default function RegisterPage() {
  const router = useRouter();
  const { register } = useAuth();
  const { refreshWorkspaces } = useWorkspace();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [displayNameError, setDisplayNameError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [generalError, setGeneralError] = useState('');
  const [passwordRequirementMet, setPasswordRequirementMet] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const validateDisplayName = (val: string): boolean => {
    if (!val.trim()) {
      setDisplayNameError('Display name is required');
      return false;
    }
    setDisplayNameError('');
    return true;
  };

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
    const isMinLength = val.length >= 8;
    setPasswordRequirementMet(isMinLength);

    if (!val) {
      setPasswordError('Password is required');
      return false;
    }
    if (!isMinLength) {
      setPasswordError('Password must be at least 8 characters');
      return false;
    }
    setPasswordError('');
    return true;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setGeneralError('');

    const isNameValid = validateDisplayName(displayName);
    const isEmailValid = validateEmail(email);
    const isPasswordValid = validatePassword(password);

    if (!isNameValid || !isEmailValid || !isPasswordValid) {
      return;
    }

    setSubmitting(true);

    try {
      await register(displayName.trim(), email.trim(), password);
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
        } else {
          setGeneralError(err.message || 'Registration failed. Please try again.');
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
      <h1 className={styles.heading}>Create your account</h1>
      <p className={styles.subtext}>Start collaborating with your team</p>

      <form onSubmit={handleSubmit} className={styles.form} noValidate>
        {generalError && <div className={styles.errorMessage}>{generalError}</div>}

        <Input
          label="Display Name"
          type="text"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value);
            if (displayNameError) validateDisplayName(e.target.value);
          }}
          onBlur={(e) => validateDisplayName(e.target.value)}
          errorText={displayNameError}
          placeholder="Jane Doe"
          required
          autoComplete="name"
        />

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

        <div>
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
            autoComplete="new-password"
          />
          <p className={`${styles.passwordRequirement} ${passwordRequirementMet ? styles.met : ''}`}>
            {passwordRequirementMet ? '✓ At least 8 characters' : 'At least 8 characters'}
          </p>
        </div>

        <Button type="submit" loading={submitting} fullWidth>
          Create Account
        </Button>
      </form>

      <p className={styles.footerText}>
        Already have an account?{' '}
        <Link href="/login" className={styles.footerLink}>
          Sign in
        </Link>
      </p>
    </div>
  );
}
