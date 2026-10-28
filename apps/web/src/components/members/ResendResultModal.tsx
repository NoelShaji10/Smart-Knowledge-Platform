'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Button, useToast } from '@/components/ui';
import { WorkspaceInvitation } from '@/lib/api';
import { useModalFocus } from './useModalFocus';
import { buildInvitationUrl } from './invitationUtils';
import styles from './ResendResultModal.module.css';

export interface ResendResultModalProps {
  isOpen: boolean;
  onClose: () => void;
  invitation: WorkspaceInvitation | null;
  rawToken: string | null;
}

export function ResendResultModal({
  isOpen,
  onClose,
  invitation,
  rawToken,
}: ResendResultModalProps) {
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);
  const copyBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isOpen) {
      setCopied(false);
    }
  }, [isOpen]);

  useModalFocus({
    isOpen: Boolean(isOpen && invitation && rawToken),
    modalRef,
    initialFocusRef: copyBtnRef,
    onClose,
  });

  if (!isOpen || !invitation || !rawToken) return null;

  const invitationUrl = buildInvitationUrl(rawToken);

  const handleCopy = async () => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(invitationUrl);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = invitationUrl;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopied(true);
      showToast('Invitation link copied to clipboard', 'success');
      setTimeout(() => setCopied(false), 3000);
    } catch {
      showToast('Failed to copy to clipboard', 'error');
    }
  };

  const isEmailBound = Boolean(invitation.invitee_email);

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <div
        ref={modalRef}
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="resend-modal-title"
        tabIndex={-1}
      >
        <div className={styles.header}>
          <div className={styles.titleRow}>
            <svg
              className={styles.successIcon}
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <h2 id="resend-modal-title" className={styles.title}>
              New Invitation Link Generated
            </h2>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close dialog"
          >
            &times;
          </button>
        </div>

        <div className={styles.body}>
          <p>
            The previous invitation link has been <strong>permanently invalidated</strong>.
            A new secure invitation link has been created for role <strong>{invitation.role}</strong>.
          </p>

          <div className={styles.urlBox}>
            <input
              type="text"
              readOnly
              value={invitationUrl}
              className={styles.urlInput}
              aria-label="New invitation link"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            <Button
              ref={copyBtnRef}
              variant="secondary"
              size="sm"
              onClick={handleCopy}
              aria-label="Copy invitation link to clipboard"
            >
              {copied ? 'Copied!' : 'Copy Link'}
            </Button>
          </div>

          <div className={styles.infoBox}>
            <svg
              className={styles.infoIcon}
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <div>
              {isEmailBound ? (
                invitation.email_delivery_status === 'accepted_by_provider' ? (
                  <>
                    <strong>Email sent:</strong> A new invitation email has been sent to{' '}
                    <code>{invitation.invitee_email}</code>. The direct link is also available below if needed.
                  </>
                ) : invitation.email_delivery_status === 'failed' ||
                  invitation.email_delivery_status === 'permanently_failed' ? (
                  <>
                    <strong>Delivery failed:</strong> A new invitation was generated, but email delivery failed. Please copy and share the link manually.
                  </>
                ) : (
                  <>
                    <strong>Email queued:</strong> A fresh invitation email is being sent to{' '}
                    <code>{invitation.invitee_email}</code>. You can also share the direct link below.
                  </>
                )
              ) : (
                <>
                  <strong>Shareable link ready:</strong> A new shareable link has been generated. Copy and share it with your team member.
                </>
              )}
            </div>
          </div>

          {isEmailBound && (
            <div className={styles.warningBox}>
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
              <div>
                <strong>Email restriction:</strong> Only a user signed in with verified email{' '}
                <code>{invitation.invitee_email}</code> can accept this link. Acceptance remains
                blocked until authoritative email verification is configured.
              </div>
            </div>
          )}
        </div>

        <div className={styles.actions}>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
