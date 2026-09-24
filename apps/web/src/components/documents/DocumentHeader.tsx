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
      await api.createVersion(workspaceId, document.id);
      showToast('Version checkpoint created', 'success');
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showToast('Access denied: You do not have permission to create version checkpoints', 'error');
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
      <header className={styles.header}>
        <div className={styles.breadcrumbSection}>
          <Breadcrumbs
            workspaceId={workspaceId}
            workspaceName={activeWorkspace?.name || 'Workspace'}
            currentDocument={document}
            documents={nav?.documents}
          />
        </div>

        <div className={styles.metaSection}>
          <span className={styles.saveBadge}>
            {saveState === 'saving' && <span className={`${styles.saveBadge} ${styles.saving}`}>Saving...</span>}
            {saveState === 'saved' && <span className={`${styles.saveBadge} ${styles.saved}`}>Saved</span>}
            {saveState === 'editing' && <span className={`${styles.saveBadge} ${styles.pending}`}>Changes pending</span>}
            {saveState === 'delayed' && <span className={`${styles.saveBadge} ${styles.delayed}`}>Persistence delayed</span>}
            {saveState === 'disconnected' && <span className={`${styles.saveBadge} ${styles.offline}`}>Offline</span>}
            {saveState === 'recovering' && <span className={`${styles.saveBadge} ${styles.reconnecting}`}>Reconnecting...</span>}
            {saveState === 'error' && <span className={`${styles.saveBadge} ${styles.error}`}>Save failed</span>}
          </span>

          {!capabilities.canEdit && !document.is_archived && <Badge variant="viewer">View Only</Badge>}
          {document.is_archived && <Badge variant="admin">Archived</Badge>}
          {document.snapshot_version && (
            <span className={styles.versionBadge}>v{document.snapshot_version}</span>
          )}
        </div>

        <div className={styles.actionSection}>
          {connectedUsers && connectedUsers.length > 0 && (
            <CollaboratorAvatars users={connectedUsers} />
          )}

          {capabilities.canManagePermissions && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowPermissionsModal(true)}
              title="Manage Document Permissions"
            >
              Permissions
            </Button>
          )}

          {capabilities.canEdit && !document.is_archived && (
            <Button variant="secondary" size="sm" onClick={handleCreateVersion} disabled={actionLoading}>
              Save Version
            </Button>
          )}

          <Button variant="ghost" size="sm" onClick={onToggleHistory}>
            History
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
        <div className={styles.confirmModalBackdrop} onClick={() => setShowArchiveConfirm(false)}>
          <div className={styles.confirmModal} onClick={(e) => e.stopPropagation()}>
            <h2 className={styles.modalTitle}>Archive Document?</h2>
            <p className={styles.modalBody}>
              Archiving &ldquo;{document.title}&rdquo; will remove it from active navigation. You can restore it anytime from version history or archive settings.
            </p>
            <div className={styles.modalFooter}>
              <Button variant="secondary" size="sm" onClick={() => setShowArchiveConfirm(false)}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={handleArchiveToggle} loading={actionLoading}>
                Archive Document
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
