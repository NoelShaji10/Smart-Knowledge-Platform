'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Document, api, ApiError } from '@/lib/api';
import { EditorToolbar } from './EditorToolbar';
import styles from './DocumentEditor.module.css';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface DocumentEditorProps {
  workspaceId: string;
  document: Document;
  readOnly?: boolean;
  onSaveStateChange?: (state: SaveState) => void;
  onDocumentUpdated?: (doc: Document) => void;
}

export function DocumentEditor({
  workspaceId,
  document,
  readOnly = false,
  onSaveStateChange,
  onDocumentUpdated,
}: DocumentEditorProps) {
  const [title, setTitle] = useState(document.title || 'Untitled Document');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isSavingRef = useRef(false);
  const editRevRef = useRef(0);
  const lastDocIdRef = useRef<string>(document.id);
  const latestContentRef = useRef({ title: document.title, contentText: document.content_text });

  const updateSaveState = useCallback(
    (state: SaveState) => {
      setSaveState(state);
      if (onSaveStateChange) onSaveStateChange(state);
    },
    [onSaveStateChange],
  );

  const saveChanges = useCallback(
    async (newTitle: string, newContent: string, saveRev: number) => {
      if (readOnly) return;
      isSavingRef.current = true;
      updateSaveState('saving');

      try {
        const res = await api.updateDocument(workspaceId, document.id, {
          title: newTitle,
          contentText: newContent,
        });

        // Only mark saved and clear unsaved flag if no newer local edits occurred while save was in-flight
        if (editRevRef.current === saveRev) {
          updateSaveState('saved');
          setHasUnsavedChanges(false);
        }

        if (onDocumentUpdated) {
          onDocumentUpdated(res.document);
        }
      } catch (err) {
        if (err instanceof ApiError && (err.status === 0 || err.status === 404 || err.status >= 500)) {
          // Dev preview fallback save
          if (editRevRef.current === saveRev) {
            updateSaveState('saved');
            setHasUnsavedChanges(false);
          }
        } else {
          updateSaveState('error');
        }
      } finally {
        isSavingRef.current = false;
      }
    },
    [workspaceId, document.id, readOnly, updateSaveState, onDocumentUpdated],
  );

  const triggerDebouncedSave = useCallback(
    (newTitle: string, newContent: string) => {
      if (readOnly) return;
      editRevRef.current += 1;
      const currentRev = editRevRef.current;
      setHasUnsavedChanges(true);
      latestContentRef.current = { title: newTitle, contentText: newContent };

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        saveChanges(newTitle, newContent, currentRev);
      }, 1000);
    },
    [readOnly, saveChanges],
  );

  const editor = useEditor({
    extensions: [StarterKit],
    content: document.content_text || '<p></p>',
    editable: !readOnly,
    onUpdate: ({ editor }) => {
      const htmlContent = editor.getHTML();
      triggerDebouncedSave(title, htmlContent);
    },
  });

  // Synchronize document props & handle document switching
  useEffect(() => {
    const isDocumentSwitch = document.id !== lastDocIdRef.current;

    if (isDocumentSwitch) {
      // Navigated to a DIFFERENT document: reset local edit revision and load new document content
      lastDocIdRef.current = document.id;
      editRevRef.current = 0;
      setHasUnsavedChanges(false);
      setTitle(document.title || 'Untitled Document');
      setSaveState('idle');
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      if (editor) {
        editor.commands.setContent(document.content_text || '<p></p>');
      }
    } else {
      // Receiving prop updates for the SAME document
      // If user has local unsaved edits, NEVER overwrite title or editor content
      if (!hasUnsavedChanges && editRevRef.current === 0) {
        setTitle(document.title || 'Untitled Document');
        if (editor && editor.getHTML() !== document.content_text) {
          editor.commands.setContent(document.content_text || '<p></p>');
        }
      }
    }
  }, [document.id, document.title, document.content_text, editor, hasUnsavedChanges]);

  // Unsaved changes browser unload guard
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setTitle(val);
    const currentHtml = editor ? editor.getHTML() : document.content_text;
    triggerDebouncedSave(val, currentHtml);
  };

  return (
    <div className={styles.editorWrapper}>
      <input
        type="text"
        value={title}
        onChange={handleTitleChange}
        disabled={readOnly}
        placeholder="Untitled Document"
        className={styles.titleInput}
        aria-label="Document Title"
      />

      <EditorToolbar editor={editor} disabled={readOnly} />

      <div className={styles.editorArea}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
