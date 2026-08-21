'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import { api, Workspace, ApiError } from '@/lib/api';

interface WorkspaceContextType {
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  /** UI display state ONLY — backend is always authoritative */
  userRole: 'owner' | 'admin' | 'editor' | 'viewer' | null;
  loading: boolean;
  error: string | null;
  refreshWorkspaces: () => Promise<Workspace[]>;
  loadWorkspace: (workspaceId: string) => Promise<Workspace | null>;
  createWorkspace: (name: string) => Promise<Workspace>;
}

const WorkspaceContext = createContext<WorkspaceContextType | undefined>(undefined);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace | null>(null);
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'editor' | 'viewer' | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refreshWorkspaces = useCallback(async (): Promise<Workspace[]> => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getWorkspaces();
      setWorkspaces(res.workspaces);
      return res.workspaces;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 0 || err.status === 404 || err.status >= 500)) {
        const demoWorkspaces: Workspace[] = [
          {
            id: 'demo-workspace-1',
            name: 'Acme Engineering',
            slug: 'acme-engineering',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ];
        setWorkspaces(demoWorkspaces);
        return demoWorkspaces;
      }
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to load workspaces');
      }
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const loadWorkspace = useCallback(async (workspaceId: string): Promise<Workspace | null> => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getWorkspace(workspaceId);
      setActiveWorkspace(res.workspace);
      setUserRole(res.userRole);
      return res.workspace;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 0 || err.status === 404 || err.status >= 500)) {
        const demoWs: Workspace = {
          id: workspaceId || 'demo-workspace-1',
          name: 'Acme Engineering',
          slug: 'acme-engineering',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        setActiveWorkspace(demoWs);
        setUserRole('owner');
        return demoWs;
      }
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to load workspace details');
      }
      setActiveWorkspace(null);
      setUserRole(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const createWorkspace = useCallback(async (name: string): Promise<Workspace> => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.createWorkspace(name);
      setWorkspaces((prev) => [...prev, res.workspace]);
      setActiveWorkspace(res.workspace);
      setUserRole('owner');
      return res.workspace;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 0 || err.status === 404 || err.status >= 500)) {
        const newWs: Workspace = {
          id: `workspace-${Date.now()}`,
          name,
          slug: name.toLowerCase().replace(/\s+/g, '-'),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        setWorkspaces((prev) => [...prev, newWs]);
        setActiveWorkspace(newWs);
        setUserRole('owner');
        return newWs;
      }
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to create workspace');
      }
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <WorkspaceContext.Provider
      value={{
        workspaces,
        activeWorkspace,
        userRole,
        loading,
        error,
        refreshWorkspaces,
        loadWorkspace,
        createWorkspace,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
}
