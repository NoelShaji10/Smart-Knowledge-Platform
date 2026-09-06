'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  api,
  Document,
  DocumentCapabilities,
  ApiError,
} from '@/lib/api';
import { Skeleton, Button, useToast } from '@/components/ui';
import { DocumentHeader } from '@/components/documents/DocumentHeader';
import { DocumentEditor, SaveState } from '@/components/editor/DocumentEditor';
import { VersionHistoryPanel } from '@/components/documents/VersionHistoryPanel';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import styles from './page.module.css';

export default function DocumentPage({
  params,
}: {
  params?: { workspaceId?: string; documentId?: string };
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const { activeWorkspace, loadWorkspace } = useWorkspace();

  const workspaceId = params?.workspaceId || '';
  const documentId = params?.documentId || '';

  const [document, setDocument] = useState<Document | null>(null);
  const [capabilities, setCapabilities] = useState<DocumentCapabilities>({
    canRead: true,
    canEdit: true,
    canMove: true,
    canArchive: true,
    canManagePermissions: true,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (workspaceId && activeWorkspace?.id !== workspaceId) {
      loadWorkspace(workspaceId);
    }
  }, [workspaceId, activeWorkspace, loadWorkspace]);

  const fetchDocument = useCallback(async () => {
    if (!workspaceId || !documentId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getDocument(workspaceId, documentId);
      setDocument(res.document);
      setCapabilities(res.capabilities);
    } catch (err) {
      setDocument(null);
      if (err instanceof ApiError) {
        if (err.status === 403) {
          setError('403: Access Denied to Document');
        } else if (err.status === 404) {
          setError('404: Document Not Found');
        } else if (err.status === 0) {
          setError('Network Error: Unable to Connect');
        } else if (err.status >= 500) {
          setError('Unable to Load Document (Server Error)');
        } else {
          setError(err.message || 'Failed to load document');
        }
      } else {
        setError('Failed to connect to server');
      }
    } finally {
      setLoading(false);
    }
  }, [workspaceId, documentId]);

  useEffect(() => {
    fetchDocument();
  }, [fetchDocument]);

  const handleDocumentUpdated = (updated: Document) => {
    setDocument(updated);
  };

  if (loading) {
    return (
      <div className={styles.pageWrapper}>
        <div style={{ padding: 'var(--space-6)', maxWidth: 780, margin: '0 auto', width: '100%' }}>
          <Skeleton height={36} width="60%" />
          <div style={{ marginTop: 'var(--space-4)' }}>
            <Skeleton height={200} width="100%" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !document) {
    const is403 = error?.includes('403');
    const is404 = error?.includes('404');
    const is500 = error?.includes('Server Error') || error?.includes('500');

    let description = 'Unable to load this document right now. Please check your connection and try again.';
    if (is403) {
      description = 'You do not have permission to access or edit this document. Contact your workspace administrator to request access.';
    } else if (is404) {
      description = 'The requested document does not exist or has been removed.';
    } else if (is500) {
      description = 'Unable to load this document right now. Your data is safely stored in PostgreSQL. Please try again.';
    }

    return (
      <div className={styles.pageWrapper}>
        <div className={styles.errorState}>
          <h1 className={styles.errorHeading}>{error || 'Document Not Found'}</h1>
          <p style={{ color: 'var(--fg-secondary)', fontSize: 'var(--text-sm)', maxWidth: 440, textAlign: 'center' }}>
            {description}
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)' }}>
            <Button variant="secondary" onClick={fetchDocument}>
              Retry Connection
            </Button>
            <Button variant="primary" onClick={() => router.push(`/workspaces/${workspaceId}`)}>
              Back to Workspace
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const isReadOnly = !capabilities.canEdit || document.is_archived;

  return (
    <div className={styles.pageWrapper}>
      <DocumentHeader
        workspaceId={workspaceId}
        document={document}
        capabilities={capabilities}
        saveState={saveState}
        onToggleHistory={() => setShowHistory((prev) => !prev)}
        onDocumentUpdated={handleDocumentUpdated}
      />

      {document.is_archived && (
        <div className={styles.archivedBanner}>
          <span className={styles.bannerText}>
            This document is archived and is currently read-only.
          </span>
          {capabilities.canArchive && (
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                try {
                  const res = await api.restoreDocument(workspaceId, document.id);
                  handleDocumentUpdated(res.document);
                  showToast('Document restored', 'success');
                } catch (err) {
                  if (err instanceof ApiError && err.status === 403) {
                    showToast('Access denied: You do not have permission to restore this document', 'error');
                  } else {
                    showToast('Failed to restore document', 'error');
                  }
                }
              }}
            >
              Restore Document
            </Button>
          )}
        </div>
      )}

      <div className={styles.bodyLayout}>
        <div className={styles.editorContainer}>
          <DocumentEditor
            workspaceId={workspaceId}
            document={document}
            readOnly={isReadOnly}
            collaborative={!isReadOnly}
            onSaveStateChange={setSaveState}
            onDocumentUpdated={handleDocumentUpdated}
          />
        </div>

        {showHistory && (
          <VersionHistoryPanel
            workspaceId={workspaceId}
            documentId={document.id}
            canEdit={capabilities.canEdit && !document.is_archived}
            onClose={() => setShowHistory(false)}
            onVersionRestored={(newDoc) => {
              handleDocumentUpdated(newDoc);
              fetchDocument();
            }}
          />
        )}
      </div>
    </div>
  );
}
