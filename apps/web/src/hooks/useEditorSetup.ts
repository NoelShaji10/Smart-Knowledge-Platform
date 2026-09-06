'use client';

import { useEditor, AnyExtension, Editor } from '@tiptap/react';
import * as Y from 'yjs';
import { getDefaultEditorExtensions } from '@/components/editor/extensions';
import { CollabProvider } from '@/lib/collab-provider';

export interface UseEditorSetupOptions {
  content: string;
  editable?: boolean;
  extensions?: AnyExtension[];
  onUpdate?: (props: { html: string; editor: Editor }) => void;
  autofocus?: boolean | 'start' | 'end' | 'all' | number;
  placeholder?: string;
  yDoc?: Y.Doc | null;
  provider?: CollabProvider | null;
  user?: {
    name: string;
    color: string;
  };
}

export function useEditorSetup({
  content,
  editable = true,
  extensions = [],
  onUpdate,
  autofocus = false,
  placeholder,
  yDoc = null,
  provider = null,
  user,
}: UseEditorSetupOptions) {
  const configuredExtensions = getDefaultEditorExtensions({
    placeholder,
    additionalExtensions: extensions,
    yDoc,
    provider,
    user,
  });

  const editorOptions: Parameters<typeof useEditor>[0] = {
    extensions: configuredExtensions,
    editable: editable,
    autofocus,
    onUpdate: ({ editor }) => {
      if (onUpdate) {
        onUpdate({ html: editor.getHTML(), editor });
      }
    },
  };

  // When yDoc is not present, use standard HTML content initialization.
  // When yDoc is present, Tiptap Collaboration extension owns document content initialization from Y.Doc.
  if (!yDoc) {
    editorOptions.content = content || '<p></p>';
  }

  const editor = useEditor(editorOptions, [yDoc, provider]);

  return {
    editor,
  };
}
