'use client';

import React, { useState, useEffect, ReactNode } from 'react';
import { ToastProvider } from '@/components/ui';
import { Topbar } from './Topbar';
import { Sidebar } from './Sidebar';
import styles from './AppShell.module.css';

export interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const toggleSidebar = () => {
    setMobileSidebarOpen((prev) => !prev);
  };

  const closeSidebar = () => {
    setMobileSidebarOpen(false);
  };

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
      <div className={styles.shell}>
        <Topbar onToggleSidebar={toggleSidebar} />
        <div className={styles.body}>
          <div
            className={`${styles.sidebarWrapper} ${mobileSidebarOpen ? styles.sidebarOpen : ''}`}
          >
            <Sidebar />
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
    </ToastProvider>
  );
}
