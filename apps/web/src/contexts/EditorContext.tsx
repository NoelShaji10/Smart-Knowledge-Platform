'use client';

import React, { createContext, useContext } from 'react';
import { Editor } from '@tiptap/react';
import { SaveState } from '../hooks/useEditorAutosave';
import { CollabProviderStatus } from '@/lib/collab-provider';
import { CollabUser } from '@/hooks/useCollaboration';

export type EditorMode = 'editing' | 'readonly' | 'preview' | 'collaborative';

export interface EditorContextType {
  editor: Editor | null;
  readOnly: boolean;
  saveState: SaveState;
  hasUnsavedChanges: boolean;
  editorMode: EditorMode;
  isFocusMode?: boolean;
  toggleFocusMode?: () => void;
  triggerSave?: (title: string, content: string) => void;
  collabStatus?: CollabProviderStatus;
  connectedUsers?: CollabUser[];
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
