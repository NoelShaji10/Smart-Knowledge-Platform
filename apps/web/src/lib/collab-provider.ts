import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { api, ApiError } from './api';

export const MESSAGE_YJS_SYNC = 0;
export const MESSAGE_YJS_AWARENESS = 1;

export type CollabProviderStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface CollabProviderOptions {
  workspaceId: string;
  documentId: string;
  doc: Y.Doc;
  collabUrl?: string;
  user?: {
    id: string;
    displayName: string;
    color?: string;
  };
  onStatusChange?: (status: CollabProviderStatus) => void;
  onError?: (error: Error) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export class CollabProvider {
  public readonly workspaceId: string;
  public readonly documentId: string;
  public readonly doc: Y.Doc;
  public readonly awareness: awarenessProtocol.Awareness;
  public status: CollabProviderStatus = 'disconnected';

  private collabUrl: string;
  private ws: WebSocket | null = null;
  private isDestroyed = false;
  private onStatusChange?: (status: CollabProviderStatus) => void;
  private onError?: (error: Error) => void;

  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private currentBackoffMs: number;
  private initialBackoffMs: number;
  private maxBackoffMs: number;

  constructor(options: CollabProviderOptions) {
    this.workspaceId = options.workspaceId;
    this.documentId = options.documentId;
    this.doc = options.doc;
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.collabUrl = options.collabUrl || process.env.NEXT_PUBLIC_COLLAB_URL || 'http://localhost:3001';
    this.onStatusChange = options.onStatusChange;
    this.onError = options.onError;

    this.initialBackoffMs = options.initialBackoffMs ?? 1000;
    this.currentBackoffMs = this.initialBackoffMs;
    this.maxBackoffMs = options.maxBackoffMs ?? 30000;

    this.doc.on('update', this.handleDocUpdate);
    this.awareness.on('update', this.handleAwarenessUpdate);

    if (options.user) {
      this.setUser(options.user);
    }

    this.connect();
  }

  public setUser(user: { id: string; displayName: string; color?: string }): void {
    this.awareness.setLocalStateField('user', {
      id: user.id,
      name: user.displayName,
      color: user.color,
    });
  }

  private updateStatus(newStatus: CollabProviderStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      if (this.onStatusChange && !this.isDestroyed) {
        this.onStatusChange(newStatus);
      }
    }
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin !== this && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_YJS_SYNC);
        syncProtocol.writeUpdate(encoder, update);
        this.ws.send(encoding.toUint8Array(encoder));
      } catch (err) {
        console.error('[CollabProvider] Failed to send document update over WebSocket:', err);
      }
    }
  };

  private handleAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin !== 'remote' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const changedClients = added.concat(updated).concat(removed);
        const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_YJS_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessUpdate);
        this.ws.send(encoding.toUint8Array(encoder));
      } catch (err) {
        console.error('[CollabProvider] Failed to send awareness update over WebSocket:', err);
      }
    }
  };

  private scheduleReconnect(): void {
    if (this.isDestroyed || this.reconnectTimeout) return;

    // Calculate delay with ±20% jitter
    const jitterFactor = 0.8 + Math.random() * 0.4;
    const delay = Math.min(this.maxBackoffMs, Math.round(this.currentBackoffMs * jitterFactor));

    // Increase backoff exponentially for next attempt
    this.currentBackoffMs = Math.min(this.maxBackoffMs, this.currentBackoffMs * 2);

    this.updateStatus('connecting');

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (!this.isDestroyed) {
        this.connect();
      }
    }, delay);
  }

  public async connect(): Promise<void> {
    if (
      this.isDestroyed ||
      (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING))
    ) {
      return;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.updateStatus('connecting');

    try {
      // 1. Acquire fresh opaque single-use ticket via API
      const { ticket } = await api.requestWsTicket(this.workspaceId, this.documentId);

      if (this.isDestroyed) return;

      // 2. Format WebSocket URL correctly using scheme substitution
      let wsBase = this.collabUrl;
      if (wsBase.startsWith('http://')) {
        wsBase = wsBase.replace('http://', 'ws://');
      } else if (wsBase.startsWith('https://')) {
        wsBase = wsBase.replace('https://', 'wss://');
      } else if (!wsBase.startsWith('ws://') && !wsBase.startsWith('wss://')) {
        const isSecure = typeof window !== 'undefined' && window.location.protocol === 'https:';
        wsBase = `${isSecure ? 'wss' : 'ws'}://${wsBase}`;
      }

      // Remove trailing slash if present
      wsBase = wsBase.replace(/\/$/, '');
      const wsUrl = `${wsBase}/ws/doc/${encodeURIComponent(this.documentId)}?ticket=${encodeURIComponent(ticket)}`;

      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.onopen = () => {
        if (this.isDestroyed) {
          ws.close();
          return;
        }

        // Reset exponential backoff on successful connection
        this.currentBackoffMs = this.initialBackoffMs;
        this.updateStatus('connected');

        // Send initial SyncStep1 to server
        const encoderSync = encoding.createEncoder();
        encoding.writeVarUint(encoderSync, MESSAGE_YJS_SYNC);
        syncProtocol.writeSyncStep1(encoderSync, this.doc);
        ws.send(encoding.toUint8Array(encoderSync));

        // Send initial local awareness state to server
        if (this.awareness.getLocalState() !== null) {
          const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
          const encoderAwareness = encoding.createEncoder();
          encoding.writeVarUint(encoderAwareness, MESSAGE_YJS_AWARENESS);
          encoding.writeVarUint8Array(encoderAwareness, awarenessUpdate);
          ws.send(encoding.toUint8Array(encoderAwareness));
        }
      };

      ws.onmessage = (event: MessageEvent) => {
        if (this.isDestroyed) return;

        let buf: Uint8Array;
        if (event.data instanceof ArrayBuffer) {
          buf = new Uint8Array(event.data);
        } else if (ArrayBuffer.isView(event.data)) {
          buf = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
        } else {
          return;
        }

        if (buf.length === 0) return;

        try {
          const decoder = decoding.createDecoder(buf);
          const messageType = decoding.readVarUint(decoder);

          if (messageType === MESSAGE_YJS_SYNC) {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, MESSAGE_YJS_SYNC);

            // Process sync message and apply changes to Y.Doc with origin set to this provider
            syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);

            if (encoding.length(encoder) > 1 && ws.readyState === WebSocket.OPEN) {
              ws.send(encoding.toUint8Array(encoder));
            }
          } else if (messageType === MESSAGE_YJS_AWARENESS) {
            const awarenessUpdate = decoding.readVarUint8Array(decoder);
            awarenessProtocol.applyAwarenessUpdate(this.awareness, awarenessUpdate, 'remote');
          }
        } catch (err) {
          console.error('[CollabProvider] Error processing incoming message:', err);
        }
      };

      ws.onerror = () => {
        if (this.isDestroyed) return;
        const err = new Error('WebSocket connection error');
        if (this.onError) {
          this.onError(err);
        }
      };

      ws.onclose = () => {
        this.ws = null;
        if (!this.isDestroyed) {
          this.updateStatus('disconnected');
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      if (this.isDestroyed) return;
      const error = err instanceof Error ? err : new Error(String(err));

      if (this.onError) {
        this.onError(error);
      }

      // Check if ticket request failed due to non-retryable authorization/authentication errors
      const isAuthError =
        err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 404);

      if (isAuthError) {
        // Stop retrying on deterministic auth failures (e.g. ticket denied, user unauthenticated, permission revoked)
        this.updateStatus('error');
      } else {
        // Temporary network or server error — schedule reconnect retry
        this.scheduleReconnect();
      }
    }
  }

  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.doc.off('update', this.handleDocUpdate);
    this.awareness.off('update', this.handleAwarenessUpdate);

    try {
      awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'local');
      this.awareness.destroy();
    } catch {
      // Ignore awareness destruction errors
    }

    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.updateStatus('disconnected');
  }
}

