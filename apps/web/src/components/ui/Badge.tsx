'use client';

import React, { ReactNode } from 'react';
import styles from './Badge.module.css';

export interface BadgeProps {
  children: ReactNode;
  variant?: 'default' | 'owner' | 'admin' | 'editor' | 'viewer';
  className?: string;
}

export function Badge({ children, variant = 'default', className = '' }: BadgeProps) {
  const variantClass =
    variant === 'owner'
      ? styles.owner
      : variant === 'admin'
        ? styles.admin
        : variant === 'editor'
          ? styles.editor
          : variant === 'viewer'
            ? styles.viewer
            : '';

  return (
    <span className={`${styles.badge} ${variantClass} ${className}`.trim()}>
      {children}
    </span>
  );
}
