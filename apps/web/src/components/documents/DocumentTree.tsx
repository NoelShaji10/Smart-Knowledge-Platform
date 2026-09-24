import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import {
  computeAncestors,
  useDocumentNavigationOptional,
} from '@/contexts/DocumentNavigationContext';
import { api, Document, ApiError } from '@/lib/api';
import { Skeleton, Button, Dropdown, DropdownItem, useToast } from '@/components/ui';
import { MoveDocumentModal } from './MoveDocumentModal';
import { CreateDocumentModal } from './CreateDocumentModal';
import styles from './DocumentTree.module.css';

interface TreeNodeProps {
  document: Document;
  childrenMap: Map<string | null, Document[]>;
  workspaceId: string;
  currentDocId: string | null;
  expandedNodeIds: Set<string>;
  onToggleExpand: (docId: string) => void;
  onAddSubDocument: (parentId: string) => void;
  onStartRename: (doc: Document) => void;
  onStartMove: (doc: Document) => void;
  onArchive: (doc: Document) => void;
  renamingDocId: string | null;
  renameValue: string;
  onRenameChange: (val: string) => void;
  onRenameCommit: (doc: Document) => void;
  onRenameCancel: () => void;
  canManage: boolean;
  canArchive: boolean;
  onNavigate?: () => void;
}

