export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  settings?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceMember {
  user_id: string;
  workspace_id: string;
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  created_at: string;
  user?: User;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
}

export interface RefreshResponse {
  accessToken: string;
}

export interface WorkspacesResponse {
  workspaces: Workspace[];
}

export interface WorkspaceResponse {
  workspace: Workspace;
  userRole: 'owner' | 'admin' | 'editor' | 'viewer';
}

export class ApiError extends Error {
  status: number;
  data?: unknown;

  constructor(message: string, status: number, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || '';

let inMemoryAccessToken: string | null = null;
let refreshPromise: Promise<string> | null = null;
let authStateListeners: Array<() => void> = [];

export function getAccessToken(): string | null {
  return inMemoryAccessToken;
}

export function setAccessToken(token: string | null): void {
  inMemoryAccessToken = token;
}

export function onAuthFailure(listener: () => void): () => void {
  authStateListeners.push(listener);
  return () => {
    authStateListeners = authStateListeners.filter((l) => l !== listener);
  };
}

function notifyAuthFailure(): void {
  for (const listener of authStateListeners) {
    try {
      listener();
    } catch {
      // Ignore listener errors
    }
  }
}

/**
 * Single-flight concurrency-safe token refresh mechanism.
 * If multiple API calls receive 401 simultaneously, only ONE refresh request is issued.
 */
export async function refreshAccessTokenSingleFlight(): Promise<string> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      let res: Response;
      try {
        res = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
        });
      } catch (err) {
        throw new ApiError('Network error or server unavailable', 0, err);
      }

      if (!res.ok) {
        let errMessage = 'Failed to refresh token';
        try {
          const errJson = await res.json();
          if (errJson?.error) errMessage = errJson.error;
        } catch {
          // Ignore JSON parse failure
        }
        throw new ApiError(errMessage, res.status);
      }

      const data: RefreshResponse = await res.json();
      setAccessToken(data.accessToken);
      return data.accessToken;
    } catch (error) {
      setAccessToken(null);
      if (error instanceof ApiError && error.status === 401) {
        notifyAuthFailure();
      }
      throw error;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export interface ApiRequestOptions extends RequestInit {
  timeoutMs?: number;
}

export function isAbortError(err: unknown): boolean {
  return (err as Error)?.name === 'AbortError';
}

export function isRetryableError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return (
      err.status === 0 ||
      err.status === 408 ||
      err.status === 429 ||
      err.status === 502 ||
      err.status === 503 ||
      err.status === 504
    );
  }
  return false;
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (err: unknown) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 300;
  const maxDelayMs = options.maxDelayMs ?? 3000;
  const shouldRetry = options.shouldRetry ?? isRetryableError;

  let attempt = 0;
  let delay = initialDelayMs;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (isAbortError(err) || attempt > maxRetries || !shouldRetry(err)) {
        throw err;
      }
      const jitter = 0.8 + Math.random() * 0.4;
      const sleepMs = Math.min(maxDelayMs, Math.round(delay * jitter));
      await new Promise((res) => setTimeout(res, sleepMs));
      delay = Math.min(maxDelayMs, delay * 2);
    }
  }
}

