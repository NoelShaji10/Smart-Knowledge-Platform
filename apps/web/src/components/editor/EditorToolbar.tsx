'use client';

import React from 'react';
import { Editor } from '@tiptap/react';
import styles from './EditorToolbar.module.css';

export interface EditorToolbarProps {
  editor: Editor | null;
  disabled?: boolean;
}

export function EditorToolbar({ editor, disabled = false }: EditorToolbarProps) {
  if (!editor) return null;

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Rich text editor toolbar">
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('paragraph') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().setParagraph().run()}
        disabled={disabled}
        title="Paragraph"
      >
        P
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('heading', { level: 1 }) ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        disabled={disabled}
        title="Heading 1"
      >
        H1
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('heading', { level: 2 }) ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        disabled={disabled}
        title="Heading 2"
      >
        H2
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('heading', { level: 3 }) ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        disabled={disabled}
        title="Heading 3"
      >
        H3
      </button>

      <span className={styles.divider} />

      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('bold') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleBold().run()}
        disabled={disabled}
        title="Bold (Ctrl+B)"
      >
        <strong>B</strong>
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('italic') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        disabled={disabled}
        title="Italic (Ctrl+I)"
      >
        <em>I</em>
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('strike') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        disabled={disabled}
        title="Strikethrough"
      >
        <s>S</s>
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('code') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleCode().run()}
        disabled={disabled}
        title="Inline Code"
      >
        <code>&lt;/&gt;</code>
      </button>

      <span className={styles.divider} />

      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('bulletList') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        disabled={disabled}
        title="Bullet List"
      >
        • List
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('orderedList') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        disabled={disabled}
        title="Numbered List"
      >
        1. List
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('blockquote') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        disabled={disabled}
        title="Blockquote"
      >
        &ldquo; Quote
      </button>
      <button
        type="button"
        className={`${styles.btn} ${editor.isActive('codeBlock') ? styles.btnActive : ''}`}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        disabled={disabled}
        title="Code Block"
      >
        Block
      </button>

      <span className={styles.divider} />

      <button
        type="button"
        className={styles.btn}
        onClick={() => editor.chain().focus().undo().run()}
        disabled={disabled || !editor.can().undo()}
        title="Undo"
      >
        ↺
      </button>
      <button
        type="button"
        className={styles.btn}
        onClick={() => editor.chain().focus().redo().run()}
        disabled={disabled || !editor.can().redo()}
        title="Redo"
      >
        ↻
      </button>
    </div>
  );
}
