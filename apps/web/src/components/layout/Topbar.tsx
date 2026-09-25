'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { Avatar, Dropdown, DropdownItem, Badge, useToast } from '@/components/ui';
import styles from './Topbar.module.css';

export interface TopbarProps {
  onToggleSidebar?: () => void;
}

export function Topbar({ onToggleSidebar }: TopbarProps) {
  const router = useRouter();
  const { user, logout, logoutAll } = useAuth();
  const { workspaces, activeWorkspace, userRole } = useWorkspace();
  const { showToast } = useToast();

  const workspaceMenuItems: DropdownItem[] = [
    ...workspaces.map((ws) => ({
      id: ws.id,
      label: ws.name,
      active: activeWorkspace?.id === ws.id,
      onClick: () => router.push(`/workspaces/${ws.id}`),
    })),
    { id: 'div1', label: null, divider: true },
    {
      id: 'create-workspace',
      label: '+ Create Workspace',
      onClick: () => router.push('/workspaces/new'),
    },
  ];

  const accountMenuItems: DropdownItem[] = [
    {
      id: 'user-info',
      label: (
        <div className={styles.userHeader}>
          <div className={styles.userName}>{user?.displayName || 'User'}</div>
          <div className={styles.userEmail}>{user?.email}</div>
          {userRole && <Badge variant={userRole}>{userRole}</Badge>}
        </div>
      ),
    },
    { id: 'div2', label: null, divider: true },
    {
      id: 'logout',
      label: 'Logout',
      onClick: async () => {
        await logout();
        router.replace('/login');
      },
    },
    {
      id: 'logout-all',
      label: 'Logout All Devices',
      danger: true,
      onClick: async () => {
        const res = await logoutAll();
        if (res && res.remoteRevoked === false) {
          showToast('Local session cleared, but remote devices could not be logged out', 'error');
        } else {
          showToast('Logged out from all devices', 'info');
        }
        router.replace('/login');
      },
    },
  ];

  return (
    <header className={styles.topbar}>
      <div className={styles.leftSection}>
        <button
          type="button"
          className={styles.hamburgerBtn}
          onClick={onToggleSidebar}
          aria-label="Toggle navigation menu"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>

        <Dropdown
          trigger={
            <span className={styles.workspaceTrigger}>
              <span>{activeWorkspace?.name || 'Workspace'}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </span>
          }
          items={workspaceMenuItems}
        />
      </div>

      <div className={styles.centerSection}>
        <button
          type="button"
          className={styles.searchPill}
          onClick={() => showToast('Search functionality will be enabled in a future release.', 'info')}
          aria-label="Search documents (placeholder)"
        >
          <span>Search documents...</span>
          <span className={styles.shortcut}>⌘K</span>
        </button>
      </div>

      <div className={styles.rightSection}>
        <Dropdown
          align="right"
          trigger={
            <span className={styles.userMenuTrigger} aria-label="User account menu">
              <Avatar name={user?.displayName || 'User'} size="md" />
            </span>
          }
          items={accountMenuItems}
        />
      </div>
    </header>
  );
}
