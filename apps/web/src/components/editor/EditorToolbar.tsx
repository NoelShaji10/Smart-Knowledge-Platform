'use client';

import React, { useState, useEffect } from 'react';
import { Editor } from '@tiptap/react';
import { LinkPopover, sanitizeLinkUrl } from './LinkPopover';
import styles from './EditorToolbar.module.css';

export interface EditorToolbarProps {
  editor: Editor | null;
  disabled?: boolean;
  readOnly?: boolean;
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
  readOnly = false,
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
      if (!disabled && !readOnly && editor && editor.isEditable) {
        setShowLinkPopover((prev) => !prev);
      }
    };

    window.addEventListener('editor:toggle-link-popover', handleToggleLinkPopover);
    return () => {
      window.removeEventListener('editor:toggle-link-popover', handleToggleLinkPopover);
    };
  }, [disabled, readOnly, editor]);

  if (!editor) return null;

  const modKey = getModifierKeyLabel();

  if (readOnly) {
    return (
      <div className={styles.readOnlyToolbar} role="toolbar" aria-label="Viewer toolbar">
        <span className={styles.readOnlyIndicator}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span>Read-only mode</span>
        </span>

        {onToggleFocusMode && (
          <button
            type="button"
            className={`${styles.btn} ${isFocusMode ? styles.btnActive : ''}`}
            onClick={onToggleFocusMode}
            aria-label={isFocusMode ? 'Exit focus mode' : 'Enter focus mode'}
            aria-pressed={isFocusMode}
            title={`${isFocusMode ? 'Exit Focus Mode' : 'Focus Mode'} (${modKey}+Shift+F)`}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {isFocusMode ? (
                <>
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </>
              ) : (
                <>
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </>
              )}
            </svg>
          </button>
        )}
      </div>
    );
  }

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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7v6h6" />
          <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
        </svg>
      </button>
      <button
        type="button"
        className={styles.btn}
        onClick={() => editor.chain().focus().redo().run()}
        disabled={disabled || !editor.can().redo()}
        title={`Redo (${modKey}+Y)`}
        aria-label="Redo"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 7v6h-6" />
          <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7" />
        </svg>
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
          <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
        </svg>
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="19" y1="4" x2="10" y2="4" />
          <line x1="14" y1="20" x2="5" y2="20" />
          <line x1="15" y1="4" x2="9" y2="20" />
        </svg>
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 3v7a6 6 0 0 0 12 0V3" />
          <line x1="4" y1="21" x2="20" y2="21" />
        </svg>
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M16 4H9a3 3 0 0 0-2.83 4" />
          <path d="M14 12a4 4 0 0 1 0 8H6" />
          <line x1="4" y1="12" x2="20" y2="12" />
        </svg>
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 11-6 6v3h3l6-6" />
          <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
        </svg>
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
        <span className={styles.scriptLabel} aria-hidden="true">x<sub>2</sub></span>
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
        <span className={styles.scriptLabel} aria-hidden="true">x<sup>2</sup></span>
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="9" y1="6" x2="20" y2="6" />
          <line x1="9" y1="12" x2="20" y2="12" />
          <line x1="9" y1="18" x2="20" y2="18" />
          <circle cx="4" cy="6" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none" />
          <circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none" />
        </svg>
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="10" y1="6" x2="20" y2="6" />
          <line x1="10" y1="12" x2="20" y2="12" />
          <line x1="10" y1="18" x2="20" y2="18" />
          <path d="M4 7V4h1" strokeWidth="1.75" />
          <path d="M4 13h2a1 1 0 0 0 0-2H4v-1h2" strokeWidth="1.75" />
        </svg>
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="7" height="7" rx="1.5" />
          <path d="m5 7.5 1.5 1.5 2-2" />
          <line x1="13" y1="7" x2="21" y2="7" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <line x1="13" y1="17" x2="21" y2="17" />
        </svg>
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="17" y1="10" x2="3" y2="10" />
          <line x1="21" y1="6" x2="3" y2="6" />
          <line x1="21" y1="14" x2="3" y2="14" />
          <line x1="17" y1="18" x2="3" y2="18" />
        </svg>
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="18" y1="10" x2="6" y2="10" />
          <line x1="21" y1="6" x2="3" y2="6" />
          <line x1="21" y1="14" x2="3" y2="14" />
          <line x1="18" y1="18" x2="6" y2="18" />
        </svg>
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="21" y1="10" x2="7" y2="10" />
          <line x1="21" y1="6" x2="3" y2="6" />
          <line x1="21" y1="14" x2="3" y2="14" />
          <line x1="21" y1="18" x2="7" y2="18" />
        </svg>
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z" />
          <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z" />
        </svg>
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="m8 10-2 2 2 2" />
          <path d="m16 10 2 2-2 2" />
          <path d="m12 9-2 6" />
        </svg>
      </button>
      <button
        type="button"
        className={styles.btn}
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        disabled={disabled}
        aria-label="Horizontal Rule"
        title="Horizontal Rule"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="2" y1="12" x2="22" y2="12" />
        </svg>
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
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
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
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {isFocusMode ? (
              <>
                <polyline points="4 14 10 14 10 20" />
                <polyline points="20 10 14 10 14 4" />
                <line x1="14" y1="10" x2="21" y2="3" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </>
            ) : (
              <>
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </>
            )}
          </svg>
        </button>
      )}
    </div>
  );
}
