'use client';

import React, { useRef, ReactNode } from 'react';
import { Button } from '@/components/ui';
import { useModalFocus } from './useModalFocus';
import styles from './ConfirmationModal.module.css';

export interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description: ReactNode;
  warningNote?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: 'primary' | 'danger';
  loading?: boolean;
}

export function ConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  warningNote,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  loading = false,
}: ConfirmationModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  useModalFocus({
    isOpen,
    modalRef,
    onClose: loading ? undefined : onClose,
    disabled: loading,
  });

  if (!isOpen) return null;

  return (
    <div
      className={styles.backdrop}
      onClick={() => {
        if (!loading) onClose();
      }}
      role="presentation"
    >
      <div
        ref={modalRef}
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        tabIndex={-1}
      >
        <div className={styles.header}>
          <h2 id="confirm-modal-title" className={styles.title}>
            {title}
          </h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            disabled={loading}
            aria-label="Close dialog"
          >
            &times;
          </button>
        </div>

        <div className={styles.content}>
          {typeof description === 'string' ? <p>{description}</p> : description}

          {warningNote && (
            <div className={styles.warningBox} role="alert">
              <svg
                className={styles.warningIcon}
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div>{warningNote}</div>
            </div>
          )}
        </div>

        <div className={styles.actions}>
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={loading}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
