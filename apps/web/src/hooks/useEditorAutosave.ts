'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface UseEditorAutosaveOptions {
  readOnly?: boolean;
  saveFn?: (title: string, contentText: string, saveRev: number) => Promise<void>;
  onSaveStateChange?: (state: SaveState) => void;
  debounceMs?: number;
}

export function useEditorAutosave({
  readOnly = false,
  saveFn,
  onSaveStateChange,
  debounceMs = 1000,
}: UseEditorAutosaveOptions) {
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isSavingRef = useRef(false);
  const editRevRef = useRef(0);
  const latestContentRef = useRef({ title: '', contentText: '' });

  const updateSaveState = useCallback(
    (state: SaveState) => {
      setSaveState(state);
      if (onSaveStateChange) onSaveStateChange(state);
    },
    [onSaveStateChange],
  );

  const cancelDebouncedSave = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
  }, []);

  const saveChanges = useCallback(
    async (newTitle: string, newContent: string, saveRev: number) => {
      if (readOnly || !saveFn) return;
      isSavingRef.current = true;
      updateSaveState('saving');

      try {
        await saveFn(newTitle, newContent, saveRev);

        // Only mark saved and clear unsaved flag if no newer local edits occurred while save was in-flight
        if (editRevRef.current === saveRev) {
          updateSaveState('saved');
          setHasUnsavedChanges(false);
        }
      } catch (err) {
        if (editRevRef.current === saveRev) {
          updateSaveState('error');
        }
      } finally {
        isSavingRef.current = false;
      }
    },
    [readOnly, saveFn, updateSaveState],
  );

  const triggerDebouncedSave = useCallback(
    (newTitle: string, newContent: string) => {
      if (readOnly) return;
      editRevRef.current += 1;
      const currentRev = editRevRef.current;
      setHasUnsavedChanges(true);
      latestContentRef.current = { title: newTitle, contentText: newContent };

      cancelDebouncedSave();

      debounceTimerRef.current = setTimeout(() => {
        saveChanges(newTitle, newContent, currentRev);
      }, debounceMs);
    },
    [readOnly, cancelDebouncedSave, saveChanges, debounceMs],
  );

  const triggerImmediateSave = useCallback(
    (newTitle: string, newContent: string) => {
      if (readOnly) return;
      cancelDebouncedSave();
      editRevRef.current += 1;
      const currentRev = editRevRef.current;
      setHasUnsavedChanges(true);
      latestContentRef.current = { title: newTitle, contentText: newContent };
      saveChanges(newTitle, newContent, currentRev);
    },
    [readOnly, cancelDebouncedSave, saveChanges],
  );

  const resetEditState = useCallback(() => {
    cancelDebouncedSave();
    editRevRef.current = 0;
    setHasUnsavedChanges(false);
    setSaveState('idle');
  }, [cancelDebouncedSave]);

  useEffect(() => {
    return () => {
      cancelDebouncedSave();
    };
  }, [cancelDebouncedSave]);

  return {
    saveState,
    hasUnsavedChanges,
    editRevRef,
    isSavingRef,
    latestContentRef,
    triggerDebouncedSave,
    triggerImmediateSave,
    cancelDebouncedSave,
    resetEditState,
    setSaveState,
    setHasUnsavedChanges,
    updateSaveState,
  };
}
