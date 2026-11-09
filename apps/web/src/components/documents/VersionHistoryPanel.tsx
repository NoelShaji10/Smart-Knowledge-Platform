'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import DOMPurify from 'isomorphic-dompurify';
import { DocumentVersion, api, ApiError, Document } from '@/lib/api';
import { Button, Badge, Skeleton, useToast } from '@/components/ui';
import { getUserInitials } from '@/lib/collab-colors';
import styles from './VersionHistoryPanel.module.css';

export interface VersionHistoryPanelProps {
  workspaceId: string;
  documentId: string;
  canEdit?: boolean;
  onClose: () => void;
  onVersionRestored: (newDoc: Document) => void;
}

export function formatTriggerBadge(trigger: string) {
  switch (trigger) {
    case 'manual':
      return <Badge variant="owner">Manual Checkpoint</Badge>;
    case 'restore':
      return <Badge variant="admin">Restored Version</Badge>;
    case 'auto_interval':
      return <Badge variant="default">Automatic Checkpoint</Badge>;
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
  const [filterText, setFilterText] = useState('');
  const [previewVersion, setPreviewVersion] = useState<DocumentVersion | null>(null);
  const [confirmRestoreTarget, setConfirmRestoreTarget] = useState<number | null>(null);
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
    if (restoring) return;
    setRestoring(true);
    try {
      const res = await api.restoreVersion(workspaceId, documentId, versionNumber);
      onVersionRestored(res.document);
      showToast(`Restored version v${versionNumber} as new version checkpoint`, 'success');
      setPreviewVersion(null);
      setConfirmRestoreTarget(null);
      await fetchVersions();
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

  // Filter snapshots client-side
  const filteredVersions = useMemo(() => {
    if (!filterText.trim()) return versions;
    const q = filterText.toLowerCase();
    return versions.filter((ver) => {
      const vNum = `v${ver.version_number}`;
      const trigger = ver.trigger?.toLowerCase() || '';
      const author = (ver.creator_name || ver.creator_email || ver.created_by || '').toLowerCase();
      const title = (ver.title || '').toLowerCase();
      return (
        vNum.includes(q) ||
        trigger.includes(q) ||
        author.includes(q) ||
        title.includes(q)
      );
    });
  }, [versions, filterText]);

  // Highest version number is current
  const maxVersionNumber = useMemo(() => {
    if (versions.length === 0) return null;
    return Math.max(...versions.map((v) => v.version_number));
  }, [versions]);

  return (
    <>
      <aside className={styles.drawer} aria-label="Document Version History">
        {/* Drawer Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.headerIcon} aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 14 14" />
            </svg>
            <h2 className={styles.title}>Version History</h2>
            {!loading && (
              <span className={styles.countBadge}>
                {versions.length} {versions.length === 1 ? 'snapshot' : 'snapshots'}
              </span>
            )}
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close version history drawer"
            title="Close Drawer"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Search / Filter Strip */}
        <div className={styles.filterStrip}>
          <div className={styles.searchBox}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.searchIcon} aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Filter snapshots by date or user..."
              className={styles.searchInput}
              aria-label="Filter snapshots"
            />
            {filterText && (
              <button
                type="button"
                className={styles.clearFilterBtn}
                onClick={() => setFilterText('')}
                aria-label="Clear filter"
              >
                &times;
              </button>
            )}
          </div>
        </div>

        {/* Timeline Content */}
        <div className={styles.content}>
          {loading ? (
            <div className={styles.skeletonWrap}>
              <Skeleton height={94} borderRadius={10} />
              <Skeleton height={94} borderRadius={10} />
              <Skeleton height={94} borderRadius={10} />
            </div>
          ) : filteredVersions.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <p className={styles.emptyText}>
                {filterText
                  ? 'No snapshots match your filter.'
                  : 'No version checkpoints recorded yet.'}
              </p>
            </div>
          ) : (
            <div className={styles.timelineList}>
              {filteredVersions.map((ver) => {
                const isCurrent = ver.version_number === maxVersionNumber;
                const author = ver.creator_name || ver.creator_email || 'Author';
                const authorInitials = getUserInitials(author);

                return (
                  <div
                    key={ver.id}
                    className={`${styles.card} ${isCurrent ? styles.currentCard : ''}`}
                  >
                    <div className={styles.cardHeader}>
                      <div className={styles.versionLabelGroup}>
                        <span className={styles.versionNum}>v{ver.version_number}</span>
                        {isCurrent && (
                          <span className={styles.currentBadge}>Current</span>
                        )}
                      </div>
                      <div className={styles.triggerBadgeGroup}>
                        {formatTriggerBadge(ver.trigger)}
                      </div>
                    </div>

                    <div className={styles.metaRow}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                      <span>{new Date(ver.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    </div>

                    <div className={styles.authorRow}>
                      <div className={styles.authorAvatar} aria-hidden="true">
                        {authorInitials}
                      </div>
                      <span className={styles.authorName} title={author}>
                        {author}
                      </span>
                    </div>

                    <div className={styles.cardActions}>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setPreviewVersion(ver)}
                        className={styles.cardBtn}
                      >
                        Preview
                      </Button>
                      {isCurrent ? (
                        <button
                          type="button"
                          className={styles.viewingNowBtn}
                          disabled
                          aria-disabled="true"
                        >
                          Viewing Now
                        </button>
                      ) : (
                        canEdit && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setConfirmRestoreTarget(ver.version_number)}
                            loading={restoring && confirmRestoreTarget === ver.version_number}
                            className={styles.cardBtn}
                          >
                            Restore
                          </Button>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer Retention Note */}
        <div className={styles.footer}>
          <div className={styles.retentionInfo}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <span>Immutable snapshot log</span>
          </div>
        </div>
      </aside>

      {/* Snapshot Preview Modal */}
      {previewVersion && (
        <div className={styles.modalBackdrop} onClick={() => setPreviewVersion(null)} role="presentation">
          <div className={styles.modalContent} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="preview-modal-title">
            <div className={styles.modalHeader}>
              <div>
                <h3 id="preview-modal-title" className={styles.modalDocTitle}>
                  {previewVersion.title || 'Untitled'} (v{previewVersion.version_number})
                </h3>
                <div className={styles.modalMeta}>
                  Created {new Date(previewVersion.created_at).toLocaleString()} • {previewVersion.trigger}
                  {(previewVersion.creator_name || previewVersion.creator_email || previewVersion.created_by) &&
                    ` by ${previewVersion.creator_name || previewVersion.creator_email || previewVersion.created_by}`}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setPreviewVersion(null)}>
                &times; Close
              </Button>
            </div>

            <div
              className={styles.previewBody}
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(previewVersion.content_text || '<p>(Empty version)</p>'),
              }}
            />

            <div className={styles.previewNotice}>
              Restoring this version creates a NEW version checkpoint while preserving existing history.
            </div>

            <div className={styles.modalFooterActions}>
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

      {/* Restore Confirmation Dialog */}
      {confirmRestoreTarget !== null && (
        <div className={styles.modalBackdrop} onClick={() => setConfirmRestoreTarget(null)} role="presentation">
          <div className={styles.confirmModal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="restore-confirm-title">
            <h3 id="restore-confirm-title" className={styles.confirmTitle}>
              Restore Document to v{confirmRestoreTarget}?
            </h3>
            <p className={styles.confirmBody}>
              Restoring this version will apply the snapshot content to your document and record a new checkpoint in version history. Your current state is safe and not deleted.
            </p>
            <div className={styles.confirmActions}>
              <Button variant="secondary" size="sm" onClick={() => setConfirmRestoreTarget(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleRestoreVersion(confirmRestoreTarget)}
                loading={restoring}
              >
                Confirm Restore
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
