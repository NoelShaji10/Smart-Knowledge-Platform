'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { api, Document, ApiError } from '@/lib/api';
import { Button, useToast } from '@/components/ui';
import styles from './CreateDocumentModal.module.css';

export interface CreateDocumentModalProps {
  workspaceId: string;
  parentId?: string | null;
  parentTitle?: string | null;
  isOpen: boolean;
  onClose: () => void;
  onCreated: (newDoc: Document) => void;
}

export function CreateDocumentModal({
  workspaceId,
  parentId = null,
  parentTitle = null,
  isOpen,
  onClose,
  onCreated,
}: CreateDocumentModalProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setError(null);
      setSubmitting(false);
      setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    const trimmed = title.trim();
    if (!trimmed) {
      setError('Document title cannot be empty');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await api.createDocument(workspaceId, {
        title: trimmed,
        parentId: parentId || null,
      });

      showToast('Document created', 'success');

      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('document:updated', { detail: { document: res.document } }),
        );
      }

      onCreated(res.document);
      onClose();
      router.push(`/workspaces/${workspaceId}/documents/${res.document.id}`);
    } catch (err) {
      let msg = 'Failed to create document';
      if (err instanceof ApiError && err.status === 403) {
        msg = 'Access denied: You do not have permission to create documents in this workspace';
      } else if (err instanceof ApiError) {
        msg = err.message || 'Failed to create document';
      } else if (err instanceof Error) {
        msg = err.message || 'Failed to create document';
      }
      setError(msg);
      showToast(msg, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const isSubDoc = Boolean(parentId);

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-doc-modal-title"
      >
        <div className={styles.header}>
          <h2 id="create-doc-modal-title" className={styles.title}>
            {isSubDoc ? 'Create Sub-document' : 'Create New Document'}
          </h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close dialog"
            disabled={submitting}
          >
            ×
          </button>
        </div>

        {isSubDoc && parentTitle && (
          <div className={styles.parentInfo}>
            Parent: <span className={styles.parentName}>{parentTitle}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className={styles.form}>
          <label htmlFor="create-doc-title-input" className={styles.label}>
            Document Title
          </label>

          <input
            ref={inputRef}
            id="create-doc-title-input"
            type="text"
            className={styles.input}
            placeholder="e.g. Project Roadmap"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (error) setError(null);
            }}
            disabled={submitting}
            aria-label="Document title"
            autoComplete="off"
          />

          {error && (
            <span className={styles.errorText} role="alert">
              {error}
            </span>
          )}

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
              {submitting ? 'Creating...' : 'Create Document'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
