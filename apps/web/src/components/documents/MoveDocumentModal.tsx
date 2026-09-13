'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { api, Document, ApiError } from '@/lib/api';
import { Button, useToast } from '@/components/ui';
import styles from './MoveDocumentModal.module.css';

export interface MoveDocumentModalProps {
  workspaceId: string;
  document: Document;
  documents: Document[];
  isOpen: boolean;
  onClose: () => void;
  onMoved: (movedDoc: Document) => void;
}

interface ParentOption {
  id: string | null;
  label: string;
  disabled: boolean;
}

/**
 * Recursively find all descendant document IDs of a given document.
 */
function getDescendantIds(targetId: string, allDocs: Document[]): Set<string> {
  const descendants = new Set<string>();
  const toVisit = [targetId];
  while (toVisit.length > 0) {
    const current = toVisit.pop()!;
    for (const d of allDocs) {
      if (d.parent_id === current && !descendants.has(d.id)) {
        descendants.add(d.id);
        toVisit.push(d.id);
      }
    }
  }
  return descendants;
}

export function MoveDocumentModal({
  workspaceId,
  document: docToMove,
  documents,
  isOpen,
  onClose,
  onMoved,
}: MoveDocumentModalProps) {
  const { showToast } = useToast();
  const [selectedParentId, setSelectedParentId] = useState<string | null>(docToMove.parent_id);
  const [submitting, setSubmitting] = useState(false);

  // Synchronize initial selection if docToMove changes
  useEffect(() => {
    setSelectedParentId(docToMove.parent_id);
  }, [docToMove.parent_id]);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Compute descendant IDs to prevent cycle creation
  const descendantIds = useMemo(() => {
    return getDescendantIds(docToMove.id, documents);
  }, [docToMove.id, documents]);

  // Build sorted, indented options list
  const parentOptions = useMemo((): ParentOption[] => {
    const activeDocs = documents.filter((d) => !d.is_archived);

    // Map children
    const childrenMap = new Map<string | null, Document[]>();
    for (const d of activeDocs) {
      const pId = d.parent_id || null;
      if (!childrenMap.has(pId)) {
        childrenMap.set(pId, []);
      }
      childrenMap.get(pId)!.push(d);
    }

    const options: ParentOption[] = [
      {
        id: null,
        label: 'Root Level (Top Level / No Parent)',
        disabled: false,
      },
    ];

    function traverse(parentId: string | null, depth: number) {
      const children = childrenMap.get(parentId) || [];
      for (const child of children) {
        const isSelf = child.id === docToMove.id;
        const isDescendant = descendantIds.has(child.id);
        const prefix = depth > 0 ? `${'— '.repeat(depth)}` : '';

        options.push({
          id: child.id,
          label: `${prefix}${child.title || 'Untitled Document'}${isSelf ? ' (Current Document)' : isDescendant ? ' (Descendant - Cycle)' : ''}`,
          disabled: isSelf || isDescendant,
        });

        traverse(child.id, depth + 1);
      }
    }

    traverse(null, 0);
    return options;
  }, [documents, docToMove.id, descendantIds]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // If unchanged, simply close
    if (selectedParentId === docToMove.parent_id) {
      onClose();
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.moveDocument(workspaceId, docToMove.id, selectedParentId);
      showToast('Document moved successfully', 'success');
      onMoved(res.document);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showToast('Access denied: You do not have permission to move this document', 'error');
      } else if (err instanceof ApiError) {
        showToast(err.message || 'Failed to move document', 'error');
      } else if (err instanceof Error) {
        showToast(err.message || 'Failed to move document', 'error');
      } else {
        showToast('Failed to move document', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-doc-title"
      >
        <div className={styles.header}>
          <h2 id="move-doc-title" className={styles.title}>
            Move Document
          </h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>

        <div className={styles.docInfo}>
          Moving: <span className={styles.docName}>{docToMove.title || 'Untitled Document'}</span>
        </div>

        <form onSubmit={handleSubmit} className={styles.formSection}>
          <label htmlFor="move-parent-select" className={styles.label}>
            Select Destination Parent:
          </label>

          <select
            id="move-parent-select"
            className={styles.select}
            value={selectedParentId || 'root'}
            onChange={(e) => {
              const val = e.target.value;
              setSelectedParentId(val === 'root' ? null : val);
            }}
            disabled={submitting}
          >
            {parentOptions.map((opt, idx) => (
              <option
                key={opt.id || `root-${idx}`}
                value={opt.id || 'root'}
                disabled={opt.disabled}
              >
                {opt.label}
              </option>
            ))}
          </select>

          <p className={styles.hint}>
            Documents cannot be moved under themselves or any of their descendants.
          </p>

          <div className={styles.actions}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={submitting}
            >
              {submitting ? 'Moving...' : 'Move Document'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
