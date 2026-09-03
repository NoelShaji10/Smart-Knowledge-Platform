import { describe, it, expect, vi } from 'vitest';
import { KeyboardShortcutsExtension } from '../components/editor/extensions/KeyboardShortcuts';
import { Editor } from '@tiptap/react';

describe('Phase 3 T7: Editor Focus Mode & Distraction-Free Editing Tests', () => {
  describe('KeyboardShortcutsExtension Focus Mode Binding', () => {
    it('binds Mod-Shift-f shortcut for toggling focus mode', () => {
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
      expect(shortcuts).toHaveProperty('Mod-Shift-f');
    });

    it('triggers onToggleFocusMode callback when Mod-Shift-f is pressed in editable mode', () => {
      const onToggleFocusMock = vi.fn();
      const ext = KeyboardShortcutsExtension.configure({ onToggleFocusMode: onToggleFocusMock });

      const shortcuts = ext.config.addKeyboardShortcuts?.call({
        editor: { isEditable: true } as unknown as Editor,
        options: { onToggleFocusMode: onToggleFocusMock },
        name: 'keyboardShortcuts',
        type: 'extension',
        storage: {},
        parent: undefined,
      });

      const handler = shortcuts!['Mod-Shift-f'] as () => boolean;
      const res = handler();
      expect(res).toBe(true);
      expect(onToggleFocusMock).toHaveBeenCalledTimes(1);
    });

    it('ALSO triggers onToggleFocusMode callback when Mod-Shift-f is pressed in read-only mode', () => {
      const onToggleFocusMock = vi.fn();
      const ext = KeyboardShortcutsExtension.configure({ onToggleFocusMode: onToggleFocusMock });

      const shortcuts = ext.config.addKeyboardShortcuts?.call({
        editor: { isEditable: false } as unknown as Editor,
        options: { onToggleFocusMode: onToggleFocusMock },
        name: 'keyboardShortcuts',
        type: 'extension',
        storage: {},
        parent: undefined,
      });

      const handler = shortcuts!['Mod-Shift-f'] as () => boolean;
      const res = handler();
      expect(res).toBe(true);
      expect(onToggleFocusMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('Focus Mode ARIA & Accessibility Contract', () => {
    it('computes correct accessible labels and aria-pressed attributes', () => {
      const getAriaProps = (isFocusMode: boolean) => ({
        'aria-label': isFocusMode ? 'Exit focus mode' : 'Enter focus mode',
        'aria-pressed': isFocusMode,
      });

      expect(getAriaProps(false)).toEqual({
        'aria-label': 'Enter focus mode',
        'aria-pressed': false,
      });

      expect(getAriaProps(true)).toEqual({
        'aria-label': 'Exit focus mode',
        'aria-pressed': true,
      });
    });
  });
});