function TreeNode({
  document,
  childrenMap,
  workspaceId,
  currentDocId,
  expandedNodeIds,
  onToggleExpand,
  onAddSubDocument,
  onStartRename,
  onStartMove,
  onArchive,
  renamingDocId,
  renameValue,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  canManage,
  canArchive,
  onNavigate,
}: TreeNodeProps) {
  const children = childrenMap.get(document.id) || [];
  const hasChildren = children.length > 0;
  const isExpanded = expandedNodeIds.has(document.id);
  const isActive = currentDocId === document.id;
  const isRenaming = renamingDocId === document.id;

  const menuItems = useMemo((): DropdownItem[] => {
    if (!canManage) return [];
    const items: DropdownItem[] = [
      {
        id: 'add-sub',
        label: 'Add sub-document',
        onClick: () => onAddSubDocument(document.id),
      },
      {
        id: 'rename',
        label: 'Rename',
        onClick: () => onStartRename(document),
      },
      {
        id: 'move',
        label: 'Move to...',
        onClick: () => onStartMove(document),
      },
    ];

    if (canArchive) {
      items.push(
        {
          id: 'divider-1',
          label: '',
          divider: true,
        },
        {
          id: 'archive',
          label: 'Archive',
          danger: true,
          onClick: () => onArchive(document),
        },
      );
    }

    return items;
  }, [canManage, canArchive, document, onAddSubDocument, onStartRename, onStartMove, onArchive]);

  return (
    <li className={styles.treeNode}>
      <div className={`${styles.nodeItem} ${isActive ? styles.nodeActive : ''}`}>
        <div className={styles.nodeLeft}>
          {hasChildren ? (
            <button
              type="button"
              className={styles.caretBtn}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggleExpand(document.id);
              }}
              aria-label={isExpanded ? 'Collapse sub-documents' : 'Expand sub-documents'}
              aria-expanded={isExpanded}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{
                  transform: isExpanded ? 'rotate(90deg)' : 'none',
                  transition: 'transform 0.15s ease',
                }}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          ) : (
            <span style={{ width: 16, flexShrink: 0 }} />
          )}

          {isRenaming ? (
            <input
              type="text"
              className={styles.renameInput}
              value={renameValue}
              onChange={(e) => onRenameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onRenameCommit(document);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  onRenameCancel();
                }
              }}
              onBlur={() => onRenameCommit(document)}
              autoFocus
              aria-label="Rename document title"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <Link
              href={`/workspaces/${workspaceId}/documents/${document.id}`}
              className={styles.docTitle}
              title={document.title || 'Untitled Document'}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => onNavigate?.()}
            >
              {document.title || 'Untitled Document'}
            </Link>
          )}
        </div>

        {canManage && !isRenaming && (
          <div className={styles.nodeActions}>
            <button
              type="button"
              className={styles.actionBtn}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onAddSubDocument(document.id);
              }}
              title="Add sub-document"
              aria-label="Add sub-document"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>

            <Dropdown
              trigger={
                <span className={styles.actionBtn} title="More actions" aria-label="More actions">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="1" />
                    <circle cx="12" cy="5" r="1" />
                    <circle cx="12" cy="19" r="1" />
                  </svg>
                </span>
              }
              items={menuItems}
              align="right"
            />
          </div>
        )}
      </div>

      {hasChildren && isExpanded && (
        <ul className={styles.nodeChildren}>
          {children.map((child) => (
            <TreeNode
              key={child.id}
              document={child}
              childrenMap={childrenMap}
              workspaceId={workspaceId}
              currentDocId={currentDocId}
              expandedNodeIds={expandedNodeIds}
              onToggleExpand={onToggleExpand}
              onAddSubDocument={onAddSubDocument}
              onStartRename={onStartRename}
              onStartMove={onStartMove}
              onArchive={onArchive}
              renamingDocId={renamingDocId}
              renameValue={renameValue}
              onRenameChange={onRenameChange}
              onRenameCommit={onRenameCommit}
              onRenameCancel={onRenameCancel}
              canManage={canManage}
              canArchive={canArchive}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export interface DocumentTreeProps {
  onNavigate?: () => void;
}

export function DocumentTree({ onNavigate }: DocumentTreeProps = {}) {
  const pathname = usePathname();
  const router = useRouter();
  const { activeWorkspace, userRole } = useWorkspace();
  const { showToast } = useToast();
  const nav = useDocumentNavigationOptional();

  // Local state fallback when nav context is not present (e.g. standalone test)
  const [localDocs, setLocalDocs] = useState<Document[]>([]);
  const [localLoading, setLocalLoading] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);

  const documents = nav ? nav.documents : localDocs;
  const loading = nav ? nav.loading : localLoading;
  const error = nav ? nav.error : localError;

  // Create document modal state
  const [createModal, setCreateModal] = useState<{
    isOpen: boolean;
    parentId: string | null;
    parentTitle?: string | null;
  }>({
    isOpen: false,
    parentId: null,
  });

  // Expansion state
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());
  const [archivedExpanded, setArchivedExpanded] = useState(false);

  // Inline rename state
  const [renamingDocId, setRenamingDocId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Move document state
  const [movingDoc, setMovingDoc] = useState<Document | null>(null);

  // Restoring / Archiving state tracking
  const [restoringDocId, setRestoringDocId] = useState<string | null>(null);
  const [archivingDocId, setArchivingDocId] = useState<string | null>(null);

  const canManage = userRole === 'owner' || userRole === 'admin' || userRole === 'editor';
  const canArchive = userRole === 'owner' || userRole === 'admin';
  const isViewer = userRole === 'viewer' || !canManage;

  // Extract selected document ID from route /workspaces/[workspaceId]/documents/[documentId]
  const match = pathname?.match(/\/documents\/([a-zA-Z0-9-]+)/);
  const currentDocId = match ? match[1] : null;

  // Auto-expand ancestors of active document whenever currentDocId or documents change
  useEffect(() => {
    if (!currentDocId || documents.length === 0) return;
    const ancestors = computeAncestors(currentDocId, documents);
    if (ancestors.length > 0) {
      setExpandedNodeIds((prev) => {
        let changed = false;
        const next = new Set(prev);
        for (const a of ancestors) {
          if (!next.has(a.id)) {
            next.add(a.id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
  }, [currentDocId, documents]);

  // Auto-expand parents on initial load of documents
  const hasInitializedExpansionRef = useRef(false);
  useEffect(() => {
    if (documents.length > 0 && !hasInitializedExpansionRef.current) {
      hasInitializedExpansionRef.current = true;
      setExpandedNodeIds((prev) => {
        const next = new Set(prev);
        for (const doc of documents) {
          if (doc.parent_id && !doc.is_archived) {
            next.add(doc.parent_id);
          }
        }
        return next;
      });
    }
  }, [documents]);

  // Reset expansion and state when active workspace changes
  const lastWsIdRef = useRef<string | null>(activeWorkspace?.id || null);
  useEffect(() => {
    if (activeWorkspace?.id !== lastWsIdRef.current) {
      lastWsIdRef.current = activeWorkspace?.id || null;
      hasInitializedExpansionRef.current = false;
      setExpandedNodeIds(new Set());
      setRenamingDocId(null);
      if (!nav) {
        setLocalDocs([]);
      }
    }
  }, [activeWorkspace?.id, nav]);

  const fetchDocuments = useCallback(async () => {
    if (nav) {
      return nav.refreshDocuments();
    }
    if (!activeWorkspace) return;
    setLocalLoading(true);
    setLocalError(null);
    try {
      const res = await api.listDocuments(activeWorkspace.id, { includeArchived: true });
      setLocalDocs(res.documents);
      setExpandedNodeIds((prev) => {
        const next = new Set(prev);
        for (const doc of res.documents) {
          if (doc.parent_id && !doc.is_archived) {
            next.add(doc.parent_id);
          }
        }
        return next;
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        setLocalError('Unable to connect to server. Document tree offline.');
        showToast('Unable to connect to server. Document tree offline.', 'error');
      } else if (err instanceof ApiError && err.status >= 500) {
        setLocalError('Unable to load documents from server (Server Error).');
        showToast('Unable to load document navigation from server.', 'error');
      } else if (err instanceof ApiError) {
        setLocalError(err.message || 'Failed to load documents');
        showToast(err.message || 'Failed to load documents', 'error');
      } else if (err instanceof Error) {
        setLocalError(err.message || 'Failed to load documents');
        showToast(err.message || 'Failed to load document navigation', 'error');
      } else {
        setLocalError('Failed to load documents');
        showToast('Failed to load document navigation', 'error');
      }
    } finally {
      setLocalLoading(false);
    }
  }, [activeWorkspace, nav, showToast]);

  useEffect(() => {
    if (!nav) {
      fetchDocuments();
    }
  }, [fetchDocuments, nav]);

  // Synchronize externally triggered document updates when running in local fallback mode
  useEffect(() => {
    if (nav || !activeWorkspace) return;
    const currentWorkspaceId = activeWorkspace.id;

    function handleDocUpdated(e: Event) {
      const customEvt = e as CustomEvent<{ document: Document }>;
      if (customEvt.detail?.document) {
        const updated = customEvt.detail.document;
        // Verify the document belongs to the currently active workspace
        if (updated.workspace_id !== currentWorkspaceId) {
          return;
        }

        setLocalDocs((prev) => {
          const exists = prev.some((d) => d.id === updated.id);
          if (exists) {
            return prev.map((d) => (d.id === updated.id ? updated : d));
          }
          return [...prev, updated];
        });
      }
    }

    window.addEventListener('document:updated', handleDocUpdated);
    return () => window.removeEventListener('document:updated', handleDocUpdated);
  }, [activeWorkspace?.id, nav]);

  const toggleExpand = (docId: string) => {
    setExpandedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) {
        next.delete(docId);
      } else {
        next.add(docId);
      }
      return next;
    });
  };

  const openCreateModal = (parentId: string | null = null) => {
    if (!activeWorkspace || !canManage) return;
    const parentDoc = parentId ? documents.find((d) => d.id === parentId) : null;
    setCreateModal({
      isOpen: true,
      parentId,
      parentTitle: parentDoc?.title,
    });
  };

  const handleDocumentCreated = (newDoc: Document) => {
    if (nav) {
      nav.addDocument(newDoc);
    } else {
      setLocalDocs((prev) => {
        const exists = prev.some((d) => d.id === newDoc.id);
        if (exists) return prev;
        return [...prev, newDoc];
      });
    }
    if (newDoc.parent_id) {
      setExpandedNodeIds((prev) => new Set(prev).add(newDoc.parent_id!));
    }
  };

  const handleStartRename = (doc: Document) => {
    if (!canManage) return;
    setRenamingDocId(doc.id);
    setRenameValue(doc.title || 'Untitled Document');
  };

  const handleRenameCancel = () => {
    setRenamingDocId(null);
    setRenameValue('');
  };

  const handleRenameCommit = async (doc: Document) => {
    if (!activeWorkspace || !renamingDocId || !canManage) return;

    const trimmed = renameValue.trim() || 'Untitled Document';
    const originalTitle = doc.title;

    setRenamingDocId(null);

    // If unchanged, do nothing
    if (trimmed === originalTitle) {
      return;
    }

    try {
      const res = await api.updateDocument(activeWorkspace.id, doc.id, {
        title: trimmed,
      });

      if (nav) {
        nav.updateDocument(res.document);
      } else {
        setLocalDocs((prev) => prev.map((d) => (d.id === doc.id ? res.document : d)));
      }
      showToast('Document renamed', 'success');

      // Dispatch global sync event for active editor
      window.dispatchEvent(
        new CustomEvent('document:updated', { detail: { document: res.document } }),
      );
    } catch (err) {
      showToast('Failed to rename document', 'error');
      // Revert title in state to ensure truthfulness
      if (nav) {
        nav.updateDocument({ ...doc, title: originalTitle });
      } else {
        setLocalDocs((prev) => prev.map((d) => (d.id === doc.id ? { ...d, title: originalTitle } : d)));
      }
    }
  };

  const handleArchive = async (doc: Document) => {
    if (!activeWorkspace || !canArchive || archivingDocId === doc.id) return;
    setArchivingDocId(doc.id);
    try {
      const res = await api.archiveDocument(activeWorkspace.id, doc.id);
      if (nav) {
        nav.updateDocument(res.document);
      } else {
        setLocalDocs((prev) => prev.map((d) => (d.id === doc.id ? res.document : d)));
      }
      showToast('Document archived', 'info');

      // Dispatch global sync event
      window.dispatchEvent(
        new CustomEvent('document:updated', { detail: { document: res.document } }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showToast('Access denied: You do not have permission to archive this document', 'error');
      } else {
        showToast('Failed to archive document', 'error');
      }
    } finally {
      setArchivingDocId(null);
    }
  };

  const handleRestore = async (doc: Document) => {
    if (!activeWorkspace || !canArchive || restoringDocId === doc.id) return;
    setRestoringDocId(doc.id);
    try {
      const res = await api.restoreDocument(activeWorkspace.id, doc.id);
      if (nav) {
        nav.updateDocument(res.document);
      } else {
        setLocalDocs((prev) => prev.map((d) => (d.id === doc.id ? res.document : d)));
      }

      if (res.document.parent_id) {
        setExpandedNodeIds((prev) => new Set(prev).add(res.document.parent_id!));
      }

      showToast('Document restored', 'success');

      // Dispatch global sync event
      window.dispatchEvent(
        new CustomEvent('document:updated', { detail: { document: res.document } }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showToast('Access denied: You do not have permission to restore this document', 'error');
      } else {
        showToast('Failed to restore document', 'error');
      }
    } finally {
      setRestoringDocId(null);
    }
  };

  const activeDocuments = useMemo(() => {
    return documents.filter((d) => !d.is_archived);
  }, [documents]);

  const archivedDocuments = useMemo(() => {
    return documents.filter((d) => d.is_archived);
  }, [documents]);

  // Build tree hierarchy map for active documents.
  // Active documents whose parents are archived or missing are treated as root-level items.
  const childrenMap = useMemo(() => {
    const activeDocIdSet = new Set(activeDocuments.map((d) => d.id));
    const map = new Map<string | null, Document[]>();

    for (const doc of activeDocuments) {
      const effectiveParentId =
        doc.parent_id && activeDocIdSet.has(doc.parent_id) ? doc.parent_id : null;

      if (!map.has(effectiveParentId)) {
        map.set(effectiveParentId, []);
      }
      map.get(effectiveParentId)!.push(doc);
    }
    return map;
  }, [activeDocuments]);

  const rootDocuments = childrenMap.get(null) || [];

  if (loading && documents.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <span className={styles.title}>Documents</span>
        </div>
        <Skeleton height={26} width="100%" />
        <Skeleton height={26} width="80%" />
        <Skeleton height={26} width="90%" />
        <Skeleton height={26} width="70%" />
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>Documents</span>
        {canManage && (
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.addBtn}
              onClick={() => openCreateModal(null)}
              title="Create top-level document"
              aria-label="Create top-level document"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Explicit Error State with Retry Button for initial failure */}
      {error && documents.length === 0 ? (
        <div className={styles.errorState} role="alert">
          <span className={styles.errorText}>{error}</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={styles.retryBtn}
            onClick={fetchDocuments}
          >
            Retry
          </Button>
        </div>
      ) : activeDocuments.length === 0 && archivedDocuments.length === 0 ? (
        /* Explicit Empty State */
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>No documents in this workspace yet.</span>
          {canManage && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={styles.emptyCtaBtn}
              onClick={() => openCreateModal(null)}
            >
              + Create your first document
            </Button>
          )}
        </div>
      ) : (
        /* Active Document Tree */
        <>
          {error && documents.length > 0 && (
            <div className={styles.refreshErrorBanner} role="alert">
              <span className={styles.refreshErrorText}>
                Could not refresh documents. Your last loaded data is still shown.
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className={styles.retryBtn}
                onClick={fetchDocuments}
              >
                Retry
              </Button>
            </div>
          )}

          {rootDocuments.length === 0 && activeDocuments.length === 0 ? (
            <div className={styles.emptyText}>No active documents.</div>
          ) : (
            <ul className={styles.treeList}>
              {rootDocuments.map((doc) => (
                <TreeNode
                  key={doc.id}
                  document={doc}
                  childrenMap={childrenMap}
                  workspaceId={activeWorkspace?.id || ''}
                  currentDocId={currentDocId}
                  expandedNodeIds={expandedNodeIds}
                  onToggleExpand={toggleExpand}
                  onAddSubDocument={(parentId) => openCreateModal(parentId)}
                  onStartRename={handleStartRename}
                  onStartMove={(d) => setMovingDoc(d)}
                  onArchive={handleArchive}
                  renamingDocId={renamingDocId}
                  renameValue={renameValue}
                  onRenameChange={setRenameValue}
                  onRenameCommit={handleRenameCommit}
                  onRenameCancel={handleRenameCancel}
                  canManage={canManage}
                  canArchive={canArchive}
                  onNavigate={onNavigate}
                />
              ))}
            </ul>
          )}

          {/* Bottom create button */}
          {canManage && (
            <button
              type="button"
              className={styles.newDocBtn}
              onClick={() => openCreateModal(null)}
              aria-label="Create Document"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>+ New Document</span>
            </button>
          )}
        </>
      )}

      {/* Archived Documents Section */}
      {archivedDocuments.length > 0 && (
        <div className={styles.archivedSection}>
          <button
            type="button"
            className={styles.archivedHeader}
            onClick={() => setArchivedExpanded((prev) => !prev)}
            aria-expanded={archivedExpanded}
            aria-label="Toggle archived documents"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              style={{
                transform: archivedExpanded ? 'rotate(90deg)' : 'none',
                transition: 'transform 0.15s ease',
              }}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span>Archived ({archivedDocuments.length})</span>
          </button>

          {archivedExpanded && (
            <ul className={styles.archivedList}>
              {archivedDocuments.map((doc) => {
                const isActive = currentDocId === doc.id;
                const isRestoring = restoringDocId === doc.id;
                return (
                  <li
                    key={doc.id}
                    className={`${styles.archivedItem} ${isActive ? styles.archivedItemActive : ''}`}
                  >
                    <Link
                      href={`/workspaces/${activeWorkspace?.id || ''}/documents/${doc.id}`}
                      className={styles.archivedTitle}
                      title={`${doc.title || 'Untitled Document'} (Archived)`}
                      onClick={() => onNavigate?.()}
                    >
                      {doc.title || 'Untitled Document'}
                    </Link>
                    {canArchive && (
                      <button
                        type="button"
                        className={styles.restoreBtn}
                        onClick={() => handleRestore(doc)}
                        disabled={isRestoring}
                        aria-label={`Restore document ${doc.title}`}
                      >
                        {isRestoring ? 'Restoring...' : 'Restore'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Create Document Modal */}
      {createModal.isOpen && activeWorkspace && (
        <CreateDocumentModal
          workspaceId={activeWorkspace.id}
          parentId={createModal.parentId}
          parentTitle={createModal.parentTitle}
          isOpen={createModal.isOpen}
          onClose={() => setCreateModal({ isOpen: false, parentId: null })}
          onCreated={handleDocumentCreated}
        />
      )}

      {/* Move Document Modal */}
      {movingDoc && activeWorkspace && (
        <MoveDocumentModal
          workspaceId={activeWorkspace.id}
          document={movingDoc}
          documents={activeDocuments}
          isOpen={true}
          onClose={() => setMovingDoc(null)}
          onMoved={(updatedDoc) => {
            if (nav) {
              nav.updateDocument(updatedDoc);
            } else {
              setLocalDocs((prev) => prev.map((d) => (d.id === updatedDoc.id ? updatedDoc : d)));
            }
            if (updatedDoc.parent_id) {
              setExpandedNodeIds((prev) => new Set(prev).add(updatedDoc.parent_id!));
            }
          }}
        />
      )}
    </div>
  );
}
