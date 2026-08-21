import React, { ReactNode } from 'react';
import styles from './layout.module.css';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main-content" className={styles.authWrapper}>
      <div className={styles.authContainer}>
        <div className={styles.wordmark}>Knowledge Platform</div>
        <div className={styles.divider} />
        {children}
      </div>
    </main>
  );
}
