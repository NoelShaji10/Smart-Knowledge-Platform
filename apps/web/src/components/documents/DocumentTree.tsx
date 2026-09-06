'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { api, Document, ApiError } from '@/lib/api';
import { Skeleton, useToast } from '@/components/ui';
import styles from './DocumentTree.module.css';

interface TreeNodeProps {
  document: Document;
  childrenMap: Map<string | null, Document[]>;
  workspaceId: string;
  currentDocId: string | null;
  onAddSubDocument: (parentId: string) => void;
}

function TreeNode({
  document,
  childrenMap,
  workspaceId,
  currentDocId,
  onAddSubDocument,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const children = childrenMap.get(document.id) || [];
  const hasChildren = children.length > 0;
  const isActive = currentDocId === document.id;

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
                setExpanded((prev) => !prev);
              }}
              aria-label={expanded ? 'Collapse sub-documents' : 'Expand sub-documents'}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s ease' }}
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          ) : (
            <span style={{ width: 16 }} />
          )}

          <Link
            href={`/workspaces/${workspaceId}/documents/${document.id}`}
            className={styles.docTitle}
            title={document.title}
          >
            {document.title || 'Untitled Document'}
          </Link>
        </div>

        <button
          type="button"
          className={styles.addBtn}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onAddSubDocument(document.id);
          }}
          title="Add sub-document"
          aria-label="Add sub-document"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {hasChildren && expanded && (
        <ul className={styles.nodeChildren}>
          {children.map((child) => (
            <TreeNode
              key={child.id}
              document={child}
              childrenMap={childrenMap}
              workspaceId={workspaceId}
              currentDocId={currentDocId}
              onAddSubDocument={onAddSubDocument}
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
  const { activeWorkspace } = useWorkspace();
  const { showToast } = useToast();

  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // Extract selected document ID from route /workspaces/[workspaceId]/documents/[documentId]
  const match = pathname?.match(/\/documents\/([a-zA-Z0-9-]+)/);
  const currentDocId = match ? match[1] : null;

  const fetchDocuments = useCallback(async () => {
    if (!activeWorkspace) return;
    setLoading(true);
    try {
      const res = await api.listDocuments(activeWorkspace.id, { includeArchived: false });
      setDocuments(res.documents);
    } catch (err) {
      setDocuments([]);
      if (err instanceof ApiError && err.status === 0) {
        showToast('Unable to connect to server. Document tree offline.', 'error');
      } else if (err instanceof ApiError && err.status >= 500) {
        showToast('Unable to load document navigation from server.', 'error');
      } else {
        showToast('Failed to load document navigation', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [activeWorkspace, showToast]);

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  const handleCreateDocument = async (parentId: string | null = null) => {
    if (!activeWorkspace) return;
    setCreating(true);
    try {
      const res = await api.createDocument(activeWorkspace.id, {
        title: 'Untitled Document',
        parentId,
      });
      setDocuments((prev) => [...prev, res.document]);
      router.push(`/workspaces/${activeWorkspace.id}/documents/${res.document.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showToast('Access denied: You do not have permission to create documents in this workspace', 'error');
      } else {
        showToast('Failed to create document', 'error');
      }
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <span className={styles.title}>Documents</span>
        </div>
        <Skeleton height={24} width="100%" />
        <Skeleton height={24} width="80%" />
        <Skeleton height={24} width="90%" />
      </div>
    );
  }

  // Build tree hierarchy map
  const childrenMap = new Map<string | null, Document[]>();
  for (const doc of documents) {
    const pId = doc.parent_id || null;
    if (!childrenMap.has(pId)) {
      childrenMap.set(pId, []);
    }
    childrenMap.get(pId)!.push(doc);
  }

  const rootDocuments = childrenMap.get(null) || [];

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>Documents</span>
        <button
          type="button"
          className={styles.addBtn}
          onClick={() => handleCreateDocument(null)}
          title="Create top-level document"
          aria-label="Create top-level document"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {rootDocuments.length === 0 ? (
        <div className={styles.emptyText}>No documents yet.</div>
      ) : (
        <ul className={styles.treeList}>
          {rootDocuments.map((doc) => (
            <TreeNode
              key={doc.id}
              document={doc}
              childrenMap={childrenMap}
              workspaceId={activeWorkspace?.id || ''}
              currentDocId={currentDocId}
              onAddSubDocument={(parentId) => handleCreateDocument(parentId)}
            />
          ))}
        </ul>
      )}

      <button
        type="button"
        className={styles.newDocBtn}
        onClick={() => handleCreateDocument(null)}
        disabled={creating}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span>{creating ? 'Creating...' : '+ New Document'}</span>
      </button>
    </div>
  );
}
