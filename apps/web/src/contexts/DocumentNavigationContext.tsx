'use client';

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  ReactNode,
} from 'react';
import { api, Document, ApiError } from '@/lib/api';

export interface BreadcrumbItem {
  id: string;
  title: string;
  isArchived?: boolean;
}

/**
 * Cycle-safe ancestor resolution walking up document parent_id pointers.
 */
export function computeAncestors(
  documentId: string,
  documents: Document[],
): BreadcrumbItem[] {
  const docMap = new Map<string, Document>();
  for (const doc of documents) {
    docMap.set(doc.id, doc);
  }

  const current = docMap.get(documentId);
  if (!current) return [];

  const ancestors: BreadcrumbItem[] = [];
  const visited = new Set<string>([documentId]);

  let parentId = current.parent_id;
  while (parentId) {
    if (visited.has(parentId)) {
      break; // Cycle protection
    }
    visited.add(parentId);
    const parentDoc = docMap.get(parentId);
    if (!parentDoc) {
      break; // Missing parent protection
    }
    ancestors.unshift({
      id: parentDoc.id,
      title: parentDoc.title || 'Untitled Document',
      isArchived: parentDoc.is_archived,
    });
    parentId = parentDoc.parent_id;
  }

  return ancestors;
}

export interface DocumentNavigationContextType {
  workspaceId: string | null;
  documents: Document[];
  activeDocuments: Document[];
  archivedDocuments: Document[];
  loading: boolean;
  error: string | null;
  refreshDocuments: () => Promise<Document[]>;
  getAncestors: (documentId: string) => BreadcrumbItem[];
  addDocument: (doc: Document) => void;
  updateDocument: (doc: Document) => void;
  removeDocument: (docId: string) => void;
}

export const DocumentNavigationContext = createContext<DocumentNavigationContextType | null>(null);

export function DocumentNavigationProvider({
  workspaceId,
  children,
}: {
  workspaceId?: string | null;
  children: ReactNode;
}) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRequestIdRef = useRef(0);
  const currentWorkspaceIdRef = useRef<string | null>(workspaceId || null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const refreshDocuments = useCallback(async (): Promise<Document[]> => {
    const targetWsId = currentWorkspaceIdRef.current;
    if (!targetWsId) {
      setDocuments([]);
      setLoading(false);
      setError(null);
      return [];
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const reqId = ++fetchRequestIdRef.current;
    setLoading(true);
    setError(null);

    try {
      const res = await api.listDocuments(targetWsId, {
        includeArchived: true,
        signal: controller.signal,
      });
      if (reqId !== fetchRequestIdRef.current || !isMountedRef.current) return [];
      setDocuments(res.documents);
      return res.documents;
    } catch (err) {
      if (reqId !== fetchRequestIdRef.current || !isMountedRef.current) return [];
      if ((err as Error)?.name === 'AbortError') return [];
      const msg =
        err instanceof ApiError && err.status === 0
          ? 'Unable to connect to server. Offline.'
          : err instanceof ApiError && err.status === 403
          ? 'Access denied to workspace documents.'
          : err instanceof ApiError
          ? err.message || 'Failed to load documents'
          : err instanceof Error
          ? err.message
          : 'Failed to load documents';
      setError(msg);
      // Preserve existing loaded documents on refresh failure, representing them as stale
      setDocuments((prev) => (prev.length > 0 ? prev : []));
      return [];
    } finally {
      if (reqId === fetchRequestIdRef.current && isMountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  // When workspaceId changes, clear documents immediately and fetch
  useEffect(() => {
    currentWorkspaceIdRef.current = workspaceId || null;
    setDocuments([]);
    setError(null);

    if (workspaceId) {
      refreshDocuments();
    } else {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      setLoading(false);
    }
  }, [workspaceId, refreshDocuments]);

  // Synchronize global window events (document:updated, workspace:refresh)
  useEffect(() => {
    function handleDocUpdated(e: Event) {
      const customEvt = e as CustomEvent<{ document: Document }>;
      if (customEvt.detail?.document) {
        const updated = customEvt.detail.document;
        if (currentWorkspaceIdRef.current && updated.workspace_id !== currentWorkspaceIdRef.current) {
          return;
        }

        setDocuments((prev) => {
          const exists = prev.some((d) => d.id === updated.id);
          if (exists) {
            return prev.map((d) => (d.id === updated.id ? updated : d));
          }
          return [...prev, updated];
        });
      }
    }

    function handleWorkspaceRefresh(e: Event) {
      const customEvt = e as CustomEvent<{ workspaceId?: string }>;
      if (
        customEvt.detail?.workspaceId &&
        currentWorkspaceIdRef.current &&
        customEvt.detail.workspaceId !== currentWorkspaceIdRef.current
      ) {
        return;
      }
      refreshDocuments();
    }

    window.addEventListener('document:updated', handleDocUpdated);
    window.addEventListener('workspace:refresh', handleWorkspaceRefresh);
    return () => {
      window.removeEventListener('document:updated', handleDocUpdated);
      window.removeEventListener('workspace:refresh', handleWorkspaceRefresh);
    };
  }, [refreshDocuments]);

  const addDocument = useCallback((newDoc: Document) => {
    if (currentWorkspaceIdRef.current && newDoc.workspace_id !== currentWorkspaceIdRef.current) {
      return;
    }
    setDocuments((prev) => {
      if (prev.some((d) => d.id === newDoc.id)) return prev;
      return [...prev, newDoc];
    });
  }, []);

  const updateDocumentInState = useCallback((updatedDoc: Document) => {
    if (currentWorkspaceIdRef.current && updatedDoc.workspace_id !== currentWorkspaceIdRef.current) {
      return;
    }
    setDocuments((prev) =>
      prev.map((d) => (d.id === updatedDoc.id ? updatedDoc : d)),
    );
  }, []);

  const removeDocument = useCallback((docId: string) => {
    setDocuments((prev) => prev.filter((d) => d.id !== docId));
  }, []);

  const activeDocuments = useMemo(
    () => documents.filter((d) => !d.is_archived),
    [documents],
  );

  const archivedDocuments = useMemo(
    () => documents.filter((d) => d.is_archived),
    [documents],
  );

  const getAncestors = useCallback(
    (docId: string) => computeAncestors(docId, documents),
    [documents],
  );

  const contextValue = useMemo<DocumentNavigationContextType>(
    () => ({
      workspaceId: workspaceId || null,
      documents,
      activeDocuments,
      archivedDocuments,
      loading,
      error,
      refreshDocuments,
      getAncestors,
      addDocument,
      updateDocument: updateDocumentInState,
      removeDocument,
    }),
    [
      workspaceId,
      documents,
      activeDocuments,
      archivedDocuments,
      loading,
      error,
      refreshDocuments,
      getAncestors,
      addDocument,
      updateDocumentInState,
      removeDocument,
    ],
  );

  return (
    <DocumentNavigationContext.Provider value={contextValue}>
      {children}
    </DocumentNavigationContext.Provider>
  );
}

export function useDocumentNavigation() {
  const context = useContext(DocumentNavigationContext);
  if (!context) {
    throw new Error('useDocumentNavigation must be used within a DocumentNavigationProvider');
  }
  return context;
}

export function useDocumentNavigationOptional() {
  return useContext(DocumentNavigationContext);
}
