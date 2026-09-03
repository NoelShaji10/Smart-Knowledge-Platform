import { AnyExtension } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import CharacterCount from '@tiptap/extension-character-count';
import { SlashCommandsExtension } from './SlashCommands';

export interface GetEditorExtensionsOptions {
  placeholder?: string;
  additionalExtensions?: AnyExtension[];
}

/**
 * Returns the default suite of enhanced Tiptap extensions for the Smart Knowledge Platform editor.
 * Retains an injection boundary (additionalExtensions) for Phase 4 collaboration extensions.
 */
export function getDefaultEditorExtensions({
  placeholder = 'Write something or press "/" for commands...',
  additionalExtensions = [],
}: GetEditorExtensionsOptions = {}): AnyExtension[] {
  return [
    StarterKit,
    Placeholder.configure({
      placeholder,
      emptyEditorClass: 'is-editor-empty',
    }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      protocols: ['http', 'https', 'mailto'],
      HTMLAttributes: {
        rel: 'noopener noreferrer',
        target: '_blank',
      },
    }),
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    Underline,
    Highlight.configure({
      multicolor: false,
    }),
    TextAlign.configure({
      types: ['heading', 'paragraph'],
    }),
    Subscript,
    Superscript,
    CharacterCount,
    SlashCommandsExtension,
    ...additionalExtensions,
  ];
}
