'use client';

import React, { useState, useEffect, useRef, ReactNode } from 'react';
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
  const hamburgerRef = useRef<HTMLButtonElement | null>(null);

  // Extract workspaceId from URL path if present (e.g. /workspaces/[workspaceId])
  // Route /workspaces/new is the workspace-creation route, not a workspace ID.
  const isCreateWorkspaceRoute = pathname === '/workspaces/new' || pathname?.startsWith('/workspaces/new/');
  const match = pathname?.match(/\/workspaces\/([a-zA-Z0-9-]+)/);
  const rawId = match ? match[1] : null;
  const routeWorkspaceId = rawId && rawId !== 'new' ? rawId : null;
  const currentWorkspaceId = isCreateWorkspaceRoute ? null : (routeWorkspaceId || activeWorkspace?.id || null);

  const toggleSidebar = () => {
    setMobileSidebarOpen((prev) => !prev);
  };

  const closeSidebar = (restoreFocus = false) => {
    setMobileSidebarOpen(false);
    if (restoreFocus && hamburgerRef.current) {
      hamburgerRef.current.focus();
    }
  };

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [pathname]);

  // Escape key handler
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && mobileSidebarOpen) {
        e.preventDefault();
        closeSidebar(true);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mobileSidebarOpen]);

  return (
    <ToastProvider>
      <DocumentNavigationProvider workspaceId={currentWorkspaceId}>
        <div className={styles.shell}>
          <Topbar
            hamburgerRef={hamburgerRef}
            onToggleSidebar={toggleSidebar}
            isSidebarOpen={mobileSidebarOpen}
          />
          <div className={styles.body}>
            <div
              className={`${styles.sidebarWrapper} ${mobileSidebarOpen ? styles.sidebarOpen : ''}`}
            >
              <Sidebar
                onClose={() => closeSidebar(false)}
                onDismiss={() => closeSidebar(true)}
              />
            </div>

            <div
              className={`${styles.backdrop} ${mobileSidebarOpen ? styles.backdropOpen : ''}`}
              onClick={() => closeSidebar(false)}
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
