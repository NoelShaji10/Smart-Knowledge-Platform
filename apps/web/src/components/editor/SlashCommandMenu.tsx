'use client';

import React, { useState, useEffect, useImperativeHandle, forwardRef } from 'react';
import { SlashCommandItem } from './extensions/SlashCommands';
import styles from './SlashCommandMenu.module.css';

export interface SlashCommandMenuProps {
  items: SlashCommandItem[];
  command: (item: SlashCommandItem) => void;
}

export interface SlashCommandMenuRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const SlashCommandMenu = forwardRef<SlashCommandMenuRef, SlashCommandMenuProps>(
  function SlashCommandMenu({ items, command }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);

    useEffect(() => {
      setSelectedIndex(0);
    }, [items]);

    const selectItem = (index: number) => {
      const item = items[index];
      if (item) {
        command(item);
      }
    };

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (items.length === 0) return false;

        if (event.key === 'ArrowUp') {
          setSelectedIndex((prev) => (prev - 1 + items.length) % items.length);
          return true;
        }

        if (event.key === 'ArrowDown') {
          setSelectedIndex((prev) => (prev + 1) % items.length);
          return true;
        }

        if (event.key === 'Enter') {
          selectItem(selectedIndex);
          return true;
        }

        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div className={styles.menuContainer} role="listbox" aria-label="Slash commands menu">
          <div className={styles.emptyState}>No matching commands</div>
        </div>
      );
    }

    return (
      <div className={styles.menuContainer} role="listbox" aria-label="Slash commands menu">
        {items.map((item, index) => {
          const isSelected = index === selectedIndex;
          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={isSelected}
              className={`${styles.menuItem} ${isSelected ? styles.menuItemActive : ''}`}
              onMouseDown={(e) => {
                e.preventDefault(); // Prevent editor focus loss
                selectItem(index);
              }}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <div className={styles.iconBadge}>{item.icon}</div>
              <div className={styles.itemContent}>
                <span className={styles.itemTitle}>{item.title}</span>
                <span className={styles.itemDescription}>{item.description}</span>
              </div>
            </button>
          );
        })}
      </div>
    );
  },
);
