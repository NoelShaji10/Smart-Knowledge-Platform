'use client';

import React, { useState, useEffect } from 'react';
import { Editor } from '@tiptap/react';
import { LinkPopover, sanitizeLinkUrl } from './LinkPopover';
import styles from './EditorToolbar.module.css';

export interface EditorToolbarProps {
  editor: Editor | null;
  disabled?: boolean;
  isFocusMode?: boolean;
  onToggleFocusMode?: () => void;
}

export function getModifierKeyLabel(): string {
  if (typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)) {
    return '⌘';
  }
  return 'Ctrl';
}

export function EditorToolbar({
  editor,
  disabled = false,
  isFocusMode = false,
  onToggleFocusMode,
}: EditorToolbarProps) {
  const [showLinkPopover, setShowLinkPopover] = useState(false);
  const [, setTick] = useState(0);

  // Force re-render on editor transaction updates so isActive / can states stay synchronized
  useEffect(() => {
    if (!editor) return;
    const handler = () => setTick((t) => t + 1);
    editor.on('transaction', handler);
    return () => {
      editor.off('transaction', handler);
    };
  }, [editor]);

  // Handle keyboard shortcut event (Mod-k) for toggling link popover
  useEffect(() => {
    const handleToggleLinkPopover = () => {
      if (!disabled && editor && editor.isEditable) {
        setShowLinkPopover((prev) => !prev);
      }
    };

    window.addEventListener('editor:toggle-link-popover', handleToggleLinkPopover);
    return () => {
      window.removeEventListener('editor:toggle-link-popover', handleToggleLinkPopover);
    };
  }, [disabled, editor]);

  if (!editor) return null;

  const modKey = getModifierKeyLabel();

  const currentBlockValue = (() => {
    if (editor.isActive('heading', { level: 1 })) return 'h1';
    if (editor.isActive('heading', { level: 2 })) return 'h2';
    if (editor.isActive('heading', { level: 3 })) return 'h3';
    return 'p';
  })();

  const handleBlockChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val === 'h1') editor.chain().focus().toggleHeading({ level: 1 }).run();
    else if (val === 'h2') editor.chain().focus().toggleHeading({ level: 2 }).run();
    else if (val === 'h3') editor.chain().focus().toggleHeading({ level: 3 }).run();
    else editor.chain().focus().setParagraph().run();
  };

  const isLinkActive = editor.isActive('link');
  const currentLinkUrl = isLinkActive ? editor.getAttributes('link').href || '' : '';

  const handleApplyLink = (url: string) => {
    const clean = sanitizeLinkUrl(url);
    if (clean) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: clean }).run();
    }
    setShowLinkPopover(false);
  };

  const handleRemoveLink = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setShowLinkPopover(false);
  };

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Rich text editor toolbar">
      {/* 1. History */}
      <button
        type="button"
        className={styles.btn}
        onClick={() => editor.chain().focus().undo().run()}
        disabled={disabled || !editor.can().undo()}
        title={`Undo (${modKey}+Z)`}
        aria-label="Undo"
      >
        ↺
      </button>
      <button
        type="button"
        className={styles.btn}
        onClick={() => editor.chain().focus().redo().run()}
        disabled={disabled || !editor.can().redo()}
        title={`Redo (${modKey}+Y)`}
        aria-label="Redo"
      >
        ↻
      </button>

      <span className={styles.divider} role="separator" />

      {/* 2. Block Selector */}
      <select
        className={styles.blockSelect}
        value={currentBlockValue}
        onChange={handleBlockChange}
        disabled={disabled}
        aria-label="Text block style"
      >
        <option value="p">Paragraph</option>
        <option value="h1">Heading 1</option>
        <option value="h2">Heading 2</option>
        <option value="h3">Heading 3</option>
      </select>

      <span className={styles.divider} role="separator" />

      {/* 3. Inline Formats */}
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('bold') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleBold().run()}
        disabled={disabled}
        aria-label="Bold"
        aria-pressed={editor.isActive('bold')}
        title={`Bold (${modKey}+B)`}
      >
        <strong>B</strong>
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('italic') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        disabled={disabled}
        aria-label="Italic"
        aria-pressed={editor.isActive('italic')}
        title={`Italic (${modKey}+I)`}
      >
        <em>I</em>
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('underline') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        disabled={disabled}
        aria-label="Underline"
        aria-pressed={editor.isActive('underline')}
        title={`Underline (${modKey}+U)`}
      >
        <u>U</u>
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('strike') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        disabled={disabled}
        aria-label="Strikethrough"
        aria-pressed={editor.isActive('strike')}
        title={`Strikethrough (${modKey}+Shift+X)`}
      >
        <s>S</s>
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('code') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleCode().run()}
        disabled={disabled}
        aria-label="Inline Code"
        aria-pressed={editor.isActive('code')}
        title={`Inline Code (${modKey}+E)`}
      >
        <code>&lt;/&gt;</code>
      </button>

      <span className={styles.divider} role="separator" />

      {/* 4. Highlight, Subscript, Superscript */}
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('highlight') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleHighlight().run()}
        disabled={disabled}
        aria-label="Highlight"
        aria-pressed={editor.isActive('highlight')}
        title="Highlight"
      >
        <span className={styles.highlightBadge}>H</span>
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('subscript') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleSubscript().run()}
        disabled={disabled}
        aria-label="Subscript"
        aria-pressed={editor.isActive('subscript')}
        title="Subscript"
      >
        x<sub>2</sub>
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('superscript') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleSuperscript().run()}
        disabled={disabled}
        aria-label="Superscript"
        aria-pressed={editor.isActive('superscript')}
        title="Superscript"
      >
        x<sup>2</sup>
      </button>

      <span className={styles.divider} role="separator" />

      {/* 5. Lists */}
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('bulletList') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        disabled={disabled}
        aria-label="Bullet List"
        aria-pressed={editor.isActive('bulletList')}
        title="Bullet List"
      >
        • List
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('orderedList') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        disabled={disabled}
        aria-label="Numbered List"
        aria-pressed={editor.isActive('orderedList')}
        title="Numbered List"
      >
        1. List
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('taskList') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        disabled={disabled}
        aria-label="Task List"
        aria-pressed={editor.isActive('taskList')}
        title="Task List"
      >
        ☐ Task
      </button>

      <span className={styles.divider} role="separator" />

      {/* 6. Alignment */}
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive({ textAlign: 'left' }) ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().setTextAlign('left').run()}
        disabled={disabled}
        aria-label="Align Left"
        aria-pressed={editor.isActive({ textAlign: 'left' })}
        title="Align Left"
      >
        ⯇
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive({ textAlign: 'center' }) ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().setTextAlign('center').run()}
        disabled={disabled}
        aria-label="Align Center"
        aria-pressed={editor.isActive({ textAlign: 'center' })}
        title="Align Center"
      >
        ≡
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive({ textAlign: 'right' }) ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().setTextAlign('right').run()}
        disabled={disabled}
        aria-label="Align Right"
        aria-pressed={editor.isActive({ textAlign: 'right' })}
        title="Align Right"
      >
        ⯈
      </button>

      <span className={styles.divider} role="separator" />

      {/* 7. Blocks */}
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('blockquote') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        disabled={disabled}
        aria-label="Blockquote"
        aria-pressed={editor.isActive('blockquote')}
        title="Blockquote"
      >
        &ldquo; Quote
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('codeBlock') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        disabled={disabled}
        aria-label="Code Block"
        aria-pressed={editor.isActive('codeBlock')}
        title="Code Block"
      >
        Block
      </button>
      <button
        type="button"
        className={styles.btn}
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        disabled={disabled}
        aria-label="Horizontal Rule"
        title="Horizontal Rule"
      >
        — Divider
      </button>

      <span className={styles.divider} role="separator" />

      {/* 8. Link & Popover Container */}
      <div className={styles.linkContainer}>
        <button
          type="button"
          className={`${styles.btn} ${isLinkActive ? styles.btnActive : ''}`}
          onClick={() => setShowLinkPopover((prev) => !prev)}
          disabled={disabled}
          aria-label="Insert or edit link"
          aria-pressed={isLinkActive}
          title={`Link (${modKey}+K)`}
        >
          🔗 Link
        </button>

        {showLinkPopover && !disabled && (
          <LinkPopover
            initialUrl={currentLinkUrl}
            onApply={handleApplyLink}
            onRemove={handleRemoveLink}
            onCancel={() => {
              setShowLinkPopover(false);
              if (editor && editor.isEditable) {
                editor.commands.focus();
              }
            }}
          />
        )}
      </div>

      <span className={styles.divider} role="separator" />

      {/* 9. Focus Mode */}
      {onToggleFocusMode && (
        <button
          type="button"
          className={`${styles.btn} ${isFocusMode ? styles.btnActive : ''}`}
          onClick={onToggleFocusMode}
          aria-label={isFocusMode ? 'Exit focus mode' : 'Enter focus mode'}
          aria-pressed={isFocusMode}
          title={`${isFocusMode ? 'Exit Focus Mode' : 'Focus Mode'} (${modKey}+Shift+F)`}
        >
          ⛶
        </button>
      )}
    </div>
  );
}
