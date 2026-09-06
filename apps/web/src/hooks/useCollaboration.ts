'use client';

import { useState, useEffect } from 'react';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { CollabProvider, CollabProviderStatus } from '@/lib/collab-provider';
import { getCollaboratorColor } from '@/lib/collab-colors';

export interface UseCollaborationOptions {
  workspaceId: string;
  documentId: string;
  enabled: boolean;
  user?: {
    id: string;
    displayName: string;
    color?: string;
  };
}

export interface CollabUser {
  id: string;
  name: string;
  color: string;
  isCurrentUser: boolean;
  clientId: number;
}

export interface UseCollaborationReturn {
  provider: CollabProvider | null;
  yDoc: Y.Doc | null;
  status: CollabProviderStatus;
  error: Error | null;
  connectedUsers: CollabUser[];
  indexeddbProvider: IndexeddbPersistence | null;
}

export function useCollaboration({
  workspaceId,
  documentId,
  enabled,
  user,
}: UseCollaborationOptions): UseCollaborationReturn {
  const [provider, setProvider] = useState<CollabProvider | null>(null);
  const [yDoc, setYDoc] = useState<Y.Doc | null>(null);
  const [status, setStatus] = useState<CollabProviderStatus>('disconnected');
  const [error, setError] = useState<Error | null>(null);
  const [connectedUsers, setConnectedUsers] = useState<CollabUser[]>([]);
  const [indexeddbProvider, setIndexeddbProvider] = useState<IndexeddbPersistence | null>(null);

  useEffect(() => {
    if (!enabled || !workspaceId || !documentId) {
      setProvider(null);
      setYDoc(null);
      setStatus('disconnected');
      setError(null);
      setConnectedUsers([]);
      setIndexeddbProvider(null);
      return;
    }

    let isMounted = true;
    const doc = new Y.Doc();
    setYDoc(doc);

    // Initialize IndexedDB persistence for local CRDT caching & offline read continuity
    let idbProvider: IndexeddbPersistence | null = null;
    if (typeof window !== 'undefined' && 'indexedDB' in window && window.indexedDB) {
      try {
        idbProvider = new IndexeddbPersistence(`doc:${documentId}`, doc);
        setIndexeddbProvider(idbProvider);
      } catch (err) {
        console.warn('[useCollaboration] IndexedDB persistence unavailable:', err);
      }
    }

    const userColor = user?.color || getCollaboratorColor(user?.id);
    const userInfo = user
      ? { id: user.id, displayName: user.displayName, color: userColor }
      : undefined;

    const colProvider = new CollabProvider({
      workspaceId,
      documentId,
      doc,
      user: userInfo,
      onStatusChange: (newStatus) => {
        if (isMounted) {
          setStatus(newStatus);
        }
      },
      onError: (err) => {
        if (isMounted) {
          setError(err);
        }
      },
    });

    const updateConnectedUsers = () => {
      if (!isMounted) return;
      const states = colProvider.awareness.getStates();
      const usersList: CollabUser[] = [];

      states.forEach((state, clientID) => {
        const u = state.user as { id?: string; name?: string; color?: string } | undefined;
        if (u && (u.name || u.id)) {
          const userId = u.id || `client-${clientID}`;
          const isCurrentUser = clientID === doc.clientID || (user?.id ? u.id === user.id : false);
          const assignedColor = u.color || getCollaboratorColor(userId);

          usersList.push({
            id: userId,
            name: u.name || 'Collaborator',
            color: assignedColor,
            isCurrentUser,
            clientId: clientID,
          });
        }
      });

      setConnectedUsers(usersList);
    };

    // Initial update
    updateConnectedUsers();

    colProvider.awareness.on('change', updateConnectedUsers);
    setProvider(colProvider);

    return () => {
      isMounted = false;
      colProvider.awareness.off('change', updateConnectedUsers);
      colProvider.destroy();
      if (idbProvider) {
        try {
          idbProvider.destroy();
        } catch {
          // Ignore
        }
      }
      doc.destroy();
      setProvider(null);
      setYDoc(null);
      setStatus('disconnected');
      setError(null);
      setConnectedUsers([]);
      setIndexeddbProvider(null);
    };
  }, [workspaceId, documentId, enabled, user?.id, user?.displayName, user?.color]);

  return {
    provider,
    yDoc,
    status,
    error,
    connectedUsers,
    indexeddbProvider,
  };
}

