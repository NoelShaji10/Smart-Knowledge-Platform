'use client';

import React from 'react';
import styles from './Avatar.module.css';

export interface AvatarProps {
  name: string;
  src?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

function getInitials(name: string): string {
  if (!name) return 'U';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Avatar({ name, src, size = 'md', className = '' }: AvatarProps) {
  const sizeClass = size === 'sm' ? styles.sm : size === 'lg' ? styles.lg : '';
  const initials = getInitials(name);

  return (
    <div
      className={`${styles.avatar} ${sizeClass} ${className}`.trim()}
      title={name}
      aria-label={name}
    >
      {src ? (
        <img src={src} alt={name} className={styles.img} />
      ) : (
        <span>{initials}</span>
      )}
    </div>
  );
}
