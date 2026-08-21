'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { Avatar, Badge } from '@/components/ui';
import { DocumentTree } from '@/components/documents/DocumentTree';
import styles from './Sidebar.module.css';

export function Sidebar() {
  const pathname = usePathname();
  const { user } = useAuth();
  const { activeWorkspace, userRole } = useWorkspace();

  const isDocumentsActive =
    activeWorkspace && (pathname === `/workspaces/${activeWorkspace.id}` || pathname.includes('/documents'));

  return (
    <aside className={styles.sidebar} aria-label="Sidebar Navigation">
      <div className={styles.workspaceHeader}>
        <div className={styles.workspaceName}>{activeWorkspace?.name || 'Workspace'}</div>
        {activeWorkspace?.slug && <div className={styles.workspaceSlug}>{activeWorkspace.slug}</div>}
      </div>

      <nav className={styles.navSection} aria-label="Primary Navigation">
        <Link
          href={activeWorkspace ? `/workspaces/${activeWorkspace.id}` : '#'}
          className={`${styles.navItem} ${isDocumentsActive ? styles.navItemActive : ''}`}
          aria-current={isDocumentsActive ? 'page' : undefined}
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
      </nav>

      <div className={styles.docSection}>
        <DocumentTree />
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
