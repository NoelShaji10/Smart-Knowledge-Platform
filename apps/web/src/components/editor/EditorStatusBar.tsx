'use client';

import React, { useState, useEffect } from 'react';
import { Editor } from '@tiptap/react';
import { CollabProviderStatus } from '@/lib/collab-provider';
import { CollabUser } from '@/hooks/useCollaboration';
import { SaveState } from '@/hooks/useEditorAutosave';
import styles from './EditorStatusBar.module.css';

export const WORDS_PER_MINUTE = 200;

export function calculateReadingTime(words: number): string {
  if (!words || words <= 0) return '0 min read';
  const minutes = Math.ceil(words / WORDS_PER_MINUTE);
  if (minutes <= 1) return '< 1 min read';
  return `${minutes} min read`;
}

export interface EditorStatusBarProps {
  editor: Editor | null;
  collabStatus?: CollabProviderStatus;
  connectedUsers?: CollabUser[];
  readOnly?: boolean;
  saveState?: SaveState;
}

export function EditorStatusBar({
  editor,
  collabStatus,
  connectedUsers = [],
  readOnly = false,
  saveState,
}: EditorStatusBarProps) {
  const [stats, setStats] = useState({ words: 0, characters: 0 });

  useEffect(() => {
    if (!editor) return;

    const updateStats = () => {
      const words = editor.storage.characterCount?.words() ?? 0;
      const characters = editor.storage.characterCount?.characters() ?? 0;
      setStats((prev) => {
        if (prev.words === words && prev.characters === characters) {
          return prev;
        }
        return { words, characters };
      });
    };

    updateStats(); // Initial update

    editor.on('transaction', updateStats);
    return () => {
      editor.off('transaction', updateStats);
    };
  }, [editor]);

  if (!editor) return null;

  const readingTime = calculateReadingTime(stats.words);
  const userCount = connectedUsers.length;

  const collabStatusLabel = (() => {
    if (readOnly) {
      if (collabStatus === 'connected') {
        const userPart = userCount > 1 ? ` • ${userCount} collaborators` : '';
        return `View Only • Connected${userPart}`;
      } else if (collabStatus === 'connecting') {
        return 'View Only • Connecting...';
      } else if (collabStatus === 'error') {
        return 'View Only • Connection Error';
      }
      return 'View Only';
    }
    if (collabStatus === 'connected') {
      const userPart = userCount > 1 ? `${userCount} collaborators` : null;
      let persistPart = 'Saved';
      if (saveState === 'editing') persistPart = 'Changes pending';
      else if (saveState === 'saving') persistPart = 'Saving...';
      else if (saveState === 'error') persistPart = 'Save failed';
      else if (saveState === 'delayed') persistPart = 'Persistence delayed';
      else if (saveState === 'saved') persistPart = 'Saved';

      if (userPart) {
        return `Connected • ${userPart} • ${persistPart}`;
      }
      return `Connected • ${persistPart}`;
    }
    if (collabStatus === 'connecting') return 'Reconnecting...';
    if (collabStatus === 'disconnected') {
      if (saveState === 'editing' || saveState === 'saving') {
        return 'Disconnected • Changes will sync when reconnected';
      }
      return 'Disconnected';
    }
    if (collabStatus === 'error') return 'Connection Error';
    return null;
  })();

  return (
    <div className={styles.statusBar} role="status" aria-label="Document statistics">
      <span className={styles.statItem}>
        <strong>{stats.words.toLocaleString()}</strong> {stats.words === 1 ? 'word' : 'words'}
      </span>
      <span className={styles.dotSeparator}>•</span>
      <span className={styles.statItem}>
        <strong>{stats.characters.toLocaleString()}</strong> {stats.characters === 1 ? 'character' : 'characters'}
      </span>
      <span className={styles.dotSeparator}>•</span>
      <span className={styles.statItem}>{readingTime}</span>

      {collabStatusLabel && (
        <>
          <span className={styles.dotSeparator}>•</span>
          <span className={styles.statItem}>{collabStatusLabel}</span>
        </>
      )}
    </div>
  );
}

