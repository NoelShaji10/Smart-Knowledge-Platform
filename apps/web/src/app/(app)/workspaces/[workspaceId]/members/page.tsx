'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { useAuth } from '@/contexts/AuthContext';
import {
  api,
  ApiError,
  isAbortError,
  WorkspaceMemberListItem,
  WorkspaceInvitation,
} from '@/lib/api';
import { Avatar, Badge, Button, Skeleton, useToast } from '@/components/ui';
import { ConfirmationModal } from '@/components/members/ConfirmationModal';
import { InviteMemberModal } from '@/components/members/InviteMemberModal';
import { ResendResultModal } from '@/components/members/ResendResultModal';
import styles from './page.module.css';

function formatDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return isoString;
  }
}

function formatExpiry(isoString: string, status: string): string {
  if (status === 'revoked') {
    return 'Revoked';
  }
  if (status === 'accepted') {
    return 'Accepted';
  }
  try {
    const expires = new Date(isoString).getTime();
    const now = Date.now();
    if (expires <= now || status === 'expired') {
      return `Expired on ${formatDate(isoString)}`;
    }
    const days = Math.ceil((expires - now) / (1000 * 60 * 60 * 24));
    return `Expires in ${days} ${days === 1 ? 'day' : 'days'} (${formatDate(isoString)})`;
  } catch {
    return `Expires ${isoString}`;
  }
}

