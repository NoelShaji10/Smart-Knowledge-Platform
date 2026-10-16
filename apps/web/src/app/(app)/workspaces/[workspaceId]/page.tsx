'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useDocumentNavigationOptional } from '@/contexts/DocumentNavigationContext';
import { api, Document, ApiError } from '@/lib/api';
import { Button, Skeleton, Badge, useToast } from '@/components/ui';
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

  // Loading skeleton state
  if ((loading && !activeWorkspace) || (docsLoading && documents.length === 0 && !docsError)) {
    return (
      <div className={styles.container}>
        <div className={styles.headerSection}>
          <div className={styles.headerLeft}>
            <Skeleton width={260} height={32} />
            <div style={{ marginTop: 'var(--space-2)' }}>
              <Skeleton width={380} height={18} />
            </div>
          </div>
          <Skeleton width={140} height={36} borderRadius={6} />
        </div>

        <div style={{ marginTop: 'var(--space-8)' }}>
          <Skeleton width={160} height={18} />
          <div className={styles.skeletonGrid}>
            <Skeleton height={110} borderRadius={8} />
            <Skeleton height={110} borderRadius={8} />
            <Skeleton height={110} borderRadius={8} />
            <Skeleton height={110} borderRadius={8} />
          </div>
        </div>
      </div>
    );
  }

  // Workspace-level error
  if (error && !activeWorkspace) {
    const isAccessDenied = error.includes('Access denied');
    return (
      <div className={styles.container}>
        <div className={styles.errorCard}>
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

  // Document loading error
  if (docsError && documents.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.errorCard}>
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
      {refreshError && (
        <div className={styles.staleBanner} role="alert">
          <span>Could not refresh documents. Your last loaded data is still shown ({refreshError}).</span>
          <Button variant="secondary" size="sm" onClick={fetchWorkspaceDocuments}>
            Retry
          </Button>
        </div>
      )}

      {/* Workspace Header Section */}
      <div className={styles.headerSection}>
        <div className={styles.headerLeft}>
          <div className={styles.titleRow}>
            <h1 className={styles.heading}>
              {hasDocuments ? activeWorkspace?.name || 'Workspace Documents' : 'Your workspace is ready.'}
            </h1>
            {activeWorkspace?.slug && (
              <span className={styles.slugBadge}>@{activeWorkspace.slug}</span>
            )}
            {userRole && (
              <Badge variant={userRole}>{userRole}</Badge>
            )}
          </div>
          <p className={styles.description}>
            {hasDocuments
              ? 'Select a document from the navigation or create a new one.'
              : isViewer
              ? 'This workspace currently has no active documents.'
              : 'Create your first document to start writing.'}
          </p>
          {hasDocuments && (
            <div className={styles.metaRow}>
              <span className={styles.metaItem}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span>{documents.length} {documents.length === 1 ? 'document' : 'documents'}</span>
              </span>
            </div>
          )}
        </div>

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
      </div>

      {/* Main Content: Grid or Empty State */}
      {hasDocuments ? (
        <section className={styles.docListSection} aria-label="Recent documents">
          <div className={styles.sectionHeaderRow}>
            <h2 className={styles.sectionTitle}>Recent Documents</h2>
            <span className={styles.docCountBadge}>{documents.length}</span>
          </div>

          <ul className={styles.docGrid}>
            {documents.map((doc) => (
              <li key={doc.id} className={styles.docGridItem}>
                <Link
                  href={`/workspaces/${workspaceId}/documents/${doc.id}`}
                  className={styles.docCard}
                >
                  <div className={styles.cardHeader}>
                    <div className={styles.docIconWrapper} aria-hidden="true">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="16" y1="13" x2="8" y2="13" />
                        <line x1="16" y1="17" x2="8" y2="17" />
                        <polyline points="10 9 9 9 8 9" />
                      </svg>
                    </div>
                    <span className={styles.cardTitle} title={doc.title || 'Untitled Document'}>
                      {doc.title || 'Untitled Document'}
                    </span>
                  </div>

                  <div className={styles.cardFooter}>
                    <span className={styles.docMeta}>
                      Updated {new Date(doc.updated_at).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </span>
                    <span className={styles.cardArrow} aria-hidden="true">
                      &rarr;
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <div className={styles.emptyStateCard}>
          <div className={styles.emptyIconWrapper} aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="12" y1="18" x2="12" y2="12" />
              <line x1="9" y1="15" x2="15" y2="15" />
            </svg>
          </div>
          <h2 className={styles.emptyTitle}>No documents yet</h2>
          <p className={styles.emptySubtext}>
            {isViewer
              ? 'This workspace currently has no active documents.'
              : 'Create your first document to start writing.'}
          </p>
          {canCreate && (
            <Button
              variant="primary"
              onClick={() => setIsCreateModalOpen(true)}
              aria-label="Create New Document"
            >
              + New Document
            </Button>
          )}
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
  );
}
