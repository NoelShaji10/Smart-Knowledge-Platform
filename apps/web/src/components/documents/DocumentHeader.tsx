'use client';

import React, { useState } from 'react';
import { Document, DocumentCapabilities, api, ApiError } from '@/lib/api';
import { useWorkspaceOptional } from '@/contexts/WorkspaceContext';
import { useDocumentNavigationOptional } from '@/contexts/DocumentNavigationContext';
import { Button, Badge, useToast } from '@/components/ui';
import { DocumentPermissionsModal } from './DocumentPermissionsModal';
import { Breadcrumbs } from './Breadcrumbs';
import { SaveState } from '../editor/DocumentEditor';
import { CollaboratorAvatars } from '../editor/CollaboratorAvatars';
import { CollabUser } from '@/hooks/useCollaboration';
import styles from './DocumentHeader.module.css';

export interface DocumentHeaderProps {
  workspaceId: string;
  document: Document;
  capabilities: DocumentCapabilities;
  saveState: SaveState;
  connectedUsers?: CollabUser[];
  onToggleHistory: () => void;
  onDocumentUpdated: (doc: Document) => void;
}

export function DocumentHeader({
  workspaceId,
  document,
  capabilities,
  saveState,
  connectedUsers,
  onToggleHistory,
  onDocumentUpdated,
}: DocumentHeaderProps) {
  const { showToast } = useToast();
  const ws = useWorkspaceOptional();
  const activeWorkspace = ws?.activeWorkspace || null;
  const nav = useDocumentNavigationOptional();
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const handleCreateVersion = async () => {
    if (actionLoading) return;
    setActionLoading(true);
    try {
      const res = await api.createVersion(workspaceId, document.id);
      if (res?.version && onDocumentUpdated) {
        onDocumentUpdated({
          ...document,
          snapshot_version: res.version.version_number,
        });
      }
      showToast('Version checkpoint created', 'success');
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showToast('Access denied: You do not have permission to create version checkpoints', 'error');
      } else if (err instanceof ApiError && err.message) {
        showToast(err.message, 'error');
      } else {
        showToast('Failed to create version checkpoint', 'error');
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleArchiveToggle = async () => {
    if (actionLoading) return;
    setActionLoading(true);
    const targetIsArchived = !document.is_archived;
    try {
      if (document.is_archived) {
        const res = await api.restoreDocument(workspaceId, document.id);
        onDocumentUpdated(res.document);
        showToast('Document restored', 'success');
      } else {
        const res = await api.archiveDocument(workspaceId, document.id);
        onDocumentUpdated(res.document);
        showToast('Document archived', 'info');
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showToast(`Access denied: You do not have permission to ${targetIsArchived ? 'archive' : 'restore'} this document`, 'error');
      } else {
        showToast(`Failed to ${targetIsArchived ? 'archive' : 'restore'} document`, 'error');
      }
    } finally {
      setActionLoading(false);
      setShowArchiveConfirm(false);
    }
  };

  return (
    <>
      <header className={styles.header} aria-label="Document control header">
        {/* Left Section: Breadcrumb & Sync Status Deck */}
        <div className={styles.leftSection}>
          <div className={styles.breadcrumbSection}>
            <Breadcrumbs
              workspaceId={workspaceId}
              workspaceName={activeWorkspace?.name || 'Workspace'}
              currentDocument={document}
              documents={nav?.documents}
            />
          </div>

          <div className={styles.statusDivider} aria-hidden="true" />

          <div className={styles.metaSection}>
            {/* Real Save / Sync Status Badge */}
            <span className={styles.saveBadgeWrapper}>
              {saveState === 'saving' && (
                <span className={`${styles.saveBadge} ${styles.saving}`} title="Saving changes...">
                  <span className={`${styles.statusDot} ${styles.dotPulse}`} aria-hidden="true" />
                  <span>Saving...</span>
                </span>
              )}
              {saveState === 'saved' && (
                <span className={`${styles.saveBadge} ${styles.saved}`} title="All changes saved and synchronized">
                  <span className={styles.statusDot} aria-hidden="true" />
                  <span>Saved</span>
                </span>
              )}
              {saveState === 'editing' && (
                <span className={`${styles.saveBadge} ${styles.pending}`} title="Unsaved changes pending save">
                  <span className={styles.statusDot} aria-hidden="true" />
                  <span>Changes pending</span>
                </span>
              )}
              {saveState === 'delayed' && (
                <span className={`${styles.saveBadge} ${styles.delayed}`} title="Network delayed: syncing in background">
                  <span className={styles.statusDot} aria-hidden="true" />
                  <span>Persistence delayed</span>
                </span>
              )}
              {saveState === 'disconnected' && (
                <span className={`${styles.saveBadge} ${styles.offline}`} title="Disconnected from real-time collaboration">
                  <span className={styles.statusDot} aria-hidden="true" />
                  <span>Offline</span>
                </span>
              )}
              {saveState === 'recovering' && (
                <span className={`${styles.saveBadge} ${styles.reconnecting}`} title="Re-establishing connection...">
                  <span className={`${styles.statusDot} ${styles.dotPulse}`} aria-hidden="true" />
                  <span>Reconnecting...</span>
                </span>
              )}
              {saveState === 'error' && (
                <span className={`${styles.saveBadge} ${styles.error}`} title="Synchronization failure">
                  <span className={styles.statusDot} aria-hidden="true" />
                  <span>Save failed</span>
                </span>
              )}
            </span>

            {/* Read-Only or Archived Indicators */}
            {!capabilities.canEdit && !document.is_archived && (
              <Badge variant="viewer">View Only</Badge>
            )}
            {document.is_archived && (
              <Badge variant="admin">Archived</Badge>
            )}
          </div>
        </div>

        {/* Right Section: Collaborators & Primary Actions */}
        <div className={styles.actionSection}>
          {connectedUsers && connectedUsers.length > 0 && (
            <div className={styles.collaboratorsWrap} title="Active Collaborators">
              <CollaboratorAvatars users={connectedUsers} />
            </div>
          )}

          <div className={styles.actionDivider} aria-hidden="true" />

          {capabilities.canManagePermissions && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowPermissionsModal(true)}
              title="Manage Document Permissions"
              aria-label="Manage Document Permissions"
              className={styles.headerBtn}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>Permissions</span>
            </Button>
          )}

          {capabilities.canEdit && !document.is_archived && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCreateVersion}
              disabled={actionLoading}
              loading={actionLoading ? true : undefined}
              title="Save a human-visible checkpoint of current document"
              aria-label="Save Version"
              className={styles.headerBtn}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                <line x1="12" y1="7" x2="12" y2="13" />
                <line x1="9" y1="10" x2="15" y2="10" />
              </svg>
              <span>Save Version</span>
            </Button>
          )}

          <Button
            variant="primary"
            size="sm"
            onClick={onToggleHistory}
            title="Toggle Version History Timeline"
            aria-label="Version History"
            className={styles.headerBtn}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 14 14" />
            </svg>
            <span>History</span>
          </Button>

          {capabilities.canArchive && (
            <Button
              variant={document.is_archived ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => {
                if (document.is_archived) {
                  handleArchiveToggle();
                } else {
                  setShowArchiveConfirm(true);
                }
              }}
              disabled={actionLoading}
              title={document.is_archived ? 'Restore document to workspace' : 'Archive document'}
              aria-label={document.is_archived ? 'Restore Document' : 'Archive Document'}
              className={styles.headerBtn}
            >
              {document.is_archived ? 'Restore' : 'Archive'}
            </Button>
          )}
        </div>
      </header>

      {showPermissionsModal && (
        <DocumentPermissionsModal
          workspaceId={workspaceId}
          documentId={document.id}
          onClose={() => setShowPermissionsModal(false)}
        />
      )}

      {showArchiveConfirm && (
        <div className={styles.confirmModalBackdrop} onClick={() => setShowArchiveConfirm(false)} role="presentation">
          <div className={styles.confirmModal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="archive-modal-title">
            <h2 id="archive-modal-title" className={styles.modalTitle}>Archive Document?</h2>
            <p className={styles.modalBody}>
              Archiving &ldquo;{document.title}&rdquo; will remove it from active navigation. You can restore it anytime from version history or archive settings.
            </p>
            <div className={styles.modalFooter}>
              <Button variant="secondary" size="sm" onClick={() => setShowArchiveConfirm(false)}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={handleArchiveToggle} loading={actionLoading ? true : undefined}>
                Archive Document
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
