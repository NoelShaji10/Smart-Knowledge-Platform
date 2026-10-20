'use client';

import { useEffect, useRef } from 'react';

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');

  const elements = Array.from(container.querySelectorAll<HTMLElement>(selector));
  return elements.filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    // Check computed style if in browser environment
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      try {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return false;
        }
      } catch {
        // Fallback for non-standard environments
      }
    }
    return true;
  });
}

export interface UseModalFocusOptions {
  isOpen: boolean;
  modalRef: React.RefObject<HTMLElement>;
  initialFocusRef?: React.RefObject<HTMLElement>;
  onClose?: () => void;
  disabled?: boolean;
}

export function useModalFocus({
  isOpen,
  modalRef,
  initialFocusRef,
  onClose,
  disabled = false,
}: UseModalFocusOptions) {
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen || disabled) return;

    if (document.activeElement instanceof HTMLElement) {
      previousActiveElementRef.current = document.activeElement;
    }

    // Set initial focus
    const timer = setTimeout(() => {
      if (initialFocusRef?.current && document.contains(initialFocusRef.current)) {
        initialFocusRef.current.focus();
      } else if (modalRef.current) {
        const focusable = getFocusableElements(modalRef.current);
        if (focusable.length > 0) {
          focusable[0].focus();
        } else {
          modalRef.current.focus();
        }
      }
    }, 20);

    function handleKeyDown(e: KeyboardEvent) {
      if (!modalRef.current) return;

      if (e.key === 'Escape') {
        if (onClose) {
          e.preventDefault();
          onClose();
        }
        return;
      }

      if (e.key === 'Tab') {
        const focusable = getFocusableElements(modalRef.current);
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first || !modalRef.current.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last || !modalRef.current.contains(document.activeElement)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', handleKeyDown);
      const prev = previousActiveElementRef.current;
      if (prev && document.contains(prev)) {
        // Delay slightly to prevent focus stealing during sequential modal transitions
        setTimeout(() => {
          if (
            document.contains(prev) &&
            !document.querySelector('[role="dialog"][aria-modal="true"]')
          ) {
            prev.focus();
          }
        }, 10);
      }
    };
  }, [isOpen, modalRef, initialFocusRef, onClose, disabled]);
}
