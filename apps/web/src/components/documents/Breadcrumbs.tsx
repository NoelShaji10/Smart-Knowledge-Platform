'use client';

import React from 'react';
import Link from 'next/link';
import { Document } from '@/lib/api';
import { computeAncestors, useDocumentNavigationOptional } from '@/contexts/DocumentNavigationContext';
import styles from './Breadcrumbs.module.css';

export interface BreadcrumbsProps {
  workspaceId: string;
  workspaceName?: string;
  currentDocument?: Document | null;
  documents?: Document[];
}

export function Breadcrumbs({
  workspaceId,
  workspaceName = 'Workspace',
  currentDocument,
  documents: explicitDocs,
}: BreadcrumbsProps) {
  const nav = useDocumentNavigationOptional();
  const availableDocs = explicitDocs || nav?.documents || [];

  const ancestors = React.useMemo(() => {
    if (!currentDocument) return [];
    return computeAncestors(currentDocument.id, availableDocs);
  }, [currentDocument?.id, availableDocs]);

  if (!currentDocument) return null;

  return (
    <nav className={styles.breadcrumbs} aria-label="Document Breadcrumbs">
      <Link
        href={`/workspaces/${workspaceId}`}
        className={styles.crumbLink}
        title={`Navigate to ${workspaceName}`}
      >
        <span className={styles.crumbText}>{workspaceName}</span>
      </Link>

      {ancestors.map((item) => (
        <React.Fragment key={item.id}>
          <span className={styles.separator} aria-hidden="true">
            /
          </span>
          <Link
            href={`/workspaces/${workspaceId}/documents/${item.id}`}
            className={styles.crumbLink}
            title={item.title}
          >
            <span className={styles.crumbText}>{item.title}</span>
            {item.isArchived && <span className={styles.archivedTag}>(Archived)</span>}
          </Link>
        </React.Fragment>
      ))}

      <span className={styles.separator} aria-hidden="true">
        /
      </span>
      <span
        className={styles.crumbCurrent}
        title={currentDocument.title || 'Untitled'}
        aria-current="page"
      >
        <span className={styles.crumbText}>{currentDocument.title || 'Untitled'}</span>
      </span>
    </nav>
  );
}
