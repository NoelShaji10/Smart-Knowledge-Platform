'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { api, Document, ApiError } from '@/lib/api';
import { Button, Skeleton, useToast } from '@/components/ui';
import styles from './page.module.css';

export default function WorkspacePage({ params }: { params?: { workspaceId?: string } }) {
  const router = useRouter();
  const { showToast } = useToast();
  const { activeWorkspace, loadWorkspace, userRole, loading, error } = useWorkspace();
  const workspaceId = params?.workspaceId;

  const [documents, setDocuments] = useState<Document[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const canCreate = userRole === 'owner' || userRole === 'admin' || userRole === 'editor';
  const isViewer = userRole === 'viewer';

  useEffect(() => {
    if (workspaceId) {
      loadWorkspace(workspaceId);
    }
  }, [workspaceId, loadWorkspace]);

  const fetchWorkspaceDocuments = useCallback(async () => {
    if (!workspaceId) return;
    setDocsLoading(true);
    try {
      const res = await api.listDocuments(workspaceId, { includeArchived: false });
      setDocuments(res.documents);
      setDocsError(null);
      setRefreshError(null);
    } catch (err) {
      const msg =
        err instanceof ApiError && err.status === 0
          ? 'Unable to connect to server. Offline.'
          : err instanceof ApiError
          ? err.message || 'Failed to load documents'
          : err instanceof Error
          ? err.message
          : 'Failed to load documents';

      setDocuments((prev) => {
        if (prev.length > 0) {
          setRefreshError(msg);
        } else {
          setDocsError(msg);
        }
        return prev;
      });
      showToast(msg, 'error');
    } finally {
      setDocsLoading(false);
    }
  }, [workspaceId, showToast]);

  useEffect(() => {
    if (workspaceId) {
      fetchWorkspaceDocuments();
    }
  }, [workspaceId, fetchWorkspaceDocuments]);

  useEffect(() => {
    function handleRefresh() {
      fetchWorkspaceDocuments();
    }
    window.addEventListener('document:updated', handleRefresh);
    window.addEventListener('workspace:refresh', handleRefresh);
    return () => {
      window.removeEventListener('document:updated', handleRefresh);
      window.removeEventListener('workspace:refresh', handleRefresh);
    };
  }, [fetchWorkspaceDocuments]);

  const handleCreateDocument = async () => {
    if (!workspaceId || !canCreate) return;
    setCreating(true);
    try {
      const res = await api.createDocument(workspaceId, {
        title: 'Untitled Document',
      });
      showToast('Document created', 'success');
      router.push(`/workspaces/${workspaceId}/documents/${res.document.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showToast('Access denied: You do not have permission to create documents', 'error');
      } else if (err instanceof ApiError) {
        showToast(err.message || 'Failed to create document', 'error');
      } else {
        showToast('Failed to create document', 'error');
      }
    } finally {
      setCreating(false);
    }
  };

  if ((loading && !activeWorkspace) || (docsLoading && documents.length === 0 && !docsError)) {
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

  if (docsError && documents.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.content}>
          <h1 className={styles.heading}>Failed to Load Documents</h1>
          <p className={styles.description}>{docsError}</p>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={fetchWorkspaceDocuments}>
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const hasDocuments = documents.length > 0;

  return (
    <div className={styles.container}>
      <div className={styles.content}>
        {refreshError && (
          <div className={styles.staleBanner} role="alert">
            <span>Could not refresh documents. Your last loaded data is still shown ({refreshError}).</span>
            <Button variant="secondary" size="sm" onClick={fetchWorkspaceDocuments}>
              Retry
            </Button>
          </div>
        )}

        <h1 className={styles.heading}>
          {hasDocuments ? activeWorkspace?.name || 'Workspace Documents' : 'Your workspace is ready.'}
        </h1>
        <p className={styles.description}>
          {hasDocuments
            ? 'Select a document from the navigation or create a new one.'
            : isViewer
            ? 'This workspace currently has no active documents.'
            : 'Create your first document to start writing.'}
        </p>

        {canCreate && (
          <div className={styles.actions}>
            <Button
              variant="primary"
              onClick={handleCreateDocument}
              disabled={creating}
              aria-label="Create New Document"
            >
              {creating ? 'Creating...' : '+ New Document'}
            </Button>
          </div>
        )}

        {hasDocuments && (
          <div className={styles.docListSection}>
            <div className={styles.sectionTitle}>Recent Documents</div>
            <ul className={styles.docList}>
              {documents.slice(0, 5).map((doc) => (
                <li key={doc.id}>
                  <Link
                    href={`/workspaces/${workspaceId}/documents/${doc.id}`}
                    className={styles.docCard}
                  >
                    <span>{doc.title || 'Untitled Document'}</span>
                    <span className={styles.docMeta}>
                      {new Date(doc.updated_at).toLocaleDateString()}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