export default function WorkspaceMembersPage({
  params,
}: {
  params?: { workspaceId?: string };
}) {
  const { showToast } = useToast();
  const { user } = useAuth();
  const { activeWorkspace, loadWorkspace, userRole } = useWorkspace();
  const workspaceId = params?.workspaceId || '';

  // Data states
  const [members, setMembers] = useState<WorkspaceMemberListItem[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rateLimitMessage, setRateLimitMessage] = useState<string | null>(null);

  // Modals state
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);

  // Role change confirmation modal state
  const [roleChangeTarget, setRoleChangeTarget] = useState<{
    member: WorkspaceMemberListItem;
    newRole: 'admin' | 'editor' | 'viewer';
  } | null>(null);
  const [roleChangeLoading, setRoleChangeLoading] = useState(false);

  // Remove member confirmation modal state
  const [removeTarget, setRemoveTarget] = useState<WorkspaceMemberListItem | null>(null);
  const [removeLoading, setRemoveLoading] = useState(false);

  // Revoke invitation confirmation modal state
  const [revokeTarget, setRevokeTarget] = useState<WorkspaceInvitation | null>(null);
  const [revokeLoading, setRevokeLoading] = useState(false);

  // Resend / replace confirmation modal state
  const [resendTarget, setResendTarget] = useState<WorkspaceInvitation | null>(null);
  const [resendLoading, setResendLoading] = useState(false);

  // Fresh link display modal state (after resend)
  const [freshLinkData, setFreshLinkData] = useState<{
    invitation: WorkspaceInvitation;
    rawToken: string;
  } | null>(null);

  // Permissions derived
  const isOwner = userRole === 'owner';
  const isAdmin = userRole === 'admin';
  const canManage = isOwner || isAdmin;

  // Load workspace details if needed
  useEffect(() => {
    if (workspaceId) {
      loadWorkspace(workspaceId);
    }
  }, [workspaceId, loadWorkspace]);

  // Isolate and reset workspace-specific state on workspace switch
  useEffect(() => {
    setMembers([]);
    setInvitations([]);
    setError(null);
    setRateLimitMessage(null);
    setLoading(true);
  }, [workspaceId]);

  // Fetch members and invitations with AbortSignal cancellation support
  const fetchData = useCallback(
    async (signal?: AbortSignal) => {
      if (!workspaceId) return;

      setLoading(true);
      setError(null);
      setRateLimitMessage(null);

      try {
        const membersPromise = api.getWorkspaceMembers(workspaceId, { signal });
        // Invitations are strictly restricted to Owners and Admins by backend requireWorkspace('admin').
        // Editors and Viewers do not call the invitation endpoint, avoiding 403 network failures.
        const invitationsPromise = canManage
          ? api.listWorkspaceInvitations(workspaceId, { signal })
          : Promise.resolve({ invitations: [] });

        const [membersRes, invitationsRes] = await Promise.all([
          membersPromise,
          invitationsPromise,
        ]);

        if (signal?.aborted) return;

        setMembers(membersRes.members || []);
        setInvitations(invitationsRes.invitations || []);
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) {
          return; // Ignore aborted requests from navigation switching
        }
        if (err instanceof ApiError && err.status === 429) {
          setRateLimitMessage(
            'You have sent too many requests. Please wait a moment before trying again.',
          );
        } else if (err instanceof ApiError && err.status === 403) {
          setError('Access denied: You do not have permission to view members of this workspace.');
        } else if (err instanceof ApiError) {
          setError(err.message || 'Failed to load workspace members and invitations.');
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('An unexpected error occurred while loading workspace members.');
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [workspaceId, canManage],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchData(controller.signal);
    return () => {
      controller.abort();
    };
  }, [fetchData]);

  // ---------------------------------------------------------------------------
  // Action Handlers
  // ---------------------------------------------------------------------------

  // Execute Role Change
  const handleConfirmRoleChange = async () => {
    if (!roleChangeTarget) return;
    setRoleChangeLoading(true);
    try {
      const { member, newRole } = roleChangeTarget;
      await api.changeWorkspaceMemberRole(workspaceId, member.id, newRole);

      setMembers((prev) =>
        prev.map((m) => (m.id === member.id ? { ...m, role: newRole } : m)),
      );
      showToast(`Updated ${member.display_name || member.email}'s role to ${newRole}`, 'success');
      setRoleChangeTarget(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        showToast('Rate limit reached: Please wait before changing more roles', 'error');
      } else if (err instanceof ApiError) {
        showToast(err.message || 'Failed to update member role', 'error');
      } else if (err instanceof Error) {
        showToast(err.message, 'error');
      }
    } finally {
      setRoleChangeLoading(false);
    }
  };

  // Execute Member Removal
  const handleConfirmRemove = async () => {
    if (!removeTarget) return;
    setRemoveLoading(true);
    try {
      await api.removeWorkspaceMember(workspaceId, removeTarget.id);

      setMembers((prev) => prev.filter((m) => m.id !== removeTarget.id));
      showToast(`Removed ${removeTarget.display_name || removeTarget.email} from workspace`, 'success');
      setRemoveTarget(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        showToast('Rate limit reached: Please wait before removing members', 'error');
      } else if (err instanceof ApiError) {
        showToast(err.message || 'Failed to remove member', 'error');
      } else if (err instanceof Error) {
        showToast(err.message, 'error');
      }
    } finally {
      setRemoveLoading(false);
    }
  };

  // Execute Invitation Revocation
  const handleConfirmRevoke = async () => {
    if (!revokeTarget) return;
    setRevokeLoading(true);
    try {
      await api.revokeWorkspaceInvitation(workspaceId, revokeTarget.id);

      setInvitations((prev) =>
        prev.map((inv) =>
          inv.id === revokeTarget.id ? { ...inv, status: 'revoked' } : inv,
        ),
      );
      showToast('Invitation revoked', 'success');
      setRevokeTarget(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        showToast('Rate limit reached: Please wait before revoking more invitations', 'error');
      } else if (err instanceof ApiError) {
        showToast(err.message || 'Failed to revoke invitation', 'error');
      } else if (err instanceof Error) {
        showToast(err.message, 'error');
      }
    } finally {
      setRevokeLoading(false);
    }
  };

  // Execute Invitation Resend / Replacement
  const handleConfirmResend = async () => {
    if (!resendTarget) return;
    setResendLoading(true);
    try {
      const res = await api.resendWorkspaceInvitation(workspaceId, resendTarget.id);

      setInvitations((prev) => [
        res.invitation,
        ...prev.map((inv) =>
          inv.id === resendTarget.id ? { ...inv, status: 'revoked' as const } : inv,
        ),
      ]);

      showToast('Invitation replaced with a new link', 'success');
      setResendTarget(null);

      // Open new link display dialog
      setFreshLinkData({
        invitation: res.invitation,
        rawToken: res.rawToken,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        showToast('Rate limit reached: Please wait before resending invitations', 'error');
      } else if (err instanceof ApiError) {
        showToast(err.message || 'Failed to replace invitation', 'error');
      } else if (err instanceof Error) {
        showToast(err.message, 'error');
      }
    } finally {
      setResendLoading(false);
    }
  };

  // Callback when new invitation is created via modal
  const handleInvitationCreated = (newInv: WorkspaceInvitation) => {
    setInvitations((prev) => [newInv, ...prev]);
  };

  // Helper to determine if current user can modify target member
  const canModifyMember = (target: WorkspaceMemberListItem) => {
    if (target.role === 'owner') return false; // Owner cannot be modified
    if (isOwner) return true; // Owner can modify any non-owner
    if (isAdmin) {
      // Admin cannot modify other admins or owner
      return target.role !== 'admin';
    }
    return false;
  };

  // Helper to determine if current user can remove target member
  const canRemoveMember = (target: WorkspaceMemberListItem) => {
    if (target.role === 'owner') return false; // Owner cannot be removed
    if (target.id === user?.id) {
      // Self-removal is only permitted for Admins using the existing backend admin-scoped endpoint.
      // (Backend requireWorkspace('admin') rejects Editor/Viewer self-removal with 403).
      return isAdmin;
    }
    if (isOwner) return true; // Owner can remove any non-owner
    if (isAdmin) {
      // Admin cannot remove other admins or owner
      return target.role !== 'admin';
    }
    return false; // Editors and Viewers cannot remove anyone
  };

  return (
    <div className={styles.container}>
      {/* Breadcrumb Navigation */}
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link href={`/workspaces/${workspaceId}`} className={styles.breadcrumbLink}>
          {activeWorkspace?.name || 'Workspace'}
        </Link>
        <span className={styles.breadcrumbSeparator} aria-hidden="true">
          /
        </span>
        <span className={styles.breadcrumbCurrent} aria-current="page">
          Manage Members
        </span>
      </nav>

      {/* Header Section */}
      <header className={styles.headerSection}>
        <div className={styles.headerInfo}>
          <div className={styles.titleRow}>
            <h1 className={styles.heading}>Manage Members</h1>
            {userRole && <Badge variant={userRole}>{userRole}</Badge>}
          </div>
          <p className={styles.description}>
            View workspace members, manage role assignments, and create shareable invitation
            links.
          </p>
        </div>

        {canManage && (
          <div className={styles.headerActions}>
            <Button
              variant="primary"
              onClick={() => setIsInviteModalOpen(true)}
              aria-label="Invite new member"
            >
              + Invite Member
            </Button>
          </div>
        )}
      </header>

      {/* Error / Rate Limit Banners */}
      {rateLimitMessage && (
        <div className={styles.bannerRateLimit} role="alert">
          <div>{rateLimitMessage}</div>
          <Button variant="secondary" size="sm" onClick={() => fetchData()}>
            Retry
          </Button>
        </div>
      )}

      {error && !rateLimitMessage && (
        <div className={styles.bannerError} role="alert">
          <div>{error}</div>
          <Button variant="secondary" size="sm" onClick={() => fetchData()}>
            Retry
          </Button>
        </div>
      )}

      {/* Content Section */}
      <div className={styles.contentGrid}>
        {/* SECTION 1: Workspace Members */}
        <section className={styles.section} aria-labelledby="members-heading">
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitleGroup}>
              <h2 id="members-heading" className={styles.sectionTitle}>
                Workspace Members
              </h2>
              <span className={styles.countBadge}>{members.length}</span>
            </div>
            <p className={styles.sectionDesc}>
              Active users with access to documents in this workspace.
            </p>
          </div>

          <div className={styles.cardList}>
            {loading ? (
              <div style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                <Skeleton height={52} borderRadius={8} />
                <Skeleton height={52} borderRadius={8} />
                <Skeleton height={52} borderRadius={8} />
              </div>
            ) : members.length === 0 ? (
              <div className={styles.emptyState}>
                <div className={styles.emptyTitle}>No members found</div>
                <div className={styles.emptyDesc}>This workspace does not have any active members.</div>
              </div>
            ) : (
              members.map((member) => {
                const isSelf = member.id === user?.id;
                const canChangeThisMember = canModifyMember(member);
                const canRemoveThisMember = canRemoveMember(member);

                return (
                  <div key={member.id} className={styles.cardItem}>
                    <div className={styles.memberMeta}>
                      <Avatar name={member.display_name || member.email} size="md" />
                      <div className={styles.memberInfo}>
                        <div className={styles.nameRow}>
                          <span className={styles.memberName}>
                            {member.display_name || member.email}
                          </span>
                          {isSelf && <span className={styles.youTag}>You</span>}
                          <Badge variant={member.role}>{member.role}</Badge>
                        </div>
                        <span className={styles.memberEmail}>{member.email}</span>
                        <span className={styles.joinedDate}>
                          Joined {formatDate(member.created_at)}
                        </span>
                      </div>
                    </div>

                    <div className={styles.memberActions}>
                      {canChangeThisMember ? (
                        <select
                          className={styles.roleSelect}
                          value={member.role}
                          aria-label={`Change role for ${member.display_name || member.email}`}
                          onChange={(e) => {
                            const newRole = e.target.value as 'admin' | 'editor' | 'viewer';
                            if (newRole !== member.role) {
                              setRoleChangeTarget({ member, newRole });
                            }
                          }}
                        >
                          {isOwner && <option value="admin">Admin</option>}
                          <option value="editor">Editor</option>
                          <option value="viewer">Viewer</option>
                        </select>
                      ) : (
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-tertiary)' }}>
                          {member.role === 'owner' ? 'Workspace Owner' : ''}
                        </span>
                      )}

                      {canRemoveThisMember && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRemoveTarget(member)}
                          aria-label={`Remove ${member.display_name || member.email}`}
                          style={{ color: 'var(--danger)' }}
                        >
                          {isSelf ? 'Leave Workspace' : 'Remove'}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* SECTION 2: Workspace Invitations */}
        <section className={styles.section} aria-labelledby="invitations-heading">
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitleGroup}>
              <h2 id="invitations-heading" className={styles.sectionTitle}>
                Invitations
              </h2>
              {canManage && <span className={styles.countBadge}>{invitations.length}</span>}
            </div>
            <p className={styles.sectionDesc}>
              Pending and historical invitation links. Secret keys and token hashes are never
              exposed.
            </p>
          </div>

          <div className={styles.cardList}>
            {!canManage ? (
              <div className={styles.restrictedCard} role="region" aria-label="Invitations restricted">
                <svg
                  className={styles.restrictedIcon}
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <div className={styles.restrictedTitle}>Access Restricted</div>
                <div className={styles.restrictedDesc}>
                  Invitations can only be viewed and managed by workspace owners and administrators.
                </div>
              </div>
            ) : loading ? (
              <div style={{ padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                <Skeleton height={52} borderRadius={8} />
                <Skeleton height={52} borderRadius={8} />
              </div>
            ) : invitations.length === 0 ? (
              <div className={styles.emptyState}>
                <svg
                  className={styles.emptyIcon}
                  width="36"
                  height="36"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="M22 17H2a3 3 0 0 0 3-3V9a7 7 0 0 1 14 0v5a3 3 0 0 0 3 3zm-8.27 4a2 2 0 0 1-3.46 0" />
                </svg>
                <div className={styles.emptyTitle}>No invitations created yet</div>
                <div className={styles.emptyDesc}>
                  Generate an invitation link to invite team members to this workspace with specific
                  roles.
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button variant="secondary" size="sm" onClick={() => setIsInviteModalOpen(true)}>
                    + Create First Invitation
                  </Button>
                </div>
              </div>
            ) : (
              invitations.map((inv) => {
                const isEmailBound = Boolean(inv.invitee_email);
                const isPending = inv.status === 'pending';
                const canResend = canManage && (isOwner || inv.role !== 'admin');
                const canRevoke = canManage && isPending && (isOwner || inv.role !== 'admin');

                return (
                  <div key={inv.id} className={styles.invitationItem}>
                    <div className={styles.invitationMeta}>
                      <div className={styles.invitationIconBox} aria-hidden="true">
                        {isEmailBound ? (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                            <polyline points="22,6 12,13 2,6" />
                          </svg>
                        ) : (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                          </svg>
                        )}
                      </div>

                      <div className={styles.invitationInfo}>
                        <div className={styles.invitationTargetRow}>
                          <span className={styles.invitationTarget}>
                            {inv.invitee_email || 'Anyone with link'}
                          </span>
                          {!isEmailBound && (
                            <span className={styles.shareableBadge}>Shareable Link</span>
                          )}
                          <Badge variant={inv.role}>{inv.role}</Badge>
                          <Badge variant={inv.status}>{inv.status}</Badge>
                        </div>
                        <div className={styles.invitationDates}>
                          <span>{formatExpiry(inv.expires_at, inv.status)}</span>
                          <span>•</span>
                          <span>Created {formatDate(inv.created_at)}</span>
                        </div>
                      </div>
                    </div>

                    <div className={styles.invitationActions}>
                      {canRevoke && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRevokeTarget(inv)}
                          aria-label={`Revoke invitation for ${inv.invitee_email || 'shareable link'}`}
                          style={{ color: 'var(--danger)' }}
                        >
                          Revoke
                        </Button>
                      )}

                      {canResend && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setResendTarget(inv)}
                          aria-label={`Replace and copy link for ${inv.invitee_email || 'shareable link'}`}
                        >
                          Replace Link
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>

      {/* MODAL 1: Invite Member Modal */}
      <InviteMemberModal
        workspaceId={workspaceId}
        isOpen={isInviteModalOpen}
        onClose={() => setIsInviteModalOpen(false)}
        onCreated={handleInvitationCreated}
        userRole={userRole}
      />

      {/* MODAL 2: Role Change Confirmation Modal */}
      <ConfirmationModal
        isOpen={Boolean(roleChangeTarget)}
        onClose={() => setRoleChangeTarget(null)}
        onConfirm={handleConfirmRoleChange}
        title="Change Member Role"
        description={
          roleChangeTarget ? (
            <span>
              Are you sure you want to change{' '}
              <strong>
                {roleChangeTarget.member.display_name || roleChangeTarget.member.email}
              </strong>
              &apos;s role from <strong>{roleChangeTarget.member.role}</strong> to{' '}
              <strong>{roleChangeTarget.newRole}</strong>?
            </span>
          ) : null
        }
        warningNote={
          roleChangeTarget?.newRole === 'admin'
            ? 'Admins have full control over documents and ordinary member roles.'
            : undefined
        }
        confirmLabel="Update Role"
        confirmVariant="primary"
        loading={roleChangeLoading}
      />

      {/* MODAL 3: Remove Member Confirmation Modal */}
      <ConfirmationModal
        isOpen={Boolean(removeTarget)}
        onClose={() => setRemoveTarget(null)}
        onConfirm={handleConfirmRemove}
        title={removeTarget?.id === user?.id ? 'Leave Workspace' : 'Remove Member'}
        description={
          removeTarget ? (
            <span>
              {removeTarget.id === user?.id ? (
                'Are you sure you want to leave this workspace? You will lose access to all its documents.'
              ) : (
                <span>
                  Are you sure you want to remove{' '}
                  <strong>{removeTarget.display_name || removeTarget.email}</strong> from this
                  workspace? They will immediately lose access to all workspace documents.
                </span>
              )}
            </span>
          ) : null
        }
        confirmLabel={removeTarget?.id === user?.id ? 'Leave Workspace' : 'Remove Member'}
        confirmVariant="danger"
        loading={removeLoading}
      />

      {/* MODAL 4: Revoke Invitation Confirmation Modal */}
      <ConfirmationModal
        isOpen={Boolean(revokeTarget)}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleConfirmRevoke}
        title="Revoke Invitation"
        description={
          revokeTarget ? (
            <span>
              Are you sure you want to revoke this invitation for{' '}
              <strong>{revokeTarget.invitee_email || 'Anyone with link'}</strong>? Anyone who
              possesses this link will no longer be able to use it to join the workspace.
            </span>
          ) : null
        }
        confirmLabel="Revoke Invitation"
        confirmVariant="danger"
        loading={revokeLoading}
      />

      {/* MODAL 5: Resend / Replace Link Confirmation Modal */}
      <ConfirmationModal
        isOpen={Boolean(resendTarget)}
        onClose={() => setResendTarget(null)}
        onConfirm={handleConfirmResend}
        title="Replace Invitation Link"
        description={
          resendTarget ? (
            <span>
              Replacing this invitation will <strong>immediately invalidate the old link</strong>{' '}
              and generate a fresh secret invitation link. Are you sure you want to continue?
            </span>
          ) : null
        }
        warningNote="Any recipient who received the previous link will no longer be able to use it."
        confirmLabel="Replace Link"
        confirmVariant="primary"
        loading={resendLoading}
      />

      {/* MODAL 6: Fresh Link Display Modal (After Resend) */}
      <ResendResultModal
        isOpen={Boolean(freshLinkData)}
        onClose={() => setFreshLinkData(null)}
        invitation={freshLinkData?.invitation || null}
        rawToken={freshLinkData?.rawToken || null}
      />
    </div>
  );
}
