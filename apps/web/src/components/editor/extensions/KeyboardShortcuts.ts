import { Extension } from '@tiptap/react';

export interface KeyboardShortcutsOptions {
  onSave?: () => void;
  onToggleLinkPopover?: () => void;
  onToggleFocusMode?: () => void;
}

export const KeyboardShortcutsExtension = Extension.create<KeyboardShortcutsOptions>({
  name: 'keyboardShortcuts',

  addOptions() {
    return {
      onSave: undefined,
      onToggleLinkPopover: undefined,
      onToggleFocusMode: undefined,
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-s': () => {
        if (!this.editor.isEditable) return false;
        if (this.options.onSave) {
          this.options.onSave();
          return true; // Prevents default browser save dialog
        }
        return false;
      },
      'Mod-k': () => {
        if (!this.editor.isEditable) return false;
        if (this.options.onToggleLinkPopover) {
          this.options.onToggleLinkPopover();
          return true; // Triggers link popover workflow
        }
        return false;
      },
      'Mod-Shift-f': () => {
        // Focus mode shortcut operates in both editable and read-only modes
        if (this.options.onToggleFocusMode) {
          this.options.onToggleFocusMode();
          return true;
        }
        return false;
      },
    };
  },
});
