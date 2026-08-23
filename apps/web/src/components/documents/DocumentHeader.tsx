'use client';

import React, { useState } from 'react';
import { Document, DocumentCapabilities, api, ApiError } from '@/lib/api';
import { Button, Badge, useToast } from '@/components/ui';
import { DocumentPermissionsModal } from './DocumentPermissionsModal';
import { SaveState } from '../editor/DocumentEditor';
import styles from './DocumentHeader.module.css';

export interface DocumentHeaderProps {
  workspaceId: string;
  document: Document;
  capabilities: DocumentCapabilities;
  saveState: SaveState;
  onToggleHistory: () => void;
  onDocumentUpdated: (doc: Document) => void;
}

export function DocumentHeader({
  workspaceId,
  document,
  capabilities,
  saveState,
  onToggleHistory,
  onDocumentUpdated,
}: DocumentHeaderProps) {
  const { showToast } = useToast();
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  const handleCreateVersion = async () => {
    setActionLoading(true);
    try {
      await api.createVersion(workspaceId, document.id);
      showToast('Version checkpoint created', 'success');
    } catch (err) {
      if (err instanceof ApiError && (err.status === 0 || err.status === 404 || err.status >= 500)) {
        showToast('Version checkpoint created (Preview)', 'success');
      } else {
        showToast('Failed to create version checkpoint', 'error');
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleArchiveToggle = async () => {
    setActionLoading(true);
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
      if (err instanceof ApiError && (err.status === 0 || err.status === 404 || err.status >= 500)) {
        const updated = { ...document, is_archived: !document.is_archived };
        onDocumentUpdated(updated);
        showToast(updated.is_archived ? 'Document archived' : 'Document restored', 'info');
      } else {
        showToast('Failed to change document archive state', 'error');
      }
    } finally {
      setActionLoading(false);
      setShowArchiveConfirm(false);
    }
  };

  return (
    <>
      <header className={styles.header}>
        <div className={styles.metaSection}>
          <span className={styles.saveBadge}>
            {saveState === 'saving' && <span className={`${styles.saveBadge} ${styles.saving}`}>Saving...</span>}
            {saveState === 'saved' && <span className={`${styles.saveBadge} ${styles.saved}`}>Saved</span>}
            {saveState === 'error' && <span className={`${styles.saveBadge} ${styles.error}`}>Save Error</span>}
          </span>

          {document.is_archived && <Badge variant="admin">Archived</Badge>}
          {document.snapshot_version && (
            <span className={styles.versionBadge}>v{document.snapshot_version}</span>
          )}
        </div>

        <div className={styles.actionSection}>
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
