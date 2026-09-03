import { Extension, ReactRenderer, Editor, Range } from '@tiptap/react';
import Suggestion, { SuggestionOptions, SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion';
import { SlashCommandMenu, SlashCommandMenuRef } from '../SlashCommandMenu';

export interface SlashCommandItem {
  id: string;
  title: string;
  description: string;
  category: 'Basic blocks' | 'Lists' | 'Advanced';
  icon: string;
  command: (props: { editor: Editor; range: Range }) => void;
}

export const slashCommandsList: SlashCommandItem[] = [
  {
    id: 'paragraph',
    title: 'Text',
    description: 'Just start typing with plain text.',
    category: 'Basic blocks',
    icon: 'P',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setParagraph().run();
    },
  },
  {
    id: 'heading1',
    title: 'Heading 1',
    description: 'Big section heading.',
    category: 'Basic blocks',
    icon: 'H1',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run();
    },
  },
  {
    id: 'heading2',
    title: 'Heading 2',
    description: 'Medium section heading.',
    category: 'Basic blocks',
    icon: 'H2',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run();
    },
  },
  {
    id: 'heading3',
    title: 'Heading 3',
    description: 'Small section heading.',
    category: 'Basic blocks',
    icon: 'H3',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleHeading({ level: 3 }).run();
    },
  },
  {
    id: 'bulletList',
    title: 'Bullet List',
    description: 'Create a simple bulleted list.',
    category: 'Lists',
    icon: '•',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run();
    },
  },
  {
    id: 'orderedList',
    title: 'Numbered List',
    description: 'Create a list with numbering.',
    category: 'Lists',
    icon: '1.',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run();
    },
  },
  {
    id: 'taskList',
    title: 'Task List',
    description: 'Track tasks with a todo checklist.',
    category: 'Lists',
    icon: '☐',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleTaskList().run();
    },
  },
  {
    id: 'blockquote',
    title: 'Quote',
    description: 'Capture a quote or citation.',
    category: 'Advanced',
    icon: '"',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBlockquote().run();
    },
  },
  {
    id: 'codeBlock',
    title: 'Code Block',
    description: 'Display code snippet with formatting.',
    category: 'Advanced',
    icon: '</>',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
    },
  },
  {
    id: 'horizontalRule',
    title: 'Divider',
    description: 'Visually divide page with a horizontal line.',
    category: 'Advanced',
    icon: '—',
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHorizontalRule().run();
    },
  },
];

export function filterSlashCommands(query: string): SlashCommandItem[] {
  const cleanQuery = query.toLowerCase().trim();
  if (!cleanQuery) return slashCommandsList;

  return slashCommandsList.filter((item) => {
    return (
      item.title.toLowerCase().includes(cleanQuery) ||
      item.description.toLowerCase().includes(cleanQuery) ||
      item.category.toLowerCase().includes(cleanQuery)
    );
  });
}

export const SlashCommandsExtension = Extension.create({
  name: 'slashCommands',

  addOptions() {
    return {
      suggestion: {
        char: '/',
        startOfLine: false,
        items: ({ query }: { query: string }) => filterSlashCommands(query),
        render: () => {
          let component: ReactRenderer<SlashCommandMenuRef> | null = null;
          let popupContainer: HTMLElement | null = null;

          function updatePosition(props: SuggestionProps) {
            if (!popupContainer || !props.clientRect) return;
            const rect = props.clientRect();
            if (!rect) return;

            popupContainer.style.left = `${rect.left}px`;
            popupContainer.style.top = `${rect.bottom + 6}px`;
          }

          function destroy() {
            if (popupContainer && popupContainer.parentNode) {
              popupContainer.parentNode.removeChild(popupContainer);
            }
            popupContainer = null;
            if (component) {
              component.destroy();
              component = null;
            }
          }

          return {
            onStart: (props: SuggestionProps) => {
              if (!props.editor.isEditable) return;

              component = new ReactRenderer(SlashCommandMenu, {
                props: {
                  items: props.items as SlashCommandItem[],
                  command: (item: SlashCommandItem) => {
                    item.command({ editor: props.editor, range: props.range });
                    destroy();
                  },
                },
                editor: props.editor,
              });

              if (typeof document !== 'undefined') {
                popupContainer = document.createElement('div');
                popupContainer.style.position = 'fixed';
                popupContainer.style.zIndex = '9999';
                popupContainer.style.pointerEvents = 'auto';

                document.body.appendChild(popupContainer);
                popupContainer.appendChild(component.element);

                updatePosition(props);
              }
            },

            onUpdate(props: SuggestionProps) {
              if (!props.editor.isEditable) {
                destroy();
                return;
              }

              if (component) {
                component.updateProps({
                  items: props.items as SlashCommandItem[],
                  command: (item: SlashCommandItem) => {
                    item.command({ editor: props.editor, range: props.range });
                    destroy();
                  },
                });
              }
              updatePosition(props);
            },

            onKeyDown(props: SuggestionKeyDownProps) {
              if (props.event.key === 'Escape') {
                destroy();
                return true;
              }

              return component?.ref?.onKeyDown?.({ event: props.event }) ?? false;
            },

            onExit() {
              destroy();
            },
          };
        },
      } as Partial<SuggestionOptions>,
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
