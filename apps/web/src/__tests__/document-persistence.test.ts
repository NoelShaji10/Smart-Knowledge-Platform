// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, Document, setAccessToken } from '../lib/api';
import { DocumentEditor } from '../components/editor/DocumentEditor';
import { DocumentHeader } from '../components/documents/DocumentHeader';
import { EditorStatusBar } from '../components/editor/EditorStatusBar';
import { useEditorAutosave, SaveState } from '../hooks/useEditorAutosave';

// Configure act environment for React 18
// @ts-expect-error global IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'user@example.com', displayName: 'User One' },
    isAuthenticated: true,
  }),
}));

const mockShowToast = vi.fn();
vi.mock('@/components/ui', () => ({
  useToast: () => ({
    showToast: mockShowToast,
  }),
  Button: ({ children, onClick, ...props }: any) =>
    React.createElement('button', { onClick, ...props }, children),
  Badge: ({ children, variant, ...props }: any) =>
    React.createElement('span', { 'data-variant': variant, ...props }, children),
}));

// Mutable mock collab state for testing collaborative editor transitions
let mockCollabStatus = 'connected';
let mockCollabPersistenceState = 'persisted';
let mockFlushPersistenceCalled = false;

const stableMockProvider = {
  requestPersistenceFlush: () => {
    mockFlushPersistenceCalled = true;
  },
} as any;

vi.mock('@/hooks/useCollaboration', () => ({
  useCollaboration: () => ({
    provider: stableMockProvider,
    yDoc: null,
    status: mockCollabStatus,
    persistenceState: mockCollabPersistenceState,
    error: null,
    connectedUsers: [],
    indexeddbProvider: null,
    flushPersistence: () => {
      mockFlushPersistenceCalled = true;
    },
  }),
}));

