'use client';

import React, { useEffect } from 'react';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { Button, Skeleton } from '@/components/ui';
import styles from './page.module.css';

export default function WorkspacePage({ params }: { params?: { workspaceId?: string } }) {
  const { activeWorkspace, loadWorkspace, loading, error } = useWorkspace();
  const workspaceId = params?.workspaceId;

  useEffect(() => {
    if (workspaceId) {
      loadWorkspace(workspaceId);
    }
  }, [workspaceId, loadWorkspace]);

  if (loading && !activeWorkspace) {
    return (
      <div className={styles.container}>
        <div className={styles.content}>
          <Skeleton width={200} height={24} />
          <div style={{ marginTop: 'var(--space-2)' }}>
            <Skeleton width={300} height={18} />
          </div>
          <div style={{ marginTop: 'var(--space-6)' }}>
            <Skeleton width={140} height={40} borderRadius={6} />
          </div>
        </div>
      </div>
    );
  }

  if (error && !activeWorkspace) {
    return (
      <div className={styles.container}>
        <div className={styles.content}>
          <h1 className={styles.heading}>Workspace Not Found</h1>
          <p className={styles.description}>
            The workspace you requested could not be loaded or you do not have permission to view it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Your workspace is ready.</h1>
        <p className={styles.description}>
          Create your first document to start writing.
        </p>

        <Button
          disabled
          aria-disabled="true"
          title="Document creation will be enabled in Task T8"
        >
          + New Document
        </Button>
      </div>
    </div>
  );
}
