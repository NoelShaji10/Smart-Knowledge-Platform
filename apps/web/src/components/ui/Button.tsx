'use client';

import React, { ButtonHTMLAttributes, forwardRef } from 'react';
import styles from './Button.module.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    fullWidth = false,
    disabled,
    children,
    className = '',
    ...props
  },
  ref,
) {
  const variantClass =
    variant === 'primary'
      ? styles.btnPrimary
      : variant === 'secondary'
        ? styles.btnSecondary
        : variant === 'ghost'
          ? styles.btnGhost
          : styles.btnDanger;

  const sizeClass = size === 'sm' ? styles.sm : size === 'lg' ? styles.lg : '';
  const fullWidthClass = fullWidth ? styles.fullWidth : '';

  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading ? 'true' : undefined}
      className={`${styles.btn} ${variantClass} ${sizeClass} ${fullWidthClass} ${className}`.trim()}
      {...props}
    >
      {loading ? (
        <>
          <span className="kp-spinner" aria-hidden="true" />
          <span>{children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
});
