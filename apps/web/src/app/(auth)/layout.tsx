import React, { ReactNode } from 'react';
import styles from './layout.module.css';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main-content" className={styles.authWrapper}>
      <div className={styles.authContainer}>
        <div className={styles.brandHeader}>
          <div className={styles.logoBadge} aria-hidden="true">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              <path d="M9 7h6" />
              <path d="M9 11h6" />
            </svg>
          </div>
          <span className={styles.wordmark}>Knowledge Platform</span>
        </div>
        <div className={styles.authCard}>
          {children}
        </div>
        <footer className={styles.authFooter}>
          <span>Real-Time Collaborative Knowledge Management</span>
        </footer>
      </div>
    </main>
  );
}
