import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api, Workspace, ApiError } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

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
  const { user, loading: authLoading } = useAuth();
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
      if (err instanceof ApiError) {
        if (err.status === 0) {
          setError('Unable to connect to the server. Please check your network connection.');
        } else if (err.status >= 500) {
          setError('Unable to load workspaces. Your data is safely stored in PostgreSQL. Please try again.');
        } else {
          setError(err.message || 'Failed to load workspaces');
        }
      } else {
        setError('Failed to load workspaces');
      }
      setWorkspaces([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoading) {
      if (user) {
        refreshWorkspaces();
      } else {
        setWorkspaces([]);
        setActiveWorkspace(null);
        setUserRole(null);
      }
    }
  }, [user, authLoading, refreshWorkspaces]);

  const loadWorkspace = useCallback(async (workspaceId: string): Promise<Workspace | null> => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getWorkspace(workspaceId);
      setActiveWorkspace(res.workspace);
      setUserRole(res.userRole);
      setWorkspaces((prev) => {
        const exists = prev.some((w) => w.id === res.workspace.id);
        if (exists) {
          return prev.map((w) => (w.id === res.workspace.id ? res.workspace : w));
        }
        return [...prev, res.workspace];
      });
      return res.workspace;
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 0) {
          setError('Unable to connect to the server. Please check your network connection.');
        } else if (err.status === 404) {
          setError('Workspace not found.');
        } else if (err.status >= 500) {
          setError('Unable to load workspace details. Your data is safely stored in PostgreSQL. Please try again.');
        } else {
          setError(err.message || 'Failed to load workspace details');
        }
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
      if (err instanceof ApiError) {
        setError(err.message || 'Failed to create workspace');
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
