'use client';

import React from 'react';
import { CollabProviderStatus } from '@/lib/collab-provider';
import { Button } from '@/components/ui';
import styles from './ConnectionStatusBanner.module.css';

export interface ConnectionStatusBannerProps {
  status: CollabProviderStatus;
  readOnly?: boolean;
  onRetry?: () => void;
}

export function ConnectionStatusBanner({
  status,
  readOnly = false,
  onRetry,
}: ConnectionStatusBannerProps) {
  if (status === 'connected' && !readOnly) {
    return null;
  }

  return (
    <div
      className={`${styles.banner} ${styles[status] || styles.disconnected}`}
      role="status"
      aria-live="polite"
    >
      <div className={styles.statusContent}>
        <span className={styles.statusDot} aria-hidden="true" />
        <span className={styles.statusText}>
          {status === 'connecting' && (
            <>Reconnecting to collaboration server... Editing is temporarily disabled.</>
          )}
          {status === 'disconnected' && (
            <>Disconnected from collaboration server. Last known document content is available read-only.</>
          )}
          {status === 'error' && (
            <>Collaboration connection or authorization failure. Document is in read-only mode.</>
          )}
          {status === 'connected' && readOnly && (
            <>You are viewing this document in View-Only mode.</>
          )}
        </span>
      </div>

      {status === 'error' && onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} className={styles.retryBtn}>
          Retry Connection
        </Button>
      )}
    </div>
  );
}
