import { describe, it, expect, vi } from 'vitest';
import {
  slashCommandsList,
  filterSlashCommands,
  SlashCommandsExtension,
} from '../components/editor/extensions/SlashCommands';
import { Editor } from '@tiptap/react';

describe('Phase 3 T3: Slash Commands / Block Menu Tests', () => {
  describe('Command Registration & Exclusions', () => {
    it('registers all 10 supported basic block commands', () => {
      const commandIds = slashCommandsList.map((cmd) => cmd.id);
      expect(commandIds).toHaveLength(10);
      expect(commandIds).toEqual([
        'paragraph',
        'heading1',
        'heading2',
        'heading3',
        'bulletList',
        'orderedList',
        'taskList',
        'blockquote',
        'codeBlock',
        'horizontalRule',
      ]);
    });

    it('does NOT include unsupported or deferred commands (tables, images, AI, collaboration, etc.)', () => {
      const commandIds = slashCommandsList.map((cmd) => cmd.id);
      const unsupported = ['table', 'image', 'file', 'ai', 'comment', 'mention', 'collaboration'];

      unsupported.forEach((id) => {
        expect(commandIds).not.toContain(id);
      });
    });
  });

  describe('Search Query Filtering', () => {
    it('returns all commands when query is empty', () => {
      const results = filterSlashCommands('');
      expect(results).toHaveLength(10);
    });

    it('filters headings correctly on "/hea"', () => {
      const results = filterSlashCommands('hea');
      expect(results.map((r) => r.id)).toEqual(['heading1', 'heading2', 'heading3']);
    });

    it('filters task list correctly on "/task"', () => {
      const results = filterSlashCommands('task');
      expect(results.map((r) => r.id)).toEqual(['taskList']);
    });

    it('filters code block correctly on "/code"', () => {
      const results = filterSlashCommands('code');
      expect(results.map((r) => r.id)).toEqual(['codeBlock']);
    });

    it('filters divider correctly on "/div"', () => {
      const results = filterSlashCommands('div');
      expect(results.map((r) => r.id)).toEqual(['horizontalRule']);
    });

    it('returns empty array when query matches no commands', () => {
      const results = filterSlashCommands('xyz123unmatched');
      expect(results).toHaveLength(0);
    });
  });

  describe('Command Execution & Block Insertion', () => {
    it('executes heading 1 command by deleting range and toggling heading', () => {
      const deleteRangeMock = vi.fn().mockReturnThis();
      const toggleHeadingMock = vi.fn().mockReturnThis();
      const runMock = vi.fn().mockReturnValue(true);

      const mockEditor = {
        chain: () => ({
          focus: () => ({
            deleteRange: deleteRangeMock,
            toggleHeading: toggleHeadingMock,
            run: runMock,
          }),
        }),
      } as unknown as Editor;

      const range = { from: 0, to: 3 };
      const h1Command = slashCommandsList.find((c) => c.id === 'heading1');

      expect(h1Command).toBeDefined();
      h1Command?.command({ editor: mockEditor, range });

      expect(deleteRangeMock).toHaveBeenCalledWith(range);
      expect(toggleHeadingMock).toHaveBeenCalledWith({ level: 1 });
      expect(runMock).toHaveBeenCalled();
    });

    it('executes task list command correctly', () => {
      const deleteRangeMock = vi.fn().mockReturnThis();
      const toggleTaskListMock = vi.fn().mockReturnThis();
      const runMock = vi.fn().mockReturnValue(true);

      const mockEditor = {
        chain: () => ({
          focus: () => ({
            deleteRange: deleteRangeMock,
            toggleTaskList: toggleTaskListMock,
            run: runMock,
          }),
        }),
      } as unknown as Editor;

      const range = { from: 5, to: 10 };
      const taskCommand = slashCommandsList.find((c) => c.id === 'taskList');

      expect(taskCommand).toBeDefined();
      taskCommand?.command({ editor: mockEditor, range });

      expect(deleteRangeMock).toHaveBeenCalledWith(range);
      expect(toggleTaskListMock).toHaveBeenCalledWith();
      expect(runMock).toHaveBeenCalled();
    });
  });

  describe('Extension Configuration & Read-Only Protection', () => {
    it('registers SlashCommandsExtension with name slashCommands', () => {
      expect(SlashCommandsExtension.name).toBe('slashCommands');
    });

    it('configures slash command suggestion trigger char as "/"', () => {
      const options = SlashCommandsExtension.options;
      expect(options.suggestion.char).toBe('/');
    });
  });
});
