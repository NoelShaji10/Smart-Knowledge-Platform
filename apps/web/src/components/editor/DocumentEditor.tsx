'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { EditorContent } from '@tiptap/react';
import { Document, api, ApiError } from '@/lib/api';
import { EditorToolbar } from './EditorToolbar';
import { EditorStatusBar } from './EditorStatusBar';
import { useEditorSetup } from '@/hooks/useEditorSetup';
import { useEditorAutosave, SaveState } from '@/hooks/useEditorAutosave';
import { useCollaboration } from '@/hooks/useCollaboration';
import { useAuth } from '@/contexts/AuthContext';
import { getCollaboratorColor } from '@/lib/collab-colors';
import { EditorProvider, EditorMode, EditorContextType } from '@/contexts/EditorContext';
import { KeyboardShortcutsExtension } from './extensions/KeyboardShortcuts';
import { ConnectionStatusBanner } from './ConnectionStatusBanner';
import styles from './DocumentEditor.module.css';

export type { SaveState };

export interface DocumentEditorProps {
  workspaceId: string;
  document: Document;
  readOnly?: boolean;
  collaborative?: boolean;
  onSaveStateChange?: (state: SaveState) => void;
  onDocumentUpdated?: (doc: Document) => void;
}

export function DocumentEditor({
  workspaceId,
  document,
  readOnly = false,
  collaborative,
  onSaveStateChange,
  onDocumentUpdated,
}: DocumentEditorProps) {
  const isCollaborative = collaborative ?? (!readOnly && !document.is_archived);
  const { user: authUser } = useAuth();

  const [title, setTitle] = useState(document.title || 'Untitled Document');
  const [isFocusMode, setIsFocusMode] = useState(false);
  const lastDocIdRef = useRef<string>(document.id);
  const titleEditRevRef = useRef<number>(0);
  const titleDebounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const toggleFocusMode = useCallback(() => {
    setIsFocusMode((prev) => !prev);
  }, []);

  const currentUser = useMemo(() => {
    if (!authUser) return undefined;
    const name = authUser.displayName || authUser.email?.split('@')[0] || 'User';
    return {
      id: authUser.id,
      displayName: name,
      color: getCollaboratorColor(authUser.id),
    };
  }, [authUser]);

  // 1. Collaboration Hook Lifecycle
  const { provider, yDoc, status: collabStatus, connectedUsers } = useCollaboration({
    workspaceId,
    documentId: document.id,
    enabled: isCollaborative,
    user: currentUser,
  });

  const saveFn = useCallback(
    async (newTitle: string, newContent: string, _saveRev: number) => {
      if (isCollaborative) return;
      const res = await api.updateDocument(workspaceId, document.id, {
        title: newTitle,
        contentText: newContent,
      });

      if (onDocumentUpdated) {
        onDocumentUpdated(res.document);
      }
    },
    [workspaceId, document.id, onDocumentUpdated, isCollaborative],
  );

  const triggerCollabTitleSave = useCallback(
    (newTitle: string) => {
      titleEditRevRef.current += 1;
      const currentRev = titleEditRevRef.current;

      if (titleDebounceTimerRef.current) {
        clearTimeout(titleDebounceTimerRef.current);
      }

      titleDebounceTimerRef.current = setTimeout(async () => {
        try {
          const res = await api.updateDocument(workspaceId, document.id, { title: newTitle });
          if (titleEditRevRef.current === currentRev) {
            titleEditRevRef.current = 0;
            if (onDocumentUpdated) {
              onDocumentUpdated(res.document);
            }
          }
        } catch (err) {
          console.error('Failed to update title in collaborative mode:', err);
        }
      }, 500);
    },
    [workspaceId, document.id, onDocumentUpdated],
  );

  useEffect(() => {
    return () => {
      if (titleDebounceTimerRef.current) {
        clearTimeout(titleDebounceTimerRef.current);
      }
    };
  }, []);

  // In collaborative mode, disable autosave completely (readOnly: true)
  const {
    saveState,
    hasUnsavedChanges,
    editRevRef,
    triggerDebouncedSave,
    triggerImmediateSave,
    resetEditState,
  } = useEditorAutosave({
    readOnly: readOnly || isCollaborative,
    saveFn,
    onSaveStateChange,
    debounceMs: 1000,
  });

  const handleEditorUpdate = useCallback(
    ({ html }: { html: string }) => {
      if (isCollaborative) return;
      triggerDebouncedSave(title, html);
    },
    [title, triggerDebouncedSave, isCollaborative],
  );

  const handleToggleLinkPopover = useCallback(() => {
    if (readOnly) return;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('editor:toggle-link-popover'));
    }
  }, [readOnly]);

  const latestEditorRef = useRef<ReturnType<typeof useEditorSetup>['editor'] | null>(null);

  const handleManualSave = useCallback(() => {
    if (readOnly || isCollaborative) return;
    const currentHtml = latestEditorRef.current ? latestEditorRef.current.getHTML() : document.content_text;
    triggerImmediateSave(title, currentHtml);
  }, [readOnly, isCollaborative, document.content_text, title, triggerImmediateSave]);

  const isEditable = useMemo(() => {
    if (readOnly) return false;
    if (isCollaborative) {
      return collabStatus === 'connected';
    }
    return true;
  }, [readOnly, isCollaborative, collabStatus]);

  const shortcutsExtension = useMemo(() => {
    return KeyboardShortcutsExtension.configure({
      onSave: handleManualSave,
      onToggleLinkPopover: handleToggleLinkPopover,
      onToggleFocusMode: toggleFocusMode,
    });
  }, [handleManualSave, handleToggleLinkPopover, toggleFocusMode]);

  // 2. Editor Setup with yDoc and provider for collaborative mode
  const { editor } = useEditorSetup({
    content: document.content_text || '<p></p>',
    editable: isEditable,
    extensions: [shortcutsExtension],
    onUpdate: handleEditorUpdate,
    yDoc: isCollaborative ? yDoc : null,
    provider: isCollaborative ? provider : null,
    user: currentUser ? { name: currentUser.displayName, color: currentUser.color } : undefined,
  });

  latestEditorRef.current = editor;

  // Dynamically set editor editable state when connection status or readOnly state changes
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.setEditable(isEditable);
    }
  }, [editor, isEditable]);

  // Escape key handler for focus mode
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

  // 3. Document prop synchronization
  useEffect(() => {
    const isDocumentSwitch = document.id !== lastDocIdRef.current;

    if (isDocumentSwitch) {
      lastDocIdRef.current = document.id;
      if (titleDebounceTimerRef.current) {
        clearTimeout(titleDebounceTimerRef.current);
        titleDebounceTimerRef.current = null;
      }
      titleEditRevRef.current = 0;
      resetEditState();
      setIsFocusMode(false);
      setTitle(document.title || 'Untitled Document');

      if (!isCollaborative && editor) {
        editor.commands.setContent(document.content_text || '<p></p>');
      }
    } else {
      if (!isCollaborative) {
        if (!hasUnsavedChanges && editRevRef.current === 0) {
          setTitle(document.title || 'Untitled Document');
          if (editor && editor.getHTML() !== document.content_text) {
            editor.commands.setContent(document.content_text || '<p></p>');
          }
        }
      } else {
        if (titleEditRevRef.current === 0) {
          setTitle(document.title || 'Untitled Document');
        }
      }
    }
  }, [
    document.id,
    document.title,
    document.content_text,
    editor,
    hasUnsavedChanges,
    editRevRef,
    resetEditState,
    isCollaborative,
  ]);

  // Unsaved changes unload guard
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (!isCollaborative && hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges, isCollaborative]);

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setTitle(val);
    if (!isCollaborative) {
      const currentHtml = editor ? editor.getHTML() : document.content_text;
      triggerDebouncedSave(val, currentHtml);
    } else {
      triggerCollabTitleSave(val);
    }
  };

  const editorMode: EditorMode = isCollaborative
    ? 'collaborative'
    : readOnly
    ? 'readonly'
    : 'editing';

  const contextValue: EditorContextType = {
    editor,
    readOnly: !isEditable,
    saveState: isCollaborative ? 'saved' : saveState,
    hasUnsavedChanges: isCollaborative ? false : hasUnsavedChanges,
    editorMode,
    isFocusMode,
    toggleFocusMode,
    triggerSave: (newTitle: string, newContent: string) => {
      if (!isCollaborative) triggerImmediateSave(newTitle, newContent);
    },
    collabStatus,
    connectedUsers: isCollaborative ? connectedUsers : [],
  };

  return (
    <EditorProvider value={contextValue}>
      <div className={`${styles.editorWrapper} ${isFocusMode ? styles.focusMode : ''}`}>
        {isFocusMode && (
          <div className={styles.focusBadge} role="status">
            <span>⛶ Focus Mode</span>
          </div>
        )}

        {isCollaborative && (
          <ConnectionStatusBanner
            status={collabStatus}
            readOnly={readOnly}
            onRetry={() => {
              if (provider) {
                provider.connect();
              }
            }}
          />
        )}

        <input
          type="text"
          value={title}
          onChange={handleTitleChange}
          disabled={readOnly || (isCollaborative && collabStatus !== 'connected')}
          placeholder="Untitled Document"
          className={styles.titleInput}
          aria-label="Document Title"
        />

        <EditorToolbar
          editor={editor}
          disabled={readOnly || (isCollaborative && collabStatus !== 'connected')}
          isFocusMode={isFocusMode}
          onToggleFocusMode={toggleFocusMode}
        />

        <div className={styles.editorArea} role="region" aria-label="Document content editor">
          <EditorContent editor={editor} />
        </div>

        <EditorStatusBar
          editor={editor}
          collabStatus={isCollaborative ? collabStatus : undefined}
          connectedUsers={isCollaborative ? connectedUsers : []}
          readOnly={readOnly || (isCollaborative && collabStatus !== 'connected')}
        />
      </div>
    </EditorProvider>
  );
}