describe('Phase 5 T3: Persistence and Truthful Save-State Model', () => {
  beforeEach(() => {
    setAccessToken('mock-token');
    vi.resetAllMocks();
    mockCollabStatus = 'connected';
    mockCollabPersistenceState = 'persisted';
    mockFlushPersistenceCalled = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Non-Collaborative Autosave (useEditorAutosave)', () => {
    it('transitions to "editing" immediately when user types, before debounce timer fires', () => {
      vi.useFakeTimers();
      let saveCallCount = 0;
      const saveStates: SaveState[] = [];

      const Consumer = () => {
        const { saveState, hasUnsavedChanges, triggerDebouncedSave } = useEditorAutosave({
          saveFn: async () => {
            saveCallCount++;
          },
          onSaveStateChange: (st) => saveStates.push(st),
          debounceMs: 1000,
        });

        return React.createElement('div', null, [
          React.createElement('span', { key: 'st', id: 'state' }, saveState),
          React.createElement('span', { key: 'dirty', id: 'dirty' }, String(hasUnsavedChanges)),
          React.createElement('button', {
            key: 'btn',
            id: 'edit-btn',
            onClick: () => triggerDebouncedSave('Title 1', 'Content 1'),
          }),
        ]);
      };

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      act(() => {
        root.render(React.createElement(Consumer));
      });

      expect(container.querySelector('#state')?.textContent).toBe('idle');
      expect(container.querySelector('#dirty')?.textContent).toBe('false');

      // User types
      act(() => {
        container.querySelector('#edit-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      // MUST immediately transition to editing and dirty, NEVER displaying saved while waiting!
      expect(container.querySelector('#state')?.textContent).toBe('editing');
      expect(container.querySelector('#dirty')?.textContent).toBe('true');
      expect(saveCallCount).toBe(0);

      // Fast forward debounce timer
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(saveCallCount).toBe(1);

      act(() => {
        root.unmount();
      });
      container.remove();
      vi.useRealTimers();
    });

    it('monotonic revision guard: intervening edit while save is in-flight preserves "editing" state upon earlier save resolution', async () => {
      vi.useFakeTimers();
      let resolveFirstSave: () => void = () => {};
      let resolveSecondSave: () => void = () => {};
      let saveIndex = 0;

      const Consumer = () => {
        const { saveState, hasUnsavedChanges, triggerDebouncedSave } = useEditorAutosave({
          saveFn: async () => {
            saveIndex++;
            const currentIndex = saveIndex;
            return new Promise<void>((res) => {
              if (currentIndex === 1) {
                resolveFirstSave = res;
              } else {
                resolveSecondSave = res;
              }
            });
          },
          debounceMs: 500,
        });

        return React.createElement('div', null, [
          React.createElement('span', { key: 'st', id: 'state' }, saveState),
          React.createElement('span', { key: 'dirty', id: 'dirty' }, String(hasUnsavedChanges)),
          React.createElement('button', {
            key: 'btn1',
            id: 'edit-1',
            onClick: () => triggerDebouncedSave('Doc', 'Version 1'),
          }),
          React.createElement('button', {
            key: 'btn2',
            id: 'edit-2',
            onClick: () => triggerDebouncedSave('Doc', 'Version 2'),
          }),
        ]);
      };

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      act(() => {
        root.render(React.createElement(Consumer));
      });

      // 1. User makes edit 1
      act(() => {
        container.querySelector('#edit-1')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(container.querySelector('#state')?.textContent).toBe('editing');

      // Debounce fires -> save 1 is in-flight
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(container.querySelector('#state')?.textContent).toBe('saving');

      // 2. User makes edit 2 while save 1 is STILL in-flight!
      act(() => {
        container.querySelector('#edit-2')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(container.querySelector('#state')?.textContent).toBe('editing');

      // 3. Save 1 completes now
      await act(async () => {
        resolveFirstSave();
      });

      // MUST NOT claim 'saved' because edit 2 has not been persisted!
      expect(container.querySelector('#state')?.textContent).toBe('editing');
      expect(container.querySelector('#dirty')?.textContent).toBe('true');

      // 4. Save 2 debounce fires
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(container.querySelector('#state')?.textContent).toBe('saving');

      // Save 2 completes
      await act(async () => {
        resolveSecondSave();
      });

      // Now all edits are persisted
      expect(container.querySelector('#state')?.textContent).toBe('saved');
      expect(container.querySelector('#dirty')?.textContent).toBe('false');

      act(() => {
        root.unmount();
      });
      container.remove();
      vi.useRealTimers();
    });

    it('transitions to "error" on save failure and permits retry', async () => {
      vi.useFakeTimers();
      let shouldFail = true;

      const Consumer = () => {
        const { saveState, triggerImmediateSave } = useEditorAutosave({
          saveFn: async () => {
            if (shouldFail) throw new Error('Network error');
          },
        });

        return React.createElement('div', null, [
          React.createElement('span', { key: 'st', id: 'state' }, saveState),
          React.createElement('button', {
            key: 'btn',
            id: 'save-btn',
            onClick: () => triggerImmediateSave('Doc', 'Content'),
          }),
        ]);
      };

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      act(() => {
        root.render(React.createElement(Consumer));
      });

      // Trigger failing save
      await act(async () => {
        container.querySelector('#save-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.querySelector('#state')?.textContent).toBe('error');

      // Retry succeeding
      shouldFail = false;
      await act(async () => {
        container.querySelector('#save-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(container.querySelector('#state')?.textContent).toBe('saved');

      act(() => {
        root.unmount();
      });
      container.remove();
      vi.useRealTimers();
    });
  });

  describe('2. Truthful Collaborative Persistence in DocumentEditor', () => {
    const baseDoc: Document = {
      id: 'doc-persist-collab',
      workspace_id: 'ws-1',
      parent_id: null,
      title: 'Collab Doc',
      content_text: '<p>Content</p>',
      created_by: 'u1',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    it('does NOT claim "saved" when WebSocket is connecting', async () => {
      mockCollabStatus = 'connecting';
      let reportedState: SaveState = 'saved';

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          React.createElement(DocumentEditor, {
            workspaceId: 'ws-1',
            document: baseDoc,
            collaborative: true,
            onSaveStateChange: (st) => {
              reportedState = st;
            },
          }),
        );
      });

      // Must be recovering/reconnecting, NOT saved
      expect(reportedState).toBe('recovering');

      await act(async () => {
        root.unmount();
      });
      container.remove();
    });

    it('does NOT claim "saved" when WebSocket is disconnected', async () => {
      mockCollabStatus = 'disconnected';
      let reportedState: SaveState = 'saved';

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          React.createElement(DocumentEditor, {
            workspaceId: 'ws-1',
            document: baseDoc,
            collaborative: true,
            onSaveStateChange: (st) => {
              reportedState = st;
            },
          }),
        );
      });

      expect(reportedState).toBe('disconnected');

      await act(async () => {
        root.unmount();
      });
      container.remove();
    });

    it('reports "editing" when connected but server persistence is pending', async () => {
      mockCollabStatus = 'connected';
      mockCollabPersistenceState = 'editing';
      let reportedState: SaveState = 'saved';

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          React.createElement(DocumentEditor, {
            workspaceId: 'ws-1',
            document: baseDoc,
            collaborative: true,
            onSaveStateChange: (st) => {
              reportedState = st;
            },
          }),
        );
      });

      expect(reportedState).toBe('editing');

      await act(async () => {
        root.unmount();
      });
      container.remove();
    });

    it('reports "saved" only when connected AND server confirms persistence', async () => {
      mockCollabStatus = 'connected';
      mockCollabPersistenceState = 'persisted';
      let reportedState: SaveState = 'idle';

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          React.createElement(DocumentEditor, {
            workspaceId: 'ws-1',
            document: baseDoc,
            collaborative: true,
            onSaveStateChange: (st) => {
              reportedState = st;
            },
          }),
        );
      });

      expect(reportedState).toBe('saved');

      await act(async () => {
        root.unmount();
      });
      container.remove();
    });

    it('reports "readonly" for viewer and disables edits', async () => {
      mockCollabStatus = 'connected';
      let reportedState: SaveState = 'saved';

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          React.createElement(DocumentEditor, {
            workspaceId: 'ws-1',
            document: baseDoc,
            readOnly: true,
            collaborative: false,
            onSaveStateChange: (st) => {
              reportedState = st;
            },
          }),
        );
      });

      expect(reportedState).toBe('readonly');

      await act(async () => {
        root.unmount();
      });
      container.remove();
    });

    it('calls flushPersistence on manual save shortcut in collaborative mode', async () => {
      mockCollabStatus = 'connected';
      mockCollabPersistenceState = 'editing';

      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);

      await act(async () => {
        root.render(
          React.createElement(DocumentEditor, {
            workspaceId: 'ws-1',
            document: baseDoc,
            collaborative: true,
          }),
        );
      });

      // Dispatch Ctrl+S
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
      });

      expect(mockFlushPersistenceCalled).toBe(true);

      await act(async () => {
        root.unmount();
      });
      container.remove();
    });
  });

  describe('3. UI Representation Truthfulness', () => {
    it('DocumentHeader renders truthful badges across all states', () => {
      const capabilities = { canRead: true, canEdit: true, canManagePermissions: true, canArchive: true, canMove: true };
      const doc: Document = {
        id: 'doc-header-test',
        workspace_id: 'ws-1',
        parent_id: null,
        title: 'Doc',
        content_text: '',
        created_by: 'u1',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const renderWithState = (state: SaveState) => {
        const container = document.createElement('div');
        const root = createRoot(container);
        act(() => {
          root.render(
            React.createElement(DocumentHeader, {
              workspaceId: 'ws-1',
              document: doc,
              capabilities,
              saveState: state,
              onToggleHistory: () => {},
              onDocumentUpdated: () => {},
            }),
          );
        });
        const badgeText = container.querySelector('header')?.textContent || '';
        act(() => {
          root.unmount();
        });
        return badgeText;
      };

      expect(renderWithState('saved')).toContain('Saved');
      expect(renderWithState('saving')).toContain('Saving...');
      expect(renderWithState('editing')).toContain('Changes pending');
      expect(renderWithState('error')).toContain('Save failed');
      expect(renderWithState('delayed')).toContain('Persistence delayed');
      expect(renderWithState('disconnected')).toContain('Offline');
      expect(renderWithState('recovering')).toContain('Reconnecting...');
    });

    it('EditorStatusBar displays accurate decoupled connection and persistence status', () => {
      // Mock TipTap editor object
      const mockEditor = {
        storage: {
          characterCount: {
            words: () => 100,
            characters: () => 500,
          },
        },
        on: vi.fn(),
        off: vi.fn(),
      } as any;

      const renderStatus = (collabStatus: any, saveState: any, readOnly = false) => {
        const container = document.createElement('div');
        const root = createRoot(container);
        act(() => {
          root.render(
            React.createElement(EditorStatusBar, {
              editor: mockEditor,
              collabStatus,
              saveState,
              readOnly,
            }),
          );
        });
        const text = container.textContent || '';
        act(() => {
          root.unmount();
        });
        return text;
      };

      expect(renderStatus('connected', 'saved')).toContain('Connected • Saved');
      expect(renderStatus('connected', 'editing')).toContain('Connected • Changes pending');
      expect(renderStatus('connected', 'saving')).toContain('Connected • Saving...');
      expect(renderStatus('connected', 'error')).toContain('Connected • Save failed');
      expect(renderStatus('disconnected', 'editing')).toContain('Disconnected • Changes will sync when reconnected');
      expect(renderStatus('disconnected', 'saved')).toContain('Disconnected');
      expect(renderStatus('connecting', 'editing')).toContain('Reconnecting...');
      expect(renderStatus('connected', 'saved', true)).toContain('View Only');
    });
  });
});
