'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useDocumentNavigationOptional } from '@/contexts/DocumentNavigationContext';
import { api, Document, ApiError } from '@/lib/api';
import { Button, Skeleton, useToast } from '@/components/ui';
import { CreateDocumentModal } from '@/components/documents/CreateDocumentModal';
import styles from './page.module.css';

export default function WorkspacePage({ params }: { params?: { workspaceId?: string } }) {
  const router = useRouter();
  const { showToast } = useToast();
  const { activeWorkspace, loadWorkspace, userRole, loading, error } = useWorkspace();
  const workspaceId = params?.workspaceId;
  const nav = useDocumentNavigationOptional();

  const [localDocs, setLocalDocs] = useState<Document[]>([]);
  const [localDocsLoading, setLocalDocsLoading] = useState(true);
  const [localDocsError, setLocalDocsError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  const canCreate = userRole === 'owner' || userRole === 'admin' || userRole === 'editor';
  const isViewer = userRole === 'viewer';

  const documents = nav ? nav.activeDocuments : localDocs;
  const docsLoading = nav ? nav.loading : localDocsLoading;
  const docsError = nav ? nav.error : localDocsError;

  useEffect(() => {
    if (workspaceId) {
      loadWorkspace(workspaceId);
    }
  }, [workspaceId, loadWorkspace]);

  const fetchWorkspaceDocuments = useCallback(async () => {
    if (nav) {
      setRefreshError(null);
      await nav.refreshDocuments();
      return;
    }
    if (!workspaceId) return;
    setLocalDocsLoading(true);
    try {
      const res = await api.listDocuments(workspaceId, { includeArchived: false });
      setLocalDocs(res.documents);
      setLocalDocsError(null);
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

      setLocalDocs((prev) => {
        if (prev.length > 0) {
          setRefreshError(msg);
        } else {
          setLocalDocsError(msg);
        }
        return prev;
      });
      showToast(msg, 'error');
    } finally {
      setLocalDocsLoading(false);
    }
  }, [workspaceId, nav, showToast]);

  useEffect(() => {
    if (!nav && workspaceId) {
      fetchWorkspaceDocuments();
    }
  }, [workspaceId, nav, fetchWorkspaceDocuments]);

  useEffect(() => {
    if (nav) return;
    function handleRefresh(e: Event) {
      const customEvt = e as CustomEvent<{ document: Document }>;
      if (customEvt.detail?.document) {
        const updated = customEvt.detail.document;
        // Verify the document belongs to the currently active workspace
        if (workspaceId && updated.workspace_id !== workspaceId) {
          return;
        }

        setLocalDocs((prev) => {
          const exists = prev.some((d) => d.id === updated.id);
          if (exists) {
            return prev.map((d) => (d.id === updated.id ? updated : d));
          }
          return [updated, ...prev];
        });
      } else {
        fetchWorkspaceDocuments();
      }
    }
    window.addEventListener('document:updated', handleRefresh);
    window.addEventListener('workspace:refresh', handleRefresh);
    return () => {
      window.removeEventListener('document:updated', handleRefresh);
      window.removeEventListener('workspace:refresh', handleRefresh);
    };
  }, [fetchWorkspaceDocuments, workspaceId, nav]);

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
    const isAccessDenied = error.includes('Access denied');
    return (
      <div className={styles.container}>
        <div className={styles.content}>
          <h1 className={styles.heading}>{isAccessDenied ? 'Access Denied' : 'Workspace Error'}</h1>
          <p className={styles.description}>
            {error || 'The workspace you requested could not be loaded or you do not have permission to view it.'}
          </p>
          {workspaceId && !isAccessDenied && (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <Button variant="secondary" onClick={() => loadWorkspace(workspaceId)}>
                Retry
              </Button>
            </div>
          )}
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
              onClick={() => setIsCreateModalOpen(true)}
              aria-label="Create New Document"
            >
              + New Document
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

        {isCreateModalOpen && workspaceId && (
          <CreateDocumentModal
            workspaceId={workspaceId}
            isOpen={isCreateModalOpen}
            onClose={() => setIsCreateModalOpen(false)}
            onCreated={(newDoc) => {
              if (nav) {
                nav.addDocument(newDoc);
              } else {
                setLocalDocs((prev) => {
                  if (prev.some((d) => d.id === newDoc.id)) return prev;
                  return [newDoc, ...prev];
                });
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
