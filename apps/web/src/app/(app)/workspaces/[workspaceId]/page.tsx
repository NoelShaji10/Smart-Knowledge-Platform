'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useDocumentNavigationOptional } from '@/contexts/DocumentNavigationContext';
import { api, Document, ApiError } from '@/lib/api';
import { Button, Skeleton, Badge, useToast } from '@/components/ui';
import { CreateDocumentModal } from '@/components/documents/CreateDocumentModal';
import { StatsCard } from '@/components/dashboard/StatsCard';
import { DocumentCard } from '@/components/dashboard/DocumentCard';
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
  const [filterText, setFilterText] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [membersCount, setMembersCount] = useState<number | null>(null);

  const canCreate = userRole === 'owner' || userRole === 'admin' || userRole === 'editor';
  const canManageMembers = userRole === 'owner' || userRole === 'admin';
  const isViewer = userRole === 'viewer';

  const documents = nav ? nav.activeDocuments : localDocs;
  const docsLoading = nav ? nav.loading : localDocsLoading;
  const docsError = nav ? nav.error : localDocsError;

  useEffect(() => {
    if (workspaceId) {
      loadWorkspace(workspaceId);
    }
  }, [workspaceId, loadWorkspace]);

  // Fetch member count non-blockingly for real dashboard stats
  useEffect(() => {
    if (!workspaceId) return;
    const fetchMembers = api.listWorkspaceMembers || api.getWorkspaceMembers;
    if (typeof fetchMembers !== 'function') return;

    let active = true;
    try {
      const promise = fetchMembers(workspaceId);
      if (promise && typeof promise.then === 'function') {
        promise
          .then((res) => {
            if (active && res?.members) {
              setMembersCount(res.members.length);
            }
          })
          .catch(() => {
            if (active) setMembersCount(null);
          });
      }
    } catch {
      if (active) setMembersCount(null);
    }
    return () => {
      active = false;
    };
  }, [workspaceId]);

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

  // Derived metrics from real data
  const recentUpdatesCount = useMemo(() => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return documents.filter((d) => new Date(d.updated_at).getTime() >= sevenDaysAgo).length;
  }, [documents]);

  // Filtered documents for client-side search
  const filteredDocuments = useMemo(() => {
    if (!filterText.trim()) return documents;
    const q = filterText.toLowerCase();
    return documents.filter(
      (d) =>
        d.title?.toLowerCase().includes(q) ||
        d.content_text?.toLowerCase().includes(q),
    );
  }, [documents, filterText]);

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

        <div className={styles.statsGrid}>
          <Skeleton height={80} borderRadius={12} />
          <Skeleton height={80} borderRadius={12} />
          <Skeleton height={80} borderRadius={12} />
        </div>

        <div style={{ marginTop: 'var(--space-8)' }}>
          <Skeleton width={160} height={18} />
          <div className={styles.skeletonGrid}>
            <Skeleton height={130} borderRadius={12} />
            <Skeleton height={130} borderRadius={12} />
            <Skeleton height={130} borderRadius={12} />
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
          <div style={{ marginTop: 'var(--space-4)', display: 'flex', gap: 'var(--space-2)' }}>
            {workspaceId && !isAccessDenied && (
              <Button variant="secondary" onClick={() => loadWorkspace(workspaceId)}>
                Retry
              </Button>
            )}
            <Button variant={isAccessDenied ? 'primary' : 'secondary'} onClick={() => router.push('/')}>
              Back to Workspaces
            </Button>
          </div>
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
      <section className={styles.headerSection} aria-label="Workspace overview">
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
              ? 'Select a document from the navigation or create a new one to begin capturing institutional knowledge and architectural specs.'
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
              <span className={styles.metaBullet}>•</span>
              <span className={styles.metaItem}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>Internal Workspace</span>
              </span>
            </div>
          )}
        </div>

        <div className={styles.actions}>
          <Link href={`/workspaces/${activeWorkspace?.id || workspaceId}/members`}>
            <Button
              variant="secondary"
              aria-label={canManageMembers ? 'Manage Members' : 'Workspace Members'}
            >
              {canManageMembers ? 'Manage Members' : 'Members'}
            </Button>
          </Link>
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
      </section>

      {/* Real Statistics Section */}
      {hasDocuments && (
        <section className={styles.statsSection} aria-label="Workspace metrics">
          <div className={styles.statsGrid}>
            <StatsCard
              label="Total Documents"
              value={documents.length}
              subtext="Active in knowledge base"
              icon={
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              }
            />
            <StatsCard
              label="Active Members"
              value={membersCount !== null ? membersCount : '—'}
              subtext="Workspace collaborators"
              icon={
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              }
            />
            <StatsCard
              label="Recent Updates"
              value={recentUpdatesCount}
              subtext="Changed in past 7 days"
              badge={recentUpdatesCount > 0 ? `${recentUpdatesCount} active` : undefined}
              icon={
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              }
            />
          </div>
        </section>
      )}

      {/* Main Content: Grid or Empty State */}
      {hasDocuments ? (
        <section className={styles.docListSection} aria-label="Recent documents">
          <div className={styles.sectionHeaderRow}>
            <div className={styles.sectionTitleGroup}>
              <h2 className={styles.sectionTitle}>Recent Documents</h2>
              <span className={styles.docCountBadge}>{documents.length}</span>
            </div>

            <div className={styles.sectionControls}>
              <div className={styles.filterWrapper}>
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={styles.filterIcon}
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  className={styles.filterInput}
                  placeholder="Filter recent docs..."
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  aria-label="Filter documents by title"
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

              <div className={styles.viewToggle} role="group" aria-label="View mode">
                <button
                  type="button"
                  className={`${styles.viewBtn} ${viewMode === 'grid' ? styles.viewBtnActive : ''}`}
                  onClick={() => setViewMode('grid')}
                  title="Grid view"
                  aria-label="Grid view"
                  aria-pressed={viewMode === 'grid'}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                  </svg>
                </button>
                <button
                  type="button"
                  className={`${styles.viewBtn} ${viewMode === 'list' ? styles.viewBtnActive : ''}`}
                  onClick={() => setViewMode('list')}
                  title="List view"
                  aria-label="List view"
                  aria-pressed={viewMode === 'list'}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="8" y1="6" x2="21" y2="6" />
                    <line x1="8" y1="12" x2="21" y2="12" />
                    <line x1="8" y1="18" x2="21" y2="18" />
                    <line x1="3" y1="6" x2="3.01" y2="6" />
                    <line x1="3" y1="12" x2="3.01" y2="12" />
                    <line x1="3" y1="18" x2="3.01" y2="18" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          {filteredDocuments.length > 0 ? (
            <ul className={viewMode === 'grid' ? styles.docGrid : styles.docList}>
              {filteredDocuments.map((doc) => (
                <li key={doc.id} className={styles.docItem}>
                  <DocumentCard
                    document={doc}
                    workspaceId={workspaceId || activeWorkspace?.id || ''}
                    viewMode={viewMode}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <div className={styles.filterEmptyState}>
              <p>No documents matching &ldquo;{filterText}&rdquo;</p>
              <Button variant="secondary" size="sm" onClick={() => setFilterText('')}>
                Clear filter
              </Button>
            </div>
          )}
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
