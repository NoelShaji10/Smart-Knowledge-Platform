import { describe, it, expect } from 'vitest';
import { getDefaultEditorExtensions } from '../components/editor/extensions';
import { Extension } from '@tiptap/react';

describe('Phase 3 T2: Enhanced Tiptap Extensions & Link Security Tests', () => {
  it('registers all required default Tiptap extensions', () => {
    const extensions = getDefaultEditorExtensions();
    const extensionNames = extensions.map((ext) => ext.name);

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
  });

  it('configures Link extension with strict security rules', () => {
    const extensions = getDefaultEditorExtensions();
    const linkExtension = extensions.find((ext) => ext.name === 'link');

    expect(linkExtension).toBeDefined();
    expect(linkExtension?.options.openOnClick).toBe(false);
    expect(linkExtension?.options.autolink).toBe(true);
    expect(linkExtension?.options.protocols).toEqual(['http', 'https', 'mailto']);
    expect(linkExtension?.options.HTMLAttributes.rel).toBe('noopener noreferrer');
    expect(linkExtension?.options.HTMLAttributes.target).toBe('_blank');
  });

  it('configures Placeholder extension with empty editor class', () => {
    const extensions = getDefaultEditorExtensions({ placeholder: 'Custom placeholder' });
    const placeholderExt = extensions.find((ext) => ext.name === 'placeholder');

    expect(placeholderExt).toBeDefined();
    expect(placeholderExt?.options.emptyEditorClass).toBe('is-editor-empty');
    expect(placeholderExt?.options.placeholder).toBe('Custom placeholder');
  });

  it('allows injecting additional extensions (Phase 4 collaboration extension boundary)', () => {
    const DummyPhase4Extension = Extension.create({ name: 'collaboration' });
    const extensions = getDefaultEditorExtensions({
      additionalExtensions: [DummyPhase4Extension],
    });

    const extensionNames = extensions.map((ext) => ext.name);
    expect(extensionNames).toContain('collaboration');
    expect(extensionNames[extensionNames.length - 1]).toBe('collaboration');
  });
});
