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
      <div className={styles.content}>
        <div className={styles.wordmark}>Knowledge Platform</div>
        <div className={styles.divider} />

        <h1 className={styles.heading}>Create a new workspace</h1>
        <p className={styles.subtext}>
          Workspaces organize your documents and team collaboration.
        </p>

        <form onSubmit={handleSubmit} className={styles.form} noValidate>
          {generalError && <div className={styles.errorMessage}>{generalError}</div>}

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
            placeholder="Acme Engineering"
            maxLength={100}
            required
            autoFocus
          />

          <Button type="submit" loading={submitting} fullWidth>
            Create Workspace
          </Button>
        </form>
      </div>
    </main>
  );
}
