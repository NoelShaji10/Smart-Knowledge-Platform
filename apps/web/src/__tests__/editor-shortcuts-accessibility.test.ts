import { describe, it, expect, vi } from 'vitest';
import { KeyboardShortcutsExtension } from '../components/editor/extensions/KeyboardShortcuts';
import { getModifierKeyLabel } from '../components/editor/EditorToolbar';
import { Editor } from '@tiptap/react';

describe('Phase 3 T5: Keyboard Shortcuts & Accessibility Tests', () => {
  describe('OS Modifier Key Helper', () => {
    it('returns a valid modifier key label string (Ctrl or ⌘)', () => {
      const mod = getModifierKeyLabel();
      expect(['Ctrl', '⌘']).toContain(mod);
    });
  });

  describe('KeyboardShortcutsExtension Configuration & Safety', () => {
    it('registers Extension with name keyboardShortcuts', () => {
      expect(KeyboardShortcutsExtension.name).toBe('keyboardShortcuts');
    });

    it('binds Mod-s and Mod-k keyboard shortcuts', () => {
      const ext = KeyboardShortcutsExtension.configure({});
      const shortcuts = ext.config.addKeyboardShortcuts?.call({
        editor: { isEditable: true } as unknown as Editor,
        options: {},
        name: 'keyboardShortcuts',
        type: 'extension',
        storage: {},
        parent: undefined,
      });

      expect(shortcuts).toBeDefined();
      expect(shortcuts).toHaveProperty('Mod-s');
      expect(shortcuts).toHaveProperty('Mod-k');
    });

    it('executes onSave callback on Mod-s when editor is editable', () => {
      const onSaveMock = vi.fn();
      const ext = KeyboardShortcutsExtension.configure({ onSave: onSaveMock });

      const shortcuts = ext.config.addKeyboardShortcuts?.call({
        editor: { isEditable: true } as unknown as Editor,
        options: { onSave: onSaveMock },
        name: 'keyboardShortcuts',
        type: 'extension',
        storage: {},
        parent: undefined,
      });

      const handler = shortcuts!['Mod-s'] as () => boolean;
      const res = handler();
      expect(res).toBe(true);
      expect(onSaveMock).toHaveBeenCalled();
    });

    it('SUPPRESSES Mod-s shortcut execution when editor is read-only (isEditable = false)', () => {
      const onSaveMock = vi.fn();
      const ext = KeyboardShortcutsExtension.configure({ onSave: onSaveMock });

      const shortcuts = ext.config.addKeyboardShortcuts?.call({
        editor: { isEditable: false } as unknown as Editor,
        options: { onSave: onSaveMock },
        name: 'keyboardShortcuts',
        type: 'extension',
        storage: {},
        parent: undefined,
      });

      const handler = shortcuts!['Mod-s'] as () => boolean;
      const res = handler();
      expect(res).toBe(false);
      expect(onSaveMock).not.toHaveBeenCalled();
    });

    it('executes onToggleLinkPopover callback on Mod-k when editor is editable', () => {
      const onToggleMock = vi.fn();
      const ext = KeyboardShortcutsExtension.configure({ onToggleLinkPopover: onToggleMock });

      const shortcuts = ext.config.addKeyboardShortcuts?.call({
        editor: { isEditable: true } as unknown as Editor,
        options: { onToggleLinkPopover: onToggleMock },
        name: 'keyboardShortcuts',
        type: 'extension',
        storage: {},
        parent: undefined,
      });

      const handler = shortcuts!['Mod-k'] as () => boolean;
      const res = handler();
      expect(res).toBe(true);
      expect(onToggleMock).toHaveBeenCalled();
    });

    it('SUPPRESSES Mod-k shortcut execution when editor is read-only (isEditable = false)', () => {
      const onToggleMock = vi.fn();
      const ext = KeyboardShortcutsExtension.configure({ onToggleLinkPopover: onToggleMock });

      const shortcuts = ext.config.addKeyboardShortcuts?.call({
        editor: { isEditable: false } as unknown as Editor,
        options: { onToggleLinkPopover: onToggleMock },
        name: 'keyboardShortcuts',
        type: 'extension',
        storage: {},
        parent: undefined,
      });

      const handler = shortcuts!['Mod-k'] as () => boolean;
      const res = handler();
      expect(res).toBe(false);
      expect(onToggleMock).not.toHaveBeenCalled();
    });
  });
});
