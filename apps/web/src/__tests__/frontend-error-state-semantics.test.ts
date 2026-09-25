// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkspaceProvider, useWorkspace } from '../contexts/WorkspaceContext';
import { AuthContext } from '../contexts/AuthContext';
import { api, ApiError, Workspace } from '../lib/api';

// Configure act environment for React 18
// @ts-expect-error global IS_REACT_ACT_ENVIRONMENT
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const el = React.createElement as any;

// Mock api methods
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual('../lib/api');
  return {
    ...actual,
    api: {
      getWorkspaces: vi.fn(),
      getWorkspace: vi.fn(),
      createWorkspace: vi.fn(),
    },
  };
});

describe('Task 2: Frontend Error & State Semantics', () => {
  let container: HTMLDivElement;
  let root: Root;

  const mockAuthValue: any = {
    user: { id: 'user-1', email: 'test@example.com', displayName: 'Test User' },
    loading: false,
    error: null,
    isNetworkError: false,
    clearError: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  const dummyWorkspaces: Workspace[] = [
    {
      id: 'ws-1',
      name: 'Engineering Workspace',
      slug: 'engineering',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  function TestConsumer() {
    const { workspaces, activeWorkspace, loading, error, refreshWorkspaces, loadWorkspace } = useWorkspace();
    return el('div', null, [
      el('div', { key: 'loading', 'data-testid': 'loading' }, loading ? 'loading' : 'idle'),
      el('div', { key: 'error', 'data-testid': 'error' }, error || 'none'),
      el('div', { key: 'count', 'data-testid': 'workspace-count' }, String(workspaces.length)),
      el('div', { key: 'names', 'data-testid': 'workspace-names' }, workspaces.map((w) => w.name).join(',')),
      el('div', { key: 'active', 'data-testid': 'active-workspace' }, activeWorkspace ? activeWorkspace.name : 'none'),
      el('button', { key: 'btn-refresh', onClick: () => refreshWorkspaces() }, 'Refresh'),
      el('button', { key: 'btn-load', onClick: () => loadWorkspace('ws-1') }, 'Load WS 1'),
    ]);
  }

  const renderWithAuth = async (ui: any) => {
    await act(async () => {
      root.render(el(AuthContext.Provider, { value: mockAuthValue }, ui));
      await Promise.resolve();
    });
  };

  it('preserves valid workspaces on transient refresh failure (stale data retention)', async () => {
    // 1. Initial successful fetch
    vi.mocked(api.getWorkspaces).mockResolvedValueOnce({ workspaces: dummyWorkspaces });

    await renderWithAuth(el(WorkspaceProvider, null, el(TestConsumer)));

    // Let the initial useEffect(refreshWorkspaces) complete
    await act(async () => {
      await Promise.resolve();
    });

    const countEl = container.querySelector('[data-testid="workspace-count"]')!;
    const namesEl = container.querySelector('[data-testid="workspace-names"]')!;
    expect(countEl.textContent).toBe('1');
    expect(namesEl.textContent).toBe('Engineering Workspace');

    // 2. Next refresh fails with transient 500 error
    vi.mocked(api.getWorkspaces).mockRejectedValueOnce(
      new ApiError('Server error', 500),
    );

    const refreshBtn = container.querySelector('button')!;
    await act(async () => {
      refreshBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // Rule: Must NOT clear valid data merely because refresh failed
    expect(countEl.textContent).toBe('1');
    expect(namesEl.textContent).toBe('Engineering Workspace');
    const errorEl = container.querySelector('[data-testid="error"]')!;
    expect(errorEl.textContent).toContain('safely stored in PostgreSQL');
  });

  it('clears workspaces when refresh fails due to revoked authentication/authorization (401 or 403)', async () => {
    // 1. Initial successful fetch
    vi.mocked(api.getWorkspaces).mockResolvedValueOnce({ workspaces: dummyWorkspaces });

    await renderWithAuth(el(WorkspaceProvider, null, el(TestConsumer)));

    await act(async () => {
      await Promise.resolve();
    });

    const countEl = container.querySelector('[data-testid="workspace-count"]')!;
    expect(countEl.textContent).toBe('1');

    // 2. Refresh fails with 403 Forbidden (access revoked)
    vi.mocked(api.getWorkspaces).mockRejectedValueOnce(
      new ApiError('Forbidden', 403),
    );

    const refreshBtn = container.querySelector('button')!;
    await act(async () => {
      refreshBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // Security requirement: Must clear workspaces when permission revoked
    expect(countEl.textContent).toBe('0');
    const errorEl = container.querySelector('[data-testid="error"]')!;
    expect(errorEl.textContent).toContain('Access denied');
  });

  it('preserves activeWorkspace on transient 500 error and clears only on 403/404', async () => {
    // 1. Initial successful load
    vi.mocked(api.getWorkspaces).mockResolvedValueOnce({ workspaces: dummyWorkspaces });
    vi.mocked(api.getWorkspace).mockResolvedValueOnce({
      workspace: dummyWorkspaces[0],
      userRole: 'editor',
    });

    await renderWithAuth(el(WorkspaceProvider, null, el(TestConsumer)));

    await act(async () => {
      await Promise.resolve();
    });

    const loadBtn = container.querySelectorAll('button')[1]!;
    await act(async () => {
      loadBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const activeEl = container.querySelector('[data-testid="active-workspace"]')!;
    expect(activeEl.textContent).toBe('Engineering Workspace');

    // 2. Background reload fails with 500
    vi.mocked(api.getWorkspace).mockRejectedValueOnce(new ApiError('Internal Error', 500));
    await act(async () => {
      loadBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // Active workspace remains retained (not crashed/cleared)
    expect(activeEl.textContent).toBe('Engineering Workspace');
    const errorEl = container.querySelector('[data-testid="error"]')!;
    expect(errorEl.textContent).toContain('safely stored in PostgreSQL');

    // 3. Reload fails with 403 Access Denied
    vi.mocked(api.getWorkspace).mockRejectedValueOnce(new ApiError('Access Denied', 403));
    await act(async () => {
      loadBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // Active workspace must now be cleared for security
    expect(activeEl.textContent).toBe('none');
    expect(errorEl.textContent).toContain('Access denied');
  });
});
