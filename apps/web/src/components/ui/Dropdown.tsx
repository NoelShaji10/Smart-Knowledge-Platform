'use client';

import React, { useState, useRef, useEffect, ReactNode, KeyboardEvent } from 'react';
import styles from './Dropdown.module.css';

export interface DropdownItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  active?: boolean;
  danger?: boolean;
  divider?: boolean;
  onClick?: () => void;
}

export interface DropdownProps {
  trigger: ReactNode;
  items: DropdownItem[];
  align?: 'left' | 'right';
  className?: string;
}

export function Dropdown({ trigger, items, align = 'left', className = '' }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const toggle = () => {
    setOpen((prev) => !prev);
    setFocusedIndex(-1);
  };

  const close = () => {
    setOpen(false);
    setFocusedIndex(-1);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [open]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
        setFocusedIndex(0);
      }
      return;
    }

    const selectableItems = items.filter((item) => !item.divider);

    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIndex((prev) => (prev + 1) % selectableItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIndex((prev) => (prev - 1 + selectableItems.length) % selectableItems.length);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const current = selectableItems[focusedIndex];
      if (current && current.onClick) {
        current.onClick();
        close();
      }
    }
  };

  return (
    <div
      ref={dropdownRef}
      className={`${styles.dropdown} ${className}`.trim()}
      onKeyDown={handleKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {trigger}
      </button>

      {open && (
        <ul
          className={`${styles.menu} ${align === 'right' ? styles.alignRight : styles.alignLeft}`}
          role="menu"
          tabIndex={-1}
        >
          {items.map((item, index) => {
            if (item.divider) {
              return <li key={`divider-${index}`} className={styles.divider} role="separator" />;
            }

            const isFocused = index === focusedIndex;

            return (
              <li key={item.id} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.item} ${item.active ? styles.itemActive : ''} ${item.danger ? styles.itemDanger : ''} ${isFocused ? styles.itemFocused : ''}`.trim()}
                  onClick={() => {
                    if (item.onClick) item.onClick();
                    close();
                  }}
                >
                  {item.icon && <span aria-hidden="true">{item.icon}</span>}
                  <span>{item.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
