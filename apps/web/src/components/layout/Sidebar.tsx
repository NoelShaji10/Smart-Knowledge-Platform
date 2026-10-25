'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { Avatar, Badge, Dropdown, DropdownItem } from '@/components/ui';
import { DocumentTree } from '@/components/documents/DocumentTree';
import styles from './Sidebar.module.css';

export interface SidebarProps {
  onClose?: () => void;
  onDismiss?: () => void;
}

export function Sidebar({ onClose, onDismiss }: SidebarProps = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();
  const { workspaces, activeWorkspace, userRole } = useWorkspace();

  // Extract workspaceId from URL path if present
  // Route /workspaces/new is the workspace-creation route, not a workspace ID.
  const isCreateWorkspaceRoute = pathname === '/workspaces/new' || pathname?.startsWith('/workspaces/new/');
  const match = pathname?.match(/\/workspaces\/([a-zA-Z0-9-]+)/);
  const rawId = match ? match[1] : null;
  const routeWorkspaceId = rawId && rawId !== 'new' ? rawId : null;
  const effectiveWorkspaceId = isCreateWorkspaceRoute ? null : (routeWorkspaceId || activeWorkspace?.id || null);

  const isDocumentsActive = Boolean(
    effectiveWorkspaceId &&
      (pathname === `/workspaces/${effectiveWorkspaceId}` ||
        (pathname?.includes('/documents') && pathname?.includes(`/workspaces/${effectiveWorkspaceId}`))) &&
      !pathname?.includes('/members'),
  );
  const isMembersActive = Boolean(
    effectiveWorkspaceId && pathname?.includes(`/workspaces/${effectiveWorkspaceId}/members`),
  );

  const workspaceMenuItems: DropdownItem[] = [
    ...workspaces.map((ws) => ({
      id: ws.id,
      label: ws.name,
      active: activeWorkspace?.id === ws.id,
      onClick: () => {
        onClose?.();
        router.push(`/workspaces/${ws.id}`);
      },
    })),
    { id: 'div1', label: null, divider: true },
    {
      id: 'create-workspace',
      label: '+ Create Workspace',
      onClick: () => {
        onClose?.();
        router.push('/workspaces/new');
      },
    },
  ];

  return (
    <aside className={styles.sidebar} id="sidebar-navigation" aria-label="Sidebar Navigation">
      <div className={styles.workspaceHeader}>
        <div className={styles.headerTopRow}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Dropdown
              ariaLabel="Switch workspace"
              trigger={
                <span className={styles.workspaceSwitchBtn}>
                  <div className={styles.workspaceInfo}>
                    <div className={styles.workspaceName}>{activeWorkspace?.name || 'Workspace'}</div>
                    {activeWorkspace?.slug && <div className={styles.workspaceSlug}>{activeWorkspace.slug}</div>}
                  </div>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </span>
              }
              items={workspaceMenuItems}
            />
          </div>

          {(onDismiss || onClose) && (
            <button
              type="button"
              className={styles.mobileCloseBtn}
              onClick={() => (onDismiss ? onDismiss() : onClose?.())}
              aria-label="Close navigation sidebar"
            >
              &times;
            </button>
          )}
        </div>
      </div>

      <nav className={styles.navSection} aria-label="Primary Navigation">
        <Link
          href={effectiveWorkspaceId ? `/workspaces/${effectiveWorkspaceId}` : '#'}
          className={`${styles.navItem} ${isDocumentsActive ? styles.navItemActive : ''}`}
          aria-current={isDocumentsActive ? 'page' : undefined}
          onClick={() => onClose?.()}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
          <span>Documents</span>
        </Link>
        <Link
          href={effectiveWorkspaceId ? `/workspaces/${effectiveWorkspaceId}/members` : '#'}
          className={`${styles.navItem} ${isMembersActive ? styles.navItemActive : ''}`}
          aria-current={isMembersActive ? 'page' : undefined}
          onClick={() => onClose?.()}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          <span>Members</span>
        </Link>
      </nav>

      <div className={styles.docSection}>
        <DocumentTree onNavigate={onClose} />
      </div>

      <div className={styles.userFooter}>
        <Avatar name={user?.displayName || 'User'} size="sm" />
        <div className={styles.userInfo}>
          <div className={styles.userName}>{user?.displayName || 'User'}</div>
          {userRole && <Badge variant={userRole}>{userRole}</Badge>}
        </div>
      </div>
    </aside>
  );
}
