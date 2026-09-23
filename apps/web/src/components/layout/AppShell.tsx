'use client';

import React, { useState, useEffect, ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { ToastProvider } from '@/components/ui';
import { useWorkspace } from '@/contexts/WorkspaceContext';
import { DocumentNavigationProvider } from '@/contexts/DocumentNavigationContext';
import { Topbar } from './Topbar';
import { Sidebar } from './Sidebar';
import styles from './AppShell.module.css';

export interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const { activeWorkspace } = useWorkspace();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // Extract workspaceId from URL path if present (e.g. /workspaces/[workspaceId])
  const match = pathname?.match(/\/workspaces\/([a-zA-Z0-9-]+)/);
  const routeWorkspaceId = match ? match[1] : null;
  const currentWorkspaceId = routeWorkspaceId || activeWorkspace?.id || null;

  const toggleSidebar = () => {
    setMobileSidebarOpen((prev) => !prev);
  };

  const closeSidebar = () => {
    setMobileSidebarOpen(false);
  };

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [pathname]);

  // Escape key handler
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && mobileSidebarOpen) {
        closeSidebar();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mobileSidebarOpen]);

  return (
    <ToastProvider>
      <DocumentNavigationProvider workspaceId={currentWorkspaceId}>
        <div className={styles.shell}>
          <Topbar onToggleSidebar={toggleSidebar} />
          <div className={styles.body}>
            <div
              className={`${styles.sidebarWrapper} ${mobileSidebarOpen ? styles.sidebarOpen : ''}`}
            >
              <Sidebar onClose={closeSidebar} />
            </div>

            <div
              className={`${styles.backdrop} ${mobileSidebarOpen ? styles.backdropOpen : ''}`}
              onClick={closeSidebar}
              aria-hidden="true"
            />

            <main id="main-content" className={styles.mainContent}>
              {children}
            </main>
          </div>
        </div>
      </DocumentNavigationProvider>
    </ToastProvider>
  );
}
