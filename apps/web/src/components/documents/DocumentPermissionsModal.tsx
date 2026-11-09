'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { api, ApiError, DocumentPermissionOverride } from '@/lib/api';
import { Button, Input, Badge, Skeleton, useToast, Avatar } from '@/components/ui';
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
          <div className={styles.headerContent}>
            <h2 id="permissions-modal-title" className={styles.title}>
              Document Permissions
            </h2>
            <p className={styles.subtitle}>
              Manage member access overrides for this document.
            </p>
          </div>
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
          <div className={styles.formHeader}>
            <span className={styles.formTitle}>Add Permission Override</span>
            <span className={styles.formSubtitle}>Grant or restrict document access for a workspace member</span>
          </div>

          <div className={styles.formFields}>
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel} htmlFor="member-select">
                Workspace Member
              </label>
              {members.length > 0 ? (
                <div className={styles.selectWrapper}>
                  <select
                    id="member-select"
                    className={styles.selectInput}
                    value={targetUserId}
                    onChange={(e) => setTargetUserId(e.target.value)}
                    aria-label="Select Target Member"
                  >
                    <option value="">Select workspace member...</option>
                    {members.map((m) => {
                      const roleLabel = m.role ? m.role.charAt(0).toUpperCase() + m.role.slice(1) : '';
                      return (
                        <option key={m.id} value={m.id}>
                          {m.display_name || m.email} ({m.email}) — {roleLabel}
                        </option>
                      );
                    })}
                  </select>
                </div>
              ) : (
                <Input
                  id="member-select"
                  placeholder="Target User UUID"
                  value={targetUserId}
                  onChange={(e) => setTargetUserId(e.target.value)}
                  aria-label="Target User ID"
                />
              )}
            </div>

            <div className={styles.actionRow}>
              <div className={styles.roleField}>
                <label className={styles.fieldLabel} htmlFor="role-select">
                  Document Role
                </label>
                <div className={styles.selectWrapper}>
                  <select
                    id="role-select"
                    className={styles.selectInput}
                    value={targetRole}
                    onChange={(e) => setTargetRole(e.target.value as 'editor' | 'viewer' | 'none')}
                    aria-label="Permission Role"
                  >
                    <option value="editor">Editor (Can edit)</option>
                    <option value="viewer">Viewer (Read only)</option>
                    <option value="none">Denied (No access)</option>
                  </select>
                </div>
              </div>

              <Button
                type="submit"
                variant="primary"
                loading={submitLoading}
                disabled={!targetUserId.trim() || submitLoading}
                className={styles.grantBtn}
              >
                Grant Override
              </Button>
            </div>
          </div>
        </form>

        <div className={styles.overrideList}>
          <div className={styles.listHeaderRow}>
            <span className={styles.listHeader}>
              Current Overrides
              {permissions.length > 0 && (
                <span className={styles.countBadge}>{permissions.length}</span>
              )}
            </span>
          </div>

          {loading ? (
            <Skeleton height={72} />
          ) : permissions.length === 0 ? (
            <div className={styles.emptyCard}>
              <span className={styles.emptyTitle}>No explicit permission overrides</span>
              <span className={styles.emptySubtitle}>
                All workspace members inherit their workspace role permissions on this document.
              </span>
            </div>
          ) : (
            permissions.map((perm) => {
              const wsMember = memberMap.get(perm.id);
              const wsRole = perm.workspace_role || wsMember?.role || 'viewer';
              const effectiveLabel = calculateEffectiveRole(wsRole, perm.role);

              return (
                <div key={perm.id} className={styles.overrideItem}>
                  <div className={styles.userCell}>
                    <Avatar name={perm.display_name || perm.email || 'User'} size="sm" />
                    <div className={styles.userInfo}>
                      <div className={styles.userName}>{perm.display_name || perm.email || perm.id}</div>
                      <div className={styles.userEmail}>{perm.email || perm.id}</div>
                      <div className={styles.badgeRow}>
                        <span className={styles.metaText}>
                          Workspace: <Badge variant={wsRole as any}>{wsRole}</Badge>
                        </span>
                        <span className={styles.metaText}>
                          Effective: <Badge variant={perm.role === 'none' ? 'admin' : perm.role === 'editor' ? 'editor' : 'viewer'}>{effectiveLabel}</Badge>
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className={styles.actions}>
                    <div className={styles.compactSelectWrapper}>
                      <select
                        className={styles.compactSelect}
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
                    </div>

                    <Button
                      variant="ghost"
                      size="sm"
                      className={styles.removeBtn}
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
