'use client';

import React, { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { Button, Input } from '@/components/ui';
import { ApiError } from '@/lib/api';
import styles from './page.module.css';

export default function NewWorkspacePage() {
  const router = useRouter();
  const { createWorkspace } = useWorkspace();

  const [name, setName] = useState('');
  const [nameError, setNameError] = useState('');
  const [generalError, setGeneralError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const validateName = (val: string): boolean => {
    const trimmed = val.trim();
    if (!trimmed) {
      setNameError('Workspace name is required');
      return false;
    }
    if (trimmed.length > 100) {
      setNameError('Workspace name must be 100 characters or less');
      return false;
    }
    setNameError('');
    return true;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setGeneralError('');

    if (!validateName(name)) {
      return;
    }

    setSubmitting(true);

    try {
      const workspace = await createWorkspace(name.trim());
      router.replace(`/workspaces/${workspace.id}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setGeneralError(err.message || 'Failed to create workspace. Please try again.');
      } else {
        setGeneralError('An unexpected error occurred');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main id="main-content" className={styles.container}>
      <div className={styles.cardContainer}>
        {/* Brand Lockup */}
        <div className={styles.brandHeader}>
          <div className={styles.logoBadge} aria-hidden="true">
            <svg
              width="20"
              height="20"
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
          <div className={styles.brandText}>
            <span className={styles.wordmark}>Knowledge Platform</span>
            <span className={styles.wordmarkKicker}>Workspace Onboarding</span>
          </div>
        </div>

        {/* Card Body */}
        <div className={styles.contentCard}>
          <header className={styles.header}>
            <h1 className={styles.heading}>Create your workspace</h1>
            <p className={styles.subtext}>
              Workspaces are shared hubs for your team&apos;s real-time documents, knowledge base, and member permissions.
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
              label="Workspace Name"
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) validateName(e.target.value);
              }}
              onBlur={(e) => validateName(e.target.value)}
              errorText={nameError}
              placeholder="e.g. Acme Engineering"
              maxLength={100}
              required
              autoFocus
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
                  <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                  <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
                </svg>
              }
            />

            <div className={styles.infoBox}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={styles.infoIcon}
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <p className={styles.infoText}>
                As the creator, you will be assigned as workspace <strong>Owner</strong>. You will be able to invite team members and configure access permissions right after creation.
              </p>
            </div>

            <div className={styles.actionRow}>
              <Button type="submit" loading={submitting} fullWidth>
                <span>{submitting ? 'Creating workspace...' : 'Create Workspace'}</span>
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
        </div>
      </div>
    </main>
  );
}
