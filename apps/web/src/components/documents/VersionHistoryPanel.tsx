'use client';

import React, { useState, useEffect, useCallback } from 'react';
import DOMPurify from 'isomorphic-dompurify';
import { DocumentVersion, api, ApiError, Document } from '@/lib/api';
import { Button, Badge, Skeleton, useToast } from '@/components/ui';
import styles from './VersionHistoryPanel.module.css';

export interface VersionHistoryPanelProps {
  workspaceId: string;
  documentId: string;
  canEdit?: boolean;
  onClose: () => void;
  onVersionRestored: (newDoc: Document) => void;
}

function getTriggerBadge(trigger: string) {
  switch (trigger) {
    case 'manual':
      return <Badge variant="owner">Manual Checkpoint</Badge>;
    case 'restore':
      return <Badge variant="admin">Restored Version</Badge>;
    case 'auto_interval':
      return <Badge variant="default">Auto Saved</Badge>;
    case 'session_end':
      return <Badge variant="viewer">Session Saved</Badge>;
    default:
      return <Badge variant="default">{trigger}</Badge>;
  }
}

export function VersionHistoryPanel({
  workspaceId,
  documentId,
  canEdit = true,
  onClose,
  onVersionRestored,
}: VersionHistoryPanelProps) {
  const { showToast } = useToast();
  const [versions, setVersions] = useState<DocumentVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewVersion, setPreviewVersion] = useState<DocumentVersion | null>(null);
  const [restoring, setRestoring] = useState(false);

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listVersions(workspaceId, documentId);
      setVersions(res.versions);
    } catch (err) {
      setVersions([]);
      if (err instanceof ApiError && err.status === 403) {
        showToast('Access denied: You cannot view version history for this document', 'error');
      } else {
        showToast('Failed to load version history', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [workspaceId, documentId, showToast]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  const handleRestoreVersion = async (versionNumber: number) => {
    setRestoring(true);
    try {
      const res = await api.restoreVersion(workspaceId, documentId, versionNumber);
      onVersionRestored(res.document);
      showToast(`Restored version v${versionNumber} as new version checkpoint`, 'success');
      setPreviewVersion(null);
      fetchVersions();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 403) {
          showToast('Access denied: You do not have permission to restore versions', 'error');
        } else {
          showToast(err.message || 'Failed to restore version', 'error');
        }
      } else {
        showToast('Failed to restore version', 'error');
      }
    } finally {
      setRestoring(false);
    }
  };

  return (
    <>
      <aside className={styles.panel} aria-label="Version History Panel">
        <div className={styles.header}>
          <h2 className={styles.title}>Version History</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close version history">
            &times;
          </button>
        </div>

        <div className={styles.content}>
          {loading ? (
            <>
              <Skeleton height={80} />
              <Skeleton height={80} />
            </>
          ) : versions.length === 0 ? (
            <div className={styles.emptyText}>No version checkpoints recorded yet.</div>
          ) : (
            versions.map((ver) => (
              <div key={ver.id} className={styles.versionCard}>
                <div className={styles.versionHeader}>
                  <span className={styles.versionNum}>v{ver.version_number}</span>
                  {getTriggerBadge(ver.trigger)}
                </div>
                <div className={styles.versionMeta}>
                  Created {new Date(ver.created_at).toLocaleString()}
                  {(ver.creator_name || ver.creator_email || ver.created_by) && (
                    <span> • Author: {ver.creator_name || ver.creator_email || ver.created_by}</span>
                  )}
                </div>
                <div className={styles.versionActions}>
                  <Button variant="ghost" size="sm" onClick={() => setPreviewVersion(ver)}>
                    Preview
                  </Button>
                  {canEdit && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleRestoreVersion(ver.version_number)}
                      loading={restoring}
                    >
                      Restore
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </aside>

      {previewVersion && (
        <div className={styles.modalBackdrop} onClick={() => setPreviewVersion(null)}>
          <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div>
                <h3 className={styles.modalDocTitle}>
                  {previewVersion.title || 'Untitled'} (v{previewVersion.version_number})
                </h3>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-tertiary)' }}>
                  Created {new Date(previewVersion.created_at).toLocaleString()} via {previewVersion.trigger}
                  {(previewVersion.creator_name || previewVersion.creator_email || previewVersion.created_by) &&
                    ` by ${previewVersion.creator_name || previewVersion.creator_email || previewVersion.created_by}`}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setPreviewVersion(null)}>
                Close
              </Button>
            </div>

            <div
              className={styles.previewBody}
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(previewVersion.content_text || '<p>(Empty version)</p>'),
              }}
            />

            <div style={{ padding: 'var(--space-2) 0', fontSize: 'var(--text-xs)', color: 'var(--fg-secondary)', fontStyle: 'italic' }}>
              Note: Restoring this version creates a NEW version checkpoint. Existing history is preserved.
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
              <Button variant="secondary" size="sm" onClick={() => setPreviewVersion(null)}>
                Cancel
              </Button>
              {canEdit && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => handleRestoreVersion(previewVersion.version_number)}
                  loading={restoring}
                >
                  Restore This Version
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
