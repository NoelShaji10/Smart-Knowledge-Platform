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
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import * as Y from 'yjs';
import { CollabProvider } from '@/lib/collab-provider';
import { SlashCommandsExtension } from './SlashCommands';

export interface GetEditorExtensionsOptions {
  placeholder?: string;
  additionalExtensions?: AnyExtension[];
  yDoc?: Y.Doc | null;
  provider?: CollabProvider | null;
  user?: {
    name: string;
    color: string;
  };
}

/**
 * Returns the default suite of enhanced Tiptap extensions for the Smart Knowledge Platform editor.
 * When yDoc and provider are supplied (collaborative mode):
 * - StarterKit history is disabled to prevent duplicate history handlers & enable CRDT-aware undo/redo.
 * - Tiptap Collaboration extension is added with the authoritative Y.Doc.
 * - Tiptap CollaborationCursor extension is added for real-time remote cursor rendering.
 * When yDoc is not supplied (normal mode):
 * - Retains default StarterKit history and single-user editor extensions intact.
 */
export function getDefaultEditorExtensions({
  placeholder = 'Write something or press "/" for commands...',
  additionalExtensions = [],
  yDoc = null,
  provider = null,
  user,
}: GetEditorExtensionsOptions = {}): AnyExtension[] {
  const starterKitConfig = yDoc ? StarterKit.configure({ history: false }) : StarterKit;

  const extensions: AnyExtension[] = [
    starterKitConfig,
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
  ];

  if (yDoc) {
    extensions.push(Collaboration.configure({ document: yDoc }));

    if (provider && provider.awareness) {
      extensions.push(
        CollaborationCursor.configure({
          provider: provider as any,
          user: user || {
            name: 'Collaborator',
            color: '#3B82F6',
          },
        }),
      );
    }
  }

  extensions.push(...additionalExtensions);

  return extensions;
}
