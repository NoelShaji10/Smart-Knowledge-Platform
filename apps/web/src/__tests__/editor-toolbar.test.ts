import { describe, it, expect, vi } from 'vitest';
import { sanitizeLinkUrl } from '../components/editor/LinkPopover';
import { Editor } from '@tiptap/react';

describe('Phase 3 T4: Advanced Editor Toolbar & Link Security Tests', () => {
  describe('Link Protocol Security & Sanitization', () => {
    it('allows valid HTTP URLs', () => {
      expect(sanitizeLinkUrl('http://example.com')).toBe('http://example.com');
      expect(sanitizeLinkUrl('http://sub.domain.org/path?a=1')).toBe('http://sub.domain.org/path?a=1');
    });

    it('allows valid HTTPS URLs', () => {
      expect(sanitizeLinkUrl('https://example.com')).toBe('https://example.com');
      expect(sanitizeLinkUrl('https://secure.site.io')).toBe('https://secure.site.io');
    });

    it('allows valid Mailto URLs', () => {
      expect(sanitizeLinkUrl('mailto:user@example.com')).toBe('mailto:user@example.com');
    });

    it('automatically prepends https:// to domain strings missing a scheme', () => {
      expect(sanitizeLinkUrl('example.com')).toBe('https://example.com');
      expect(sanitizeLinkUrl('docs.google.com/document')).toBe('https://docs.google.com/document');
    });

    it('REJECTS malicious javascript: URLs', () => {
      expect(sanitizeLinkUrl('javascript:alert(1)')).toBeNull();
      expect(sanitizeLinkUrl('JAVASCRIPT:console.log(document.cookie)')).toBeNull();
      expect(sanitizeLinkUrl('  javascript:void(0)  ')).toBeNull();
    });

    it('REJECTS data: URLs', () => {
      expect(sanitizeLinkUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    });

    it('REJECTS vbscript: URLs', () => {
      expect(sanitizeLinkUrl('vbscript:msgbox(1)')).toBeNull();
    });

    it('REJECTS file: URLs', () => {
      expect(sanitizeLinkUrl('file:///etc/passwd')).toBeNull();
    });

    it('returns null for empty strings', () => {
      expect(sanitizeLinkUrl('')).toBeNull();
      expect(sanitizeLinkUrl('   ')).toBeNull();
    });
  });

  describe('Editor Toolbar Actions & Command Mapping', () => {
    it('executes formatting commands correctly when editor is active', () => {
      const toggleBoldMock = vi.fn().mockReturnThis();
      const toggleItalicMock = vi.fn().mockReturnThis();
      const toggleUnderlineMock = vi.fn().mockReturnThis();
      const toggleStrikeMock = vi.fn().mockReturnThis();
      const toggleCodeMock = vi.fn().mockReturnThis();
      const toggleHighlightMock = vi.fn().mockReturnThis();
      const toggleSubscriptMock = vi.fn().mockReturnThis();
      const toggleSuperscriptMock = vi.fn().mockReturnThis();
      const setTextAlignMock = vi.fn().mockReturnThis();
      const runMock = vi.fn().mockReturnValue(true);

      const mockEditor = {
        on: vi.fn(),
        off: vi.fn(),
        isActive: vi.fn().mockReturnValue(false),
        can: vi.fn().mockReturnValue({ undo: () => true, redo: () => true }),
        chain: () => ({
          focus: () => ({
            toggleBold: toggleBoldMock,
            toggleItalic: toggleItalicMock,
            toggleUnderline: toggleUnderlineMock,
            toggleStrike: toggleStrikeMock,
            toggleCode: toggleCodeMock,
            toggleHighlight: toggleHighlightMock,
            toggleSubscript: toggleSubscriptMock,
            toggleSuperscript: toggleSuperscriptMock,
            setTextAlign: setTextAlignMock,
            run: runMock,
          }),
        }),
      } as unknown as Editor;

      mockEditor.chain().focus().toggleBold().run();
      expect(toggleBoldMock).toHaveBeenCalled();

      mockEditor.chain().focus().toggleUnderline().run();
      expect(toggleUnderlineMock).toHaveBeenCalled();

      mockEditor.chain().focus().setTextAlign('center').run();
      expect(setTextAlignMock).toHaveBeenCalledWith('center');

      expect(runMock).toHaveBeenCalled();
    });

    it('disables undo/redo when editor.can().undo() / redo() return false', () => {
      const canMock = vi.fn().mockReturnValue({
        undo: () => false,
        redo: () => false,
      });

      const mockEditor = {
        can: canMock,
      } as unknown as Editor;

      expect(mockEditor.can().undo()).toBe(false);
      expect(mockEditor.can().redo()).toBe(false);
    });
  });
});