export async function apiRequest<T>(
  endpoint: string,
  options: ApiRequestOptions = {},
  isRetry = false,
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  const headers = new Headers(options.headers || {});

  if (!headers.has('Content-Type') && options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  if (inMemoryAccessToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${inMemoryAccessToken}`);
  }

  // Setup abort controller and optional timeout
  let timeoutId: NodeJS.Timeout | null = null;
  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => {
    controller.abort();
  };

  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const timeoutMs = options.timeoutMs;
  if (typeof timeoutMs === 'number' && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  const fetchOptions: RequestInit = {
    ...options,
    headers,
    credentials: 'include',
    signal: controller.signal,
  };

  let response: Response;
  try {
    response = await fetch(url, fetchOptions);
  } catch (err) {
    if (timedOut) {
      throw new ApiError(`Request timed out after ${timeoutMs}ms`, 408);
    }
    if ((err as Error)?.name === 'AbortError') {
      throw err;
    }
    throw new ApiError('Network error or server unavailable', 0, err);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (options.signal) {
      options.signal.removeEventListener('abort', onExternalAbort);
    }
  }

  if (response.status === 401 && !isRetry && endpoint !== '/api/v1/auth/refresh' && endpoint !== '/api/v1/auth/login') {
    try {
      const newToken = await refreshAccessTokenSingleFlight();
      headers.set('Authorization', `Bearer ${newToken}`);
      return apiRequest<T>(endpoint, { ...options, headers }, true);
    } catch (refreshErr) {
      throw refreshErr;
    }
  }

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status} Error`;
    let errorData: unknown = null;
    try {
      errorData = await response.json();
      if (typeof errorData === 'object' && errorData !== null && 'error' in errorData) {
        errorMessage = String((errorData as { error: unknown }).error);
      }
    } catch {
      // Ignore json parsing error
    }
    throw new ApiError(errorMessage, response.status, errorData);
  }

  // Support 204 No Content
  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

export interface Document {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  title: string;
  content_text: string;
  snapshot_key?: string | null;
  snapshot_version?: number;
  is_archived?: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentCapabilities {
  canRead: boolean;
  canEdit: boolean;
  canMove: boolean;
  canArchive: boolean;
  canManagePermissions: boolean;
}

export interface DocumentResponse {
  document: Document;
  effectiveRole: 'editor' | 'viewer' | 'none';
  capabilities: DocumentCapabilities;
}

export interface DocumentVersion {
  id: string;
  document_id: string;
  version_number: number;
  snapshot_key: string | null;
  content_text: string;
  title: string;
  created_by: string | null;
  creator_name?: string | null;
  creator_email?: string | null;
  trigger: 'manual' | 'auto_interval' | 'session_end' | 'restore';
  created_at: string;
}

export interface DocumentPermissionOverride {
  id: string;
  email: string;
  display_name: string;
  role: 'editor' | 'viewer' | 'none';
  workspace_role?: 'owner' | 'admin' | 'editor' | 'viewer';
  granted_by: string;
  created_at: string;
}

export const api = {
  login: (data: { email: string; password: string }) =>
    apiRequest<AuthResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  register: (data: { displayName: string; email: string; password: string }) =>
    apiRequest<AuthResponse>('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  refresh: () => refreshAccessTokenSingleFlight(),

  getMe: () => apiRequest<{ user: User }>('/api/v1/auth/me', { method: 'GET' }),

  logout: async () => {
    try {
      await apiRequest<{ ok: boolean }>('/api/v1/auth/logout', { method: 'POST' });
    } catch {
      // Ignore backend errors: client session must clear unconditionally
    } finally {
      setAccessToken(null);
    }
  },

  logoutAll: async (): Promise<{ ok: boolean; remoteRevoked: boolean }> => {
    let remoteRevoked = false;
    try {
      await apiRequest<{ ok: boolean }>('/api/v1/auth/logout-all', { method: 'POST' });
      remoteRevoked = true;
    } catch {
      // Ignore backend errors: client session must clear unconditionally,
      // but remoteRevoked is false so callers can detect if remote revocation was not confirmed
      remoteRevoked = false;
    } finally {
      setAccessToken(null);
    }
    return { ok: true, remoteRevoked };
  },

  getWorkspaces: () => apiRequest<WorkspacesResponse>('/api/v1/workspaces', { method: 'GET' }),

  getWorkspace: (workspaceId: string, options?: { signal?: AbortSignal }) =>
    apiRequest<WorkspaceResponse>(`/api/v1/workspaces/${workspaceId}`, {
      method: 'GET',
      signal: options?.signal,
    }),

  listWorkspaceMembers: (workspaceId: string) =>
    apiRequest<{
      members: Array<{
        id: string;
        email: string;
        display_name: string;
        avatar_url: string | null;
        role: 'owner' | 'admin' | 'editor' | 'viewer';
        created_at: string;
      }>;
    }>(`/api/v1/workspaces/${workspaceId}/members`, { method: 'GET' }),

  createWorkspace: (name: string) =>
    apiRequest<{ workspace: Workspace }>('/api/v1/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  listDocuments: (
    workspaceId: string,
    params?: { parentId?: string | null; includeArchived?: boolean; signal?: AbortSignal },
  ) => {
    const query = new URLSearchParams();
    if (params?.parentId !== undefined) {
      query.set('parentId', params.parentId === null ? 'null' : params.parentId);
    }
    if (params?.includeArchived) {
      query.set('includeArchived', 'true');
    }
    const queryString = query.toString() ? `?${query.toString()}` : '';
    return apiRequest<{ documents: Document[] }>(`/api/v1/workspaces/${workspaceId}/documents${queryString}`, {
      method: 'GET',
      signal: params?.signal,
    });
  },

  createDocument: (workspaceId: string, data: { title?: string; parentId?: string | null; contentText?: string }) =>
    apiRequest<{ document: Document }>(`/api/v1/workspaces/${workspaceId}/documents`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getDocument: (workspaceId: string, documentId: string, options?: { signal?: AbortSignal }) =>
    apiRequest<DocumentResponse>(`/api/v1/workspaces/${workspaceId}/documents/${documentId}`, {
      method: 'GET',
      signal: options?.signal,
    }),

  updateDocument: (workspaceId: string, documentId: string, data: { title?: string; contentText?: string }) =>
    apiRequest<{ document: Document }>(`/api/v1/workspaces/${workspaceId}/documents/${documentId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  moveDocument: (workspaceId: string, documentId: string, parentId: string | null) =>
    apiRequest<{ document: Document }>(`/api/v1/workspaces/${workspaceId}/documents/${documentId}/move`, {
      method: 'POST',
      body: JSON.stringify({ parentId }),
    }),

  archiveDocument: (workspaceId: string, documentId: string) =>
    apiRequest<{ document: Document }>(`/api/v1/workspaces/${workspaceId}/documents/${documentId}/archive`, {
      method: 'POST',
    }),

  restoreDocument: (workspaceId: string, documentId: string) =>
    apiRequest<{ document: Document }>(`/api/v1/workspaces/${workspaceId}/documents/${documentId}/restore`, {
      method: 'POST',
    }),

  listDocumentPermissions: (workspaceId: string, documentId: string) =>
    apiRequest<{ permissions: DocumentPermissionOverride[] }>(
      `/api/v1/workspaces/${workspaceId}/documents/${documentId}/permissions`,
      { method: 'GET' },
    ),

  setDocumentPermission: (
    workspaceId: string,
    documentId: string,
    targetUserId: string,
    role: 'editor' | 'viewer' | 'none',
  ) =>
    apiRequest<{ permission: DocumentPermissionOverride }>(
      `/api/v1/workspaces/${workspaceId}/documents/${documentId}/permissions/${targetUserId}`,
      {
        method: 'PUT',
        body: JSON.stringify({ role }),
      },
    ),

  removeDocumentPermission: (workspaceId: string, documentId: string, targetUserId: string) =>
    apiRequest<{ ok: boolean }>(
      `/api/v1/workspaces/${workspaceId}/documents/${documentId}/permissions/${targetUserId}`,
      { method: 'DELETE' },
    ),

  listVersions: (workspaceId: string, documentId: string) =>
    apiRequest<{ versions: DocumentVersion[] }>(`/api/v1/workspaces/${workspaceId}/documents/${documentId}/versions`, {
      method: 'GET',
    }),

  getVersion: (workspaceId: string, documentId: string, versionNumber: number) =>
    apiRequest<{ version: DocumentVersion }>(
      `/api/v1/workspaces/${workspaceId}/documents/${documentId}/versions/${versionNumber}`,
      { method: 'GET' },
    ),

  createVersion: (workspaceId: string, documentId: string) =>
    apiRequest<{ version: DocumentVersion }>(`/api/v1/workspaces/${workspaceId}/documents/${documentId}/versions`, {
      method: 'POST',
    }),

  restoreVersion: (workspaceId: string, documentId: string, versionNumber: number) =>
    apiRequest<{ document: Document; newVersion: DocumentVersion }>(
      `/api/v1/workspaces/${workspaceId}/documents/${documentId}/versions/${versionNumber}/restore`,
      { method: 'POST' },
    ),

  requestWsTicket: (workspaceId: string, documentId: string) =>
    apiRequest<{ ticket: string }>('/api/v1/ws/ticket', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, documentId }),
    }),
};
