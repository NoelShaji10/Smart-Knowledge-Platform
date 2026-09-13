'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { api, Document, ApiError } from '@/lib/api';
import { Skeleton, Button, Dropdown, DropdownItem, useToast } from '@/components/ui';
import { MoveDocumentModal } from './MoveDocumentModal';
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
  isViewer: boolean;
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
  isViewer,
}: TreeNodeProps) {
  const children = childrenMap.get(document.id) || [];
  const hasChildren = children.length > 0;
  const isExpanded = expandedNodeIds.has(document.id);
  const isActive = currentDocId === document.id;
  const isRenaming = renamingDocId === document.id;

  const menuItems = useMemo((): DropdownItem[] => {
    if (isViewer) return [];
    return [
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
    ];
  }, [isViewer, document, onAddSubDocument, onStartRename, onStartMove, onArchive]);

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
            >
              {document.title || 'Untitled Document'}
            </Link>
          )}
        </div>

        {!isViewer && !isRenaming && (
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
              isViewer={isViewer}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function DocumentTree() {
  const pathname = usePathname();
  const router = useRouter();
  const { activeWorkspace, userRole } = useWorkspace();
  const { showToast } = useToast();

  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Expansion state
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());
  const [archivedExpanded, setArchivedExpanded] = useState(false);

  // Inline rename state
  const [renamingDocId, setRenamingDocId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Move document state
  const [movingDoc, setMovingDoc] = useState<Document | null>(null);

  // Restoring state tracking
  const [restoringDocId, setRestoringDocId] = useState<string | null>(null);

  const isViewer = userRole === 'viewer';

  // Extract selected document ID from route /workspaces/[workspaceId]/documents/[documentId]
  const match = pathname?.match(/\/documents\/([a-zA-Z0-9-]+)/);
  const currentDocId = match ? match[1] : null;

  const fetchDocuments = useCallback(async () => {
    if (!activeWorkspace) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.listDocuments(activeWorkspace.id, { includeArchived: true });
      setDocuments(res.documents);

      // Auto-expand ancestors of active documents
      setExpandedNodeIds((prev) => {
        const next = new Set(prev);
        for (const doc of res.documents) {
          if (doc.parent_id) {
            next.add(doc.parent_id);
          }
        }
        return next;
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        setError('Unable to connect to server. Document tree offline.');
        showToast('Unable to connect to server. Document tree offline.', 'error');
      } else if (err instanceof ApiError && err.status >= 500) {
        setError('Unable to load documents from server (Server Error).');
        showToast('Unable to load document navigation from server.', 'error');
      } else if (err instanceof ApiError) {
        setError(err.message || 'Failed to load documents');
        showToast(err.message || 'Failed to load documents', 'error');
      } else {
        setError('Failed to load documents');
        showToast('Failed to load document navigation', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [activeWorkspace, showToast]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  // Synchronize externally triggered document updates (e.g. from DocumentEditor or DocumentHeader)
  useEffect(() => {
    function handleDocUpdated(e: Event) {
      const customEvt = e as CustomEvent<{ document: Document }>;
      if (customEvt.detail?.document) {
        const updated = customEvt.detail.document;
        setDocuments((prev) => {
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
  }, []);

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

  const handleCreateDocument = async (parentId: string | null = null) => {
    if (!activeWorkspace || isViewer) return;
    setCreating(true);
    try {
      const res = await api.createDocument(activeWorkspace.id, {
        title: 'Untitled Document',
        parentId,
      });

      setDocuments((prev) => [...prev, res.document]);

      if (parentId) {
        setExpandedNodeIds((prev) => new Set(prev).add(parentId));
      }

      showToast('Document created', 'success');
      router.push(`/workspaces/${activeWorkspace.id}/documents/${res.document.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showToast('Access denied: You do not have permission to create documents in this workspace', 'error');
      } else if (err instanceof ApiError) {
        showToast(err.message || 'Failed to create document', 'error');
      } else {
        showToast('Failed to create document', 'error');
      }
    } finally {
      setCreating(false);
    }
  };

  const handleStartRename = (doc: Document) => {
    if (isViewer) return;
    setRenamingDocId(doc.id);
    setRenameValue(doc.title || 'Untitled Document');
  };

  const handleRenameCancel = () => {
    setRenamingDocId(null);
    setRenameValue('');
  };

  const handleRenameCommit = async (doc: Document) => {
    if (!activeWorkspace || !renamingDocId || isViewer) return;

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

      setDocuments((prev) => prev.map((d) => (d.id === doc.id ? res.document : d)));
      showToast('Document renamed', 'success');

      // Dispatch global sync event for active editor
      window.dispatchEvent(
        new CustomEvent('document:updated', { detail: { document: res.document } }),
      );
    } catch (err) {
      showToast('Failed to rename document', 'error');
      // Revert title in state to ensure truthfulness
      setDocuments((prev) => prev.map((d) => (d.id === doc.id ? { ...d, title: originalTitle } : d)));
    }
  };

  const handleArchive = async (doc: Document) => {
    if (!activeWorkspace || isViewer) return;
    try {
      const res = await api.archiveDocument(activeWorkspace.id, doc.id);
      setDocuments((prev) => prev.map((d) => (d.id === doc.id ? res.document : d)));
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
    }
  };

  const handleRestore = async (doc: Document) => {
    if (!activeWorkspace || isViewer) return;
    setRestoringDocId(doc.id);
    try {
      const res = await api.restoreDocument(activeWorkspace.id, doc.id);
      setDocuments((prev) => prev.map((d) => (d.id === doc.id ? res.document : d)));

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

  // Build tree hierarchy map for active documents
  const childrenMap = useMemo(() => {
    const map = new Map<string | null, Document[]>();
    for (const doc of activeDocuments) {
      const pId = doc.parent_id || null;
      if (!map.has(pId)) {
        map.set(pId, []);
      }
      map.get(pId)!.push(doc);
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
        {!isViewer && (
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.addBtn}
              onClick={() => handleCreateDocument(null)}
              disabled={creating}
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

      {/* Explicit Error State with Retry Button */}
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
          {!isViewer && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={styles.emptyCtaBtn}
              onClick={() => handleCreateDocument(null)}
              disabled={creating}
            >
              + Create your first document
            </Button>
          )}
        </div>
      ) : (
        /* Active Document Tree */
        <>
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
                  onAddSubDocument={(parentId) => handleCreateDocument(parentId)}
                  onStartRename={handleStartRename}
                  onStartMove={(d) => setMovingDoc(d)}
                  onArchive={handleArchive}
                  renamingDocId={renamingDocId}
                  renameValue={renameValue}
                  onRenameChange={setRenameValue}
                  onRenameCommit={handleRenameCommit}
                  onRenameCancel={handleRenameCancel}
                  isViewer={isViewer}
                />
              ))}
            </ul>
          )}

          {/* Bottom create button */}
          {!isViewer && (
            <button
              type="button"
              className={styles.newDocBtn}
              onClick={() => handleCreateDocument(null)}
              disabled={creating}
              aria-label="Create Document"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>{creating ? 'Creating...' : '+ New Document'}</span>
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
                    >
                      {doc.title || 'Untitled Document'}
                    </Link>
                    {!isViewer && (
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

      {/* Move Document Modal */}
      {movingDoc && activeWorkspace && (
        <MoveDocumentModal
          workspaceId={activeWorkspace.id}
          document={movingDoc}
          documents={activeDocuments}
          isOpen={true}
          onClose={() => setMovingDoc(null)}
          onMoved={(updatedDoc) => {
            setDocuments((prev) => prev.map((d) => (d.id === updatedDoc.id ? updatedDoc : d)));
            if (updatedDoc.parent_id) {
              setExpandedNodeIds((prev) => new Set(prev).add(updatedDoc.parent_id!));
            }
          }}
        />
      )}
    </div>
  );
}
