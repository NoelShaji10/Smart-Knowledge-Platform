'use client';

import React, { InputHTMLAttributes, forwardRef, useId } from 'react';
import styles from './Input.module.css';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  helperText?: string;
  errorText?: string;
  startIcon?: React.ReactNode;
  endAction?: React.ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, helperText, errorText, startIcon, endAction, className = '', id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const helperId = `${inputId}-helper`;
  const errorId = `${inputId}-error`;

  const describedBy = [
    errorText ? errorId : null,
    helperText && !errorText ? helperId : null,
  ]
    .filter(Boolean)
    .join(' ');

  const inputClasses = [
    styles.input,
    startIcon ? styles.hasStartIcon : null,
    endAction ? styles.hasEndAction : null,
    errorText ? styles.inputError : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={styles.container}>
      {label && (
        <label htmlFor={inputId} className={styles.label}>
          {label}
        </label>
      )}
      <div className={styles.inputWrapper}>
        {startIcon && (
          <span className={styles.startIcon} aria-hidden="true">
            {startIcon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-describedby={describedBy || undefined}
          aria-invalid={Boolean(errorText)}
          className={inputClasses}
          {...props}
        />
        {endAction && <div className={styles.endAction}>{endAction}</div>}
      </div>
      {errorText ? (
        <span id={errorId} className={styles.errorText} role="alert">
          {errorText}
        </span>
      ) : helperText ? (
        <span id={helperId} className={styles.helperText}>
          {helperText}
        </span>
      ) : null}
    </div>
  );
});
