'use client';

import React, { createContext, useContext } from 'react';
import { Editor } from '@tiptap/react';
import { SaveState } from '../hooks/useEditorAutosave';

export type EditorMode = 'editing' | 'readonly' | 'preview'; // Ready for Phase 4: | 'collaborative'

export interface EditorContextType {
  editor: Editor | null;
  readOnly: boolean;
  saveState: SaveState;
  hasUnsavedChanges: boolean;
  editorMode: EditorMode;
  isFocusMode?: boolean;
  toggleFocusMode?: () => void;
  triggerSave?: (title: string, content: string) => void;
}

const EditorContext = createContext<EditorContextType | undefined>(undefined);

export interface EditorProviderProps {
  children: React.ReactNode;
  value: EditorContextType;
}

export function EditorProvider({ children, value }: EditorProviderProps) {
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditorContext(): EditorContextType {
  const context = useContext(EditorContext);
  if (!context) {
    throw new Error('useEditorContext must be used within an EditorProvider');
  }
  return context;
}
