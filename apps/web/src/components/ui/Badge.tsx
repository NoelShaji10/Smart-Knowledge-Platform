'use client';

import React, { ReactNode } from 'react';
import styles from './Badge.module.css';

export interface BadgeProps {
  children: ReactNode;
  variant?:
    | 'default'
    | 'owner'
    | 'admin'
    | 'editor'
    | 'viewer'
    | 'pending'
    | 'accepted'
    | 'expired'
    | 'revoked'
    | 'success'
    | 'warning'
    | 'danger'
    | 'info'
    | 'processing';
  className?: string;
  title?: string;
}

export function Badge({ children, variant = 'default', className = '', title }: BadgeProps) {
  const variantClass = styles[variant] || '';

  return (
    <span className={`${styles.badge} ${variantClass} ${className}`.trim()} title={title}>
      {children}
    </span>
  );
}
