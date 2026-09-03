'use client';

import { useEditor, AnyExtension, Editor } from '@tiptap/react';
import { getDefaultEditorExtensions } from '@/components/editor/extensions';

export interface UseEditorSetupOptions {
  content: string;
  editable?: boolean;
  extensions?: AnyExtension[];
  onUpdate?: (props: { html: string; editor: Editor }) => void;
  autofocus?: boolean | 'start' | 'end' | 'all' | number;
  placeholder?: string;
}

export function useEditorSetup({
  content,
  editable = true,
  extensions = [],
  onUpdate,
  autofocus = false,
  placeholder,
}: UseEditorSetupOptions) {
  const configuredExtensions = getDefaultEditorExtensions({
    placeholder,
    additionalExtensions: extensions,
  });

  const editor = useEditor({
    extensions: configuredExtensions,
    content: content || '<p></p>',
    editable: editable,
    autofocus,
    onUpdate: ({ editor }) => {
      if (onUpdate) {
        onUpdate({ html: editor.getHTML(), editor });
      }
    },
  });

  return {
    editor,
  };
}
