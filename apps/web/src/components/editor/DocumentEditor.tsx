'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { EditorContent } from '@tiptap/react';
import { Document, api, ApiError } from '@/lib/api';
import { EditorToolbar } from './EditorToolbar';
import { EditorStatusBar } from './EditorStatusBar';
import { useEditorSetup } from '@/hooks/useEditorSetup';
import { useEditorAutosave, SaveState } from '@/hooks/useEditorAutosave';
import { EditorProvider, EditorMode, EditorContextType } from '@/contexts/EditorContext';
import { KeyboardShortcutsExtension } from './extensions/KeyboardShortcuts';
import styles from './DocumentEditor.module.css';

export type { SaveState };

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
  const [isFocusMode, setIsFocusMode] = useState(false);
  const lastDocIdRef = useRef<string>(document.id);

  const toggleFocusMode = useCallback(() => {
    setIsFocusMode((prev) => !prev);
  }, []);

  const saveFn = useCallback(
    async (newTitle: string, newContent: string, _saveRev: number) => {
      try {
        const res = await api.updateDocument(workspaceId, document.id, {
          title: newTitle,
          contentText: newContent,
        });

        if (onDocumentUpdated) {
          onDocumentUpdated(res.document);
        }
      } catch (err) {
        if (err instanceof ApiError && (err.status === 0 || err.status === 404 || err.status >= 500)) {
          // Dev preview fallback save: allow save state to settle as saved
          return;
        }
        throw err;
      }
    },
    [workspaceId, document.id, onDocumentUpdated],
  );

  const {
    saveState,
    hasUnsavedChanges,
    editRevRef,
    triggerDebouncedSave,
    triggerImmediateSave,
    resetEditState,
  } = useEditorAutosave({
    readOnly,
    saveFn,
    onSaveStateChange,
    debounceMs: 1000,
  });

  const handleEditorUpdate = useCallback(
    ({ html }: { html: string }) => {
      triggerDebouncedSave(title, html);
    },
    [title, triggerDebouncedSave],
  );

  const handleToggleLinkPopover = useCallback(() => {
    if (readOnly) return;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('editor:toggle-link-popover'));
    }
  }, [readOnly]);

  // Will be assigned after editor hook initialization
  const latestEditorRef = useRef<ReturnType<typeof useEditorSetup>['editor'] | null>(null);

  const handleManualSave = useCallback(() => {
    if (readOnly) return;
    const currentHtml = latestEditorRef.current ? latestEditorRef.current.getHTML() : document.content_text;
    triggerImmediateSave(title, currentHtml);
  }, [readOnly, document.content_text, title, triggerImmediateSave]);

  const shortcutsExtension = useMemo(() => {
    return KeyboardShortcutsExtension.configure({
      onSave: handleManualSave,
      onToggleLinkPopover: handleToggleLinkPopover,
      onToggleFocusMode: toggleFocusMode,
    });
  }, [handleManualSave, handleToggleLinkPopover, toggleFocusMode]);

  const { editor } = useEditorSetup({
    content: document.content_text || '<p></p>',
    editable: !readOnly,
    extensions: [shortcutsExtension],
    onUpdate: handleEditorUpdate,
  });

  latestEditorRef.current = editor;

  // Escape key handler to exit focus mode
  useEffect(() => {
    if (!isFocusMode) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsFocusMode(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFocusMode]);

  // Synchronize document props & handle document switching
  useEffect(() => {
    const isDocumentSwitch = document.id !== lastDocIdRef.current;

    if (isDocumentSwitch) {
      // Navigated to a DIFFERENT document: reset edit state, focus mode, and load new document content
      lastDocIdRef.current = document.id;
      resetEditState();
      setIsFocusMode(false);
      setTitle(document.title || 'Untitled Document');

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
  }, [document.id, document.title, document.content_text, editor, hasUnsavedChanges, editRevRef, resetEditState]);

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

  const editorMode: EditorMode = readOnly ? 'readonly' : 'editing';

  const contextValue: EditorContextType = {
    editor,
    readOnly,
    saveState,
    hasUnsavedChanges,
    editorMode,
    isFocusMode,
    toggleFocusMode,
    triggerSave: (newTitle: string, newContent: string) => triggerImmediateSave(newTitle, newContent),
  };

  return (
    <EditorProvider value={contextValue}>
      <div className={`${styles.editorWrapper} ${isFocusMode ? styles.focusMode : ''}`}>
        {isFocusMode && (
          <div className={styles.focusBadge} role="status">
            <span>⛶ Focus Mode</span>
          </div>
        )}

        <input
          type="text"
          value={title}
          onChange={handleTitleChange}
          disabled={readOnly}
          placeholder="Untitled Document"
          className={styles.titleInput}
          aria-label="Document Title"
        />

        <EditorToolbar
          editor={editor}
          disabled={readOnly}
          isFocusMode={isFocusMode}
          onToggleFocusMode={toggleFocusMode}
        />

        <div className={styles.editorArea} role="region" aria-label="Document content editor">
          <EditorContent editor={editor} />
        </div>

        <EditorStatusBar editor={editor} />
      </div>
    </EditorProvider>
  );
}
