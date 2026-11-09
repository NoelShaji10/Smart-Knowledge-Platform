import React from 'react';
import Link from 'next/link';
import { Document } from '@/lib/api';
import styles from './DocumentCard.module.css';

export interface DocumentCardProps {
  document: Document;
  workspaceId: string;
  viewMode?: 'grid' | 'list';
}

export function DocumentCard({ document: doc, workspaceId, viewMode = 'grid' }: DocumentCardProps) {
  const formattedDate = new Date(doc.updated_at).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const previewText = doc.content_text?.trim()
    ? doc.content_text.slice(0, 110)
    : 'No additional text preview available.';

  if (viewMode === 'list') {
    return (
      <Link
        href={`/workspaces/${workspaceId}/documents/${doc.id}`}
        className={styles.listRow}
        data-document-id={doc.id}
      >
        <div className={styles.listMain}>
          <div className={styles.iconWrapper} aria-hidden="true">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
          </div>
          <div className={styles.listInfo}>
            <span className={styles.listTitle} title={doc.title || 'Untitled Document'}>
              {doc.title || 'Untitled Document'}
            </span>
            <span className={styles.listPreview}>{previewText}</span>
          </div>
        </div>
        <div className={styles.listMeta}>
          <span className={styles.dateLabel}>Updated {formattedDate}</span>
          <span className={styles.arrow} aria-hidden="true">&rarr;</span>
        </div>
      </Link>
    );
  }

  return (
    <Link
      href={`/workspaces/${workspaceId}/documents/${doc.id}`}
      className={styles.gridCard}
      data-document-id={doc.id}
    >
      <div className={styles.cardHeader}>
        <div className={styles.iconWrapper} aria-hidden="true">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
        </div>
        <h3 className={styles.cardTitle} title={doc.title || 'Untitled Document'}>
          {doc.title || 'Untitled Document'}
        </h3>
      </div>

      <p className={styles.cardPreview}>
        {previewText}
      </p>

      <div className={styles.cardFooter}>
        <span className={styles.dateLabel}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={styles.calendarIcon}
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          Updated {formattedDate}
        </span>
        <span className={styles.arrow} aria-hidden="true">&rarr;</span>
      </div>
    </Link>
  );
}

