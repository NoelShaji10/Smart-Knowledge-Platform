'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Button, useToast } from '@/components/ui';
import { api, ApiError, WorkspaceInvitation } from '@/lib/api';
import { useModalFocus } from './useModalFocus';
import { buildInvitationUrl } from './invitationUtils';
import styles from './InviteMemberModal.module.css';

export interface InviteMemberModalProps {
  workspaceId: string;
  isOpen: boolean;
  onClose: () => void;
  onCreated: (invitation: WorkspaceInvitation, rawToken: string) => void;
  userRole: 'owner' | 'admin' | 'editor' | 'viewer' | null;
}

export function InviteMemberModal({
  workspaceId,
  isOpen,
  onClose,
  onCreated,
  userRole,
}: InviteMemberModalProps) {
  const { showToast } = useToast();

  const isOwner = userRole === 'owner';
  const isAdmin = userRole === 'admin';

  // State
  const [role, setRole] = useState<'admin' | 'editor' | 'viewer'>('viewer');
  const [email, setEmail] = useState('');
  const [expiresInDays, setExpiresInDays] = useState(7);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);

  // Success view state
  const [createdData, setCreatedData] = useState<{
    invitation: WorkspaceInvitation;
    rawToken: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const formModalRef = useRef<HTMLDivElement>(null);
  const successModalRef = useRef<HTMLDivElement>(null);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const copyBtnRef = useRef<HTMLButtonElement>(null);

  // Focus trap for initial form view
  useModalFocus({
    isOpen: isOpen && !createdData,
    modalRef: formModalRef,
    initialFocusRef: emailInputRef,
    onClose: submitting ? undefined : onClose,
    disabled: submitting,
  });

  // Focus trap for success/link-ready view
  useModalFocus({
    isOpen: isOpen && Boolean(createdData),
    modalRef: successModalRef,
    initialFocusRef: copyBtnRef,
    onClose,
  });

  // Reset modal state on open
  useEffect(() => {
    if (isOpen) {
      setRole('viewer');
      setEmail('');
      setExpiresInDays(7);
      setSubmitting(false);
      setError(null);
      setRateLimited(false);
      setCreatedData(null);
      setCopied(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    // RBAC validation: Admin cannot invite Admin
    if (isAdmin && role === 'admin') {
      setError('Only workspace owners can invite admin members');
      return;
    }

    setSubmitting(true);
    setError(null);
    setRateLimited(false);

    try {
      const trimmedEmail = email.trim() || null;
      const res = await api.createWorkspaceInvitation(workspaceId, {
        role,
        email: trimmedEmail,
        expiresInDays,
      });

      setCreatedData({
        invitation: res.invitation,
        rawToken: res.rawToken,
      });

      showToast('Invitation link generated', 'success');
      onCreated(res.invitation, res.rawToken);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setRateLimited(true);
        setError('Rate limit reached: Too many invitations created recently. Please wait before creating more.');
      } else if (err instanceof ApiError && err.status === 403) {
        setError(err.message || 'Access denied: You do not have permission to create this invitation');
      } else if (err instanceof ApiError) {
        setError(err.message || 'Failed to create invitation');
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('An unexpected error occurred while creating the invitation');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyLink = async () => {
    if (!createdData?.rawToken) return;

    const url = buildInvitationUrl(createdData.rawToken);

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = url;
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

  // If in created/success view
  if (createdData) {
    const isEmailBound = Boolean(createdData.invitation.invitee_email);
    const invitationUrl = buildInvitationUrl(createdData.rawToken);

    return (
      <div className={styles.backdrop} onClick={onClose} role="presentation">
        <div
          ref={successModalRef}
          className={styles.modal}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-labelledby="invite-success-title"
          tabIndex={-1}
        >
          <div className={styles.header}>
            <h2 id="invite-success-title" className={styles.title}>
              Invitation Link Created
            </h2>
            <button
              type="button"
              className={styles.closeBtn}
              onClick={onClose}
              aria-label="Close dialog"
            >
              &times;
            </button>
          </div>

          <div className={styles.successBody}>
            <p>
              Your invitation for role <strong>{createdData.invitation.role}</strong> is ready.
            </p>

            <div className={styles.urlBox}>
              <input
                type="text"
                readOnly
                value={invitationUrl}
                className={styles.urlInput}
                aria-label="Invitation link"
                onClick={(e) => (e.target as HTMLInputElement).select()}
              />
              <Button
                ref={copyBtnRef}
                variant="secondary"
                size="sm"
                onClick={handleCopyLink}
                aria-label="Copy invitation link"
              >
                {copied ? 'Copied!' : 'Copy Link'}
              </Button>
            </div>

            <div className={styles.infoNotice}>
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
                <strong>Manual delivery:</strong> Email delivery is not currently implemented.
                Please copy and share this link directly with your team member.
              </div>
            </div>

            {isEmailBound && (
              <div className={styles.warningNotice}>
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
                  <strong>Email bound:</strong> Only an account with verified email{' '}
                  <code>{createdData.invitation.invitee_email}</code> can accept this invitation.
                  Acceptance will remain blocked until authoritative email verification is configured.
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

  // Initial Form View
  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <div
        ref={formModalRef}
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-modal-title"
        tabIndex={-1}
      >
        <div className={styles.header}>
          <h2 id="invite-modal-title" className={styles.title}>
            Invite Member to Workspace
          </h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            disabled={submitting}
            aria-label="Close dialog"
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          {error && (
            <div
              className={rateLimited ? styles.rateLimitBanner : styles.errorBanner}
              role="alert"
            >
              {error}
            </div>
          )}

          {/* Role selection */}
          <div className={styles.fieldGroup}>
            <label className={styles.label} id="role-selection-label">
              Workspace Role
            </label>
            <div
              className={styles.radioGroup}
              role="radiogroup"
              aria-labelledby="role-selection-label"
            >
              {isOwner && (
                <div
                  className={`${styles.radioCard} ${role === 'admin' ? styles.radioCardActive : ''}`}
                  onClick={() => setRole('admin')}
                  role="radio"
                  aria-checked={role === 'admin'}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault();
                      setRole('admin');
                    }
                  }}
                >
                  <div className={styles.radioTitle}>
                    <span>Admin</span>
                    {role === 'admin' && <span>✓</span>}
                  </div>
                  <div className={styles.radioDesc}>Manage members, settings & documents</div>
                </div>
              )}

              <div
                className={`${styles.radioCard} ${role === 'editor' ? styles.radioCardActive : ''}`}
                onClick={() => setRole('editor')}
                role="radio"
                aria-checked={role === 'editor'}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    setRole('editor');
                  }
                }}
              >
                <div className={styles.radioTitle}>
                  <span>Editor</span>
                  {role === 'editor' && <span>✓</span>}
                </div>
                <div className={styles.radioDesc}>Create, edit & collaborate on documents</div>
              </div>

              <div
                className={`${styles.radioCard} ${role === 'viewer' ? styles.radioCardActive : ''}`}
                onClick={() => setRole('viewer')}
                role="radio"
                aria-checked={role === 'viewer'}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    setRole('viewer');
                  }
                }}
              >
                <div className={styles.radioTitle}>
                  <span>Viewer</span>
                  {role === 'viewer' && <span>✓</span>}
                </div>
                <div className={styles.radioDesc}>Read-only access to workspace documents</div>
              </div>
            </div>
            {isAdmin && (
              <span className={styles.helperText}>
                As an Admin, you can invite Editors and Viewers. Only Owners can invite Admins.
              </span>
            )}
          </div>

          {/* Email input (optional) */}
          <div className={styles.fieldGroup}>
            <label htmlFor="invitee-email" className={styles.label}>
              Invitee Email
              <span className={styles.optionalTag}>(Optional)</span>
            </label>
            <input
              id="invitee-email"
              ref={emailInputRef}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="e.g. colleague@company.com"
              className={styles.input}
              disabled={submitting}
              autoComplete="off"
            />
            <span className={styles.helperText}>
              {email.trim()
                ? 'Email-bound invitation: Only the recipient with this verified email can accept the link.'
                : 'Shareable link: Leave email blank to generate a link that any authenticated user can join with.'}
            </span>
          </div>

          {/* Expiration */}
          <div className={styles.fieldGroup}>
            <label htmlFor="expires-in" className={styles.label}>
              Link Expiration
            </label>
            <select
              id="expires-in"
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(Number(e.target.value))}
              className={styles.select}
              disabled={submitting}
            >
              <option value={1}>1 day</option>
              <option value={7}>7 days (Default)</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days (Maximum)</option>
            </select>
          </div>

          <div className={styles.actions}>
            <Button
              type="button"
              variant="secondary"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={submitting}
            >
              Generate Invitation Link
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
