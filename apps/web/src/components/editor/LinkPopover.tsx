'use client';

import React, { useState, useEffect, useRef } from 'react';
import styles from './LinkPopover.module.css';

export function sanitizeLinkUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('file:')
  ) {
    return null;
  }

  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:')) {
    return trimmed;
  }

  // If no scheme present, default to https://
  if (!lower.includes('://') && !lower.startsWith('mailto:')) {
    return `https://${trimmed}`;
  }

  return null;
}

export interface LinkPopoverProps {
  initialUrl?: string;
  onApply: (url: string) => void;
  onRemove: () => void;
  onCancel: () => void;
}

export function LinkPopover({
  initialUrl = '',
  onApply,
  onRemove,
  onCancel,
}: LinkPopoverProps) {
  const [url, setUrl] = useState(initialUrl || 'https://');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const sanitized = sanitizeLinkUrl(url);
    if (!sanitized) {
      setError('Please enter a valid HTTP, HTTPS, or Mailto URL');
      return;
    }
    setError(null);
    onApply(sanitized);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <div
      className={styles.popover}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-label="Insert or edit link"
    >
      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.inputGroup}>
          <input
            ref={inputRef}
            type="text"
            className={styles.input}
            placeholder="https://example.com"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            aria-label="URL input"
          />
        </div>

        {error && <div className={styles.errorMessage}>{error}</div>}

        <div className={styles.actions}>
          <button type="submit" className={styles.btnPrimary}>
            {initialUrl ? 'Update Link' : 'Add Link'}
          </button>

          {initialUrl && (
            <button
              type="button"
              className={styles.btnDanger}
              onClick={onRemove}
            >
              Remove Link
            </button>
          )}

          <button
            type="button"
            className={styles.btnSecondary}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
