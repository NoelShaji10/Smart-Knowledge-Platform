'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { api, ApiError, DocumentPermissionOverride } from '@/lib/api';
import { Button, Input, Badge, Skeleton, useToast } from '@/components/ui';
import styles from './DocumentPermissionsModal.module.css';

export interface DocumentPermissionsModalProps {
  workspaceId: string;
  documentId: string;
  onClose: () => void;
}

interface WorkspaceMemberItem {
  id: string;
  email: string;
  display_name: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
}

function calculateEffectiveRole(
  workspaceRole: string | undefined,
  overrideRole: 'editor' | 'viewer' | 'none',
): string {
  if (overrideRole === 'none') {
    return 'Denied (No Access)';
  }
  if (workspaceRole === 'owner' || workspaceRole === 'admin') {
    return workspaceRole === 'owner' ? 'Owner' : 'Admin';
  }
  if (workspaceRole === 'editor') {
    return overrideRole === 'viewer' ? 'Viewer' : 'Editor';
  }
  if (workspaceRole === 'viewer') {
    return overrideRole === 'editor' ? 'Editor' : 'Viewer';
  }
  return overrideRole === 'editor' ? 'Editor' : 'Viewer';
}

export function DocumentPermissionsModal({
  workspaceId,
  documentId,
  onClose,
}: DocumentPermissionsModalProps) {
  const { showToast } = useToast();
  const [permissions, setPermissions] = useState<DocumentPermissionOverride[]>([]);
  const [members, setMembers] = useState<WorkspaceMemberItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [targetUserId, setTargetUserId] = useState('');
  const [targetRole, setTargetRole] = useState<'editor' | 'viewer' | 'none'>('editor');
  const [submitLoading, setSubmitLoading] = useState(false);
  const [actionUserId, setActionUserId] = useState<string | null>(null);

  const fetchPermissionsAndMembers = useCallback(async () => {
    setLoading(true);
    try {
      const [permRes, memberRes] = await Promise.all([
        api.listDocumentPermissions(workspaceId, documentId),
        api.listWorkspaceMembers(workspaceId).catch(() => ({ members: [] })),
      ]);
      setPermissions(permRes.permissions);
      setMembers(memberRes.members || []);
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
    fetchPermissionsAndMembers();
  }, [fetchPermissionsAndMembers]);

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

  const memberMap = useMemo(() => {
    const map = new Map<string, WorkspaceMemberItem>();
    for (const m of members) {
      map.set(m.id, m);
    }
    return map;
  }, [members]);

  const handleGrantPermission = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUserId = targetUserId.trim();
    if (!cleanUserId) {
      showToast('Please select or enter a Target User', 'error');
      return;
    }

    setSubmitLoading(true);
    try {
      const res = await api.setDocumentPermission(
        workspaceId,
        documentId,
        cleanUserId,
        targetRole,
      );
      showToast(`Permission override granted for ${res.permission.display_name || cleanUserId}`, 'success');
      setTargetUserId('');
      fetchPermissionsAndMembers();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showToast('Access denied: Only owners and admins can set document permissions', 'error');
      } else if (err instanceof ApiError) {
        showToast(err.message || 'Failed to set document permission', 'error');
      } else {
        showToast('Failed to set document permission', 'error');
      }
    } finally {
      setSubmitLoading(false);
    }
  };

  const handleRemovePermission = async (userId: string) => {
    setActionUserId(userId);
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
    } finally {
      setActionUserId(null);
    }
  };

  const handleRoleChange = async (userId: string, newRole: 'editor' | 'viewer' | 'none') => {
    setActionUserId(userId);
    try {
      const res = await api.setDocumentPermission(workspaceId, documentId, userId, newRole);
      setPermissions((prev) =>
        prev.map((p) => (p.id === userId ? { ...p, role: res.permission.role } : p)),
      );
      showToast('Role override updated successfully', 'success');
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        showToast('Access denied: You cannot update this role', 'error');
      } else {
        showToast('Failed to update role', 'error');
      }
    } finally {
      setActionUserId(null);
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
            {members.length > 0 ? (
              <select
                className={styles.roleSelect}
                value={targetUserId}
                onChange={(e) => setTargetUserId(e.target.value)}
                aria-label="Select Target Member"
                style={{ flex: 1 }}
              >
                <option value="">Select workspace member...</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name || m.email} ({m.email}) — [Workspace: {m.role}]
                  </option>
                ))}
              </select>
            ) : (
              <div style={{ flex: 1 }}>
                <Input
                  placeholder="Target User UUID"
                  value={targetUserId}
                  onChange={(e) => setTargetUserId(e.target.value)}
                  aria-label="Target User ID"
                />
              </div>
            )}
            <select
              className={styles.roleSelect}
              value={targetRole}
              onChange={(e) => setTargetRole(e.target.value as 'editor' | 'viewer' | 'none')}
              aria-label="Permission Role"
            >
              <option value="editor">Override: Editor</option>
              <option value="viewer">Override: Viewer</option>
              <option value="none">Override: Denied (No Access)</option>
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
            <div className={styles.emptyText}>No explicit document permission overrides. All members inherit their workspace role.</div>
          ) : (
            permissions.map((perm) => {
              const wsMember = memberMap.get(perm.id);
              const wsRole = perm.workspace_role || wsMember?.role || 'viewer';
              const effectiveLabel = calculateEffectiveRole(wsRole, perm.role);

              return (
                <div key={perm.id} className={styles.overrideItem}>
                  <div className={styles.userInfo}>
                    <div className={styles.userName}>{perm.display_name || perm.id}</div>
                    <div className={styles.userEmail}>{perm.email || perm.id}</div>
                    <div style={{ display: 'flex', gap: 'var(--space-1)', marginTop: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-secondary)' }}>
                        Workspace: <Badge variant="default">{wsRole}</Badge>
                      </span>
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-secondary)' }}>
                        Effective: <Badge variant={perm.role === 'none' ? 'admin' : perm.role === 'editor' ? 'owner' : 'viewer'}>{effectiveLabel}</Badge>
                      </span>
                    </div>
                  </div>

                  <div className={styles.actions}>
                    {perm.role === 'none' ? (
                      <Badge variant="admin">Denied</Badge>
                    ) : perm.role === 'editor' ? (
                      <Badge variant="owner">Editor</Badge>
                    ) : (
                      <Badge variant="viewer">Viewer</Badge>
                    )}

                    <select
                      className={styles.roleSelect}
                      value={perm.role}
                      disabled={actionUserId === perm.id}
                      onChange={(e) =>
                        handleRoleChange(perm.id, e.target.value as 'editor' | 'viewer' | 'none')
                      }
                      aria-label={`Change role for ${perm.display_name}`}
                    >
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                      <option value="none">Denied</option>
                    </select>

                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={actionUserId === perm.id}
                      onClick={() => handleRemovePermission(perm.id)}
                      title="Remove permission override"
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
