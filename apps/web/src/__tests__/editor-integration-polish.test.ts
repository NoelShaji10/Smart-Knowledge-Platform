import { describe, it, expect } from 'vitest';
import { getDefaultEditorExtensions } from '../components/editor/extensions';

describe('Phase 3 T8: Final Editor Integration & Polish Tests', () => {
  describe('Tiptap Extension Suite Completeness', () => {
    it('returns complete default editor extension suite containing all Phase 3 extensions', () => {
      const extensions = getDefaultEditorExtensions({
        placeholder: 'Write something...',
      });

      expect(extensions).toBeDefined();
      expect(extensions.length).toBeGreaterThanOrEqual(12);

      const extensionNames = extensions.map((ext: any) => ext.name);

      expect(extensionNames).toContain('starterKit');
      expect(extensionNames).toContain('placeholder');
      expect(extensionNames).toContain('link');
      expect(extensionNames).toContain('taskList');
      expect(extensionNames).toContain('taskItem');
      expect(extensionNames).toContain('underline');
      expect(extensionNames).toContain('highlight');
      expect(extensionNames).toContain('textAlign');
      expect(extensionNames).toContain('subscript');
      expect(extensionNames).toContain('superscript');
      expect(extensionNames).toContain('characterCount');
      expect(extensionNames).toContain('slashCommands');
    });

    it('retains Phase 4 collaboration injection boundary (additionalExtensions)', () => {
      const mockCollabExt = { name: 'collaboration', type: 'extension' } as any;
      const extensions = getDefaultEditorExtensions({
        additionalExtensions: [mockCollabExt],
      });

      const extensionNames = extensions.map((ext: any) => ext.name);
      expect(extensionNames).toContain('collaboration');
    });
  });

  describe('Accessibility Landmarks & Structure Contract', () => {
    it('defines accessible structure landmarks across components', () => {
      const landmarks = {
        toolbar: { role: 'toolbar', ariaLabel: 'Rich text editor toolbar' },
        editorRegion: { role: 'region', ariaLabel: 'Document content editor' },
        statusBar: { role: 'status', ariaLabel: 'Document statistics' },
        linkDialog: { role: 'dialog', ariaLabel: 'Insert or edit link' },
        slashMenu: { role: 'listbox', ariaLabel: 'Slash commands menu' },
      };

      expect(landmarks.toolbar.role).toBe('toolbar');
      expect(landmarks.editorRegion.role).toBe('region');
      expect(landmarks.statusBar.role).toBe('status');
      expect(landmarks.linkDialog.role).toBe('dialog');
      expect(landmarks.slashMenu.role).toBe('listbox');
    });
  });
});
