'use client';

import React, { InputHTMLAttributes, forwardRef, useId } from 'react';
import styles from './Input.module.css';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  helperText?: string;
  errorText?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, helperText, errorText, className = '', id, ...props },
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

  return (
    <div className={styles.container}>
      {label && (
        <label htmlFor={inputId} className={styles.label}>
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-describedby={describedBy || undefined}
        aria-invalid={Boolean(errorText)}
        className={`${styles.input} ${errorText ? styles.inputError : ''} ${className}`.trim()}
        {...props}
      />
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
