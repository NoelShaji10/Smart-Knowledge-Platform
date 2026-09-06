'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { api, ApiError, DocumentPermissionOverride } from '@/lib/api';
import { Button, Input, Badge, Skeleton, useToast } from '@/components/ui';
import styles from './DocumentPermissionsModal.module.css';

export interface DocumentPermissionsModalProps {
  workspaceId: string;
  documentId: string;
  onClose: () => void;
}

export function DocumentPermissionsModal({
  workspaceId,
  documentId,
  onClose,
}: DocumentPermissionsModalProps) {
  const { showToast } = useToast();
  const [permissions, setPermissions] = useState<DocumentPermissionOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [targetUserId, setTargetUserId] = useState('');
  const [targetRole, setTargetRole] = useState<'editor' | 'viewer' | 'none'>('editor');
  const [submitLoading, setSubmitLoading] = useState(false);

  const fetchPermissions = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listDocumentPermissions(workspaceId, documentId);
      setPermissions(res.permissions);
    } catch (err) {
      setPermissions([]);
      if (err instanceof ApiError && err.status === 403) {
        showToast('Access denied: You cannot manage permissions for this document', 'error');
        onClose();
      } else {
        showToast('Failed to load document permissions', 'error');
      }
    } finally {
      setLoading(false);
    }
  }, [workspaceId, documentId, showToast, onClose]);

  useEffect(() => {
    fetchPermissions();
  }, [fetchPermissions]);

  // Escape key handler
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleGrantPermission = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetUserId.trim()) {
      showToast('Please enter a Target User ID', 'error');
      return;
    }

    setSubmitLoading(true);
    try {
      const res = await api.setDocumentPermission(
        workspaceId,
        documentId,
        targetUserId.trim(),
        targetRole,
      );
      showToast(`Permission granted for ${res.permission.display_name || targetUserId}`, 'success');
      setTargetUserId('');
      fetchPermissions();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showToast('Access denied: Only owners and admins can set permissions', 'error');
      } else {
        showToast('Failed to set document permission', 'error');
      }
    } finally {
      setSubmitLoading(false);
    }
  };

  const handleRemovePermission = async (userId: string) => {
    try {
      await api.removeDocumentPermission(workspaceId, documentId, userId);
      showToast('Permission override removed', 'info');
      setPermissions((prev) => prev.filter((p) => p.id !== userId));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showToast('Access denied: You cannot remove this permission', 'error');
      } else {
        showToast('Failed to remove permission override', 'error');
      }
    }
  };

  const handleRoleChange = async (userId: string, newRole: 'editor' | 'viewer' | 'none') => {
    try {
      const res = await api.setDocumentPermission(workspaceId, documentId, userId, newRole);
      setPermissions((prev) =>
        prev.map((p) => (p.id === userId ? { ...p, role: res.permission.role } : p)),
      );
      showToast('Role updated successfully', 'success');
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showToast('Access denied: You cannot update this role', 'error');
      } else {
        showToast('Failed to update role', 'error');
      }
    }
  };

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="permissions-modal-title"
      >
        <div className={styles.header}>
          <h2 id="permissions-modal-title" className={styles.title}>
            Document Permissions
          </h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close permissions modal"
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleGrantPermission} className={styles.formSection}>
          <span className={styles.formTitle}>Add Permission Override</span>
          <div className={styles.formRow}>
            <div style={{ flex: 1 }}>
              <Input
                placeholder="Target User UUID"
                value={targetUserId}
                onChange={(e) => setTargetUserId(e.target.value)}
                aria-label="Target User ID"
              />
            </div>
            <select
              className={styles.roleSelect}
              value={targetRole}
              onChange={(e) => setTargetRole(e.target.value as 'editor' | 'viewer' | 'none')}
              aria-label="Permission Role"
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
              <option value="none">Denied (No Access)</option>
            </select>
            <Button type="submit" variant="primary" loading={submitLoading}>
              Grant
            </Button>
          </div>
        </form>

        <div className={styles.overrideList}>
          <span className={styles.listHeader}>Current Overrides</span>

          {loading ? (
            <Skeleton height={60} />
          ) : permissions.length === 0 ? (
            <div className={styles.emptyText}>No explicit document permission overrides.</div>
          ) : (
            permissions.map((perm) => (
              <div key={perm.id} className={styles.overrideItem}>
                <div className={styles.userInfo}>
                  <div className={styles.userName}>{perm.display_name || perm.id}</div>
                  <div className={styles.userEmail}>{perm.email || perm.id}</div>
                </div>

                <div className={styles.actions}>
                  {perm.role === 'none' ? (
                    <Badge variant="admin">Denied (No Access)</Badge>
                  ) : perm.role === 'editor' ? (
                    <Badge variant="owner">Editor</Badge>
                  ) : (
                    <Badge variant="viewer">Viewer</Badge>
                  )}

                  <select
                    className={styles.roleSelect}
                    value={perm.role}
                    onChange={(e) =>
                      handleRoleChange(perm.id, e.target.value as 'editor' | 'viewer' | 'none')
                    }
                    aria-label={`Change role for ${perm.display_name}`}
                  >
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                    <option value="none">Denied (No Access)</option>
                  </select>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemovePermission(perm.id)}
                    title="Remove permission override"
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
