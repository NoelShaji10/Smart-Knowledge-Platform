import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import { api, ApiError } from './api';

export const MESSAGE_YJS_SYNC = 0;
export const MESSAGE_YJS_AWARENESS = 1;
export const MESSAGE_PERSISTENCE = 2;

export const PERSISTENCE_STATUS_PERSISTED = 0;
export const PERSISTENCE_STATUS_PERSISTING = 1;
export const PERSISTENCE_STATUS_ERROR = 2;

export type CollabProviderStatus = 'connecting' | 'connected' | 'disconnected' | 'error';
export type PersistenceState = 'persisted' | 'editing' | 'saving' | 'error' | 'delayed';

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
  onPersistenceChange?: (state: PersistenceState, details?: { error?: string }) => void;
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
  public persistenceState: PersistenceState = 'persisted';

  private collabUrl: string;
  private ws: WebSocket | null = null;
  private isDestroyed = false;
  private onStatusChange?: (status: CollabProviderStatus) => void;
  private onPersistenceChange?: (state: PersistenceState, details?: { error?: string }) => void;
  private onError?: (error: Error) => void;

  private localEditRev = 0;
  private acknowledgedLocalRev = 0;
  private seqToLocalRev = new Map<number, number>();
  private latestPersistedSeq = 0;
  private latestErrorSeq = 0;

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
    this.onPersistenceChange = options.onPersistenceChange;
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

  private updatePersistenceState(newState: PersistenceState, details?: { error?: string }): void {
    if (this.persistenceState !== newState) {
      this.persistenceState = newState;
      if (this.onPersistenceChange && !this.isDestroyed) {
        this.onPersistenceChange(newState, details);
      }
    }
  }

  public get isDirty(): boolean {
    return this.localEditRev > this.acknowledgedLocalRev;
  }

  public getLocalEditRev(): number {
    return this.localEditRev;
  }

  public getAcknowledgedLocalRev(): number {
    return this.acknowledgedLocalRev;
  }

  public getLatestPersistedSeq(): number {
    return this.latestPersistedSeq;
  }

  public requestPersistenceFlush(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_PERSISTENCE);
        this.ws.send(encoding.toUint8Array(encoder));
      } catch (err) {
        console.error('[CollabProvider] Failed to send persistence flush request:', err);
      }
    }
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin !== this) {
      this.localEditRev += 1;
      this.updatePersistenceState('editing');
    }
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

    this.seqToLocalRev.clear();
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
          } else if (messageType === MESSAGE_PERSISTENCE) {
            const status = decoding.readVarUint(decoder);
            const seq = decoding.readVarUint(decoder);

            if (status === PERSISTENCE_STATUS_PERSISTING) {
              // Map this exact sequence to the local edit revision that existed when this persistence operation started
              this.seqToLocalRev.set(seq, this.localEditRev);
              this.updatePersistenceState('saving');
            } else if (status === PERSISTENCE_STATUS_PERSISTED) {
              // Retrieve the revision captured when sequence `seq` was initiated
              const capturedRev = this.seqToLocalRev.get(seq) ?? this.acknowledgedLocalRev;
              this.acknowledgedLocalRev = Math.max(this.acknowledgedLocalRev, capturedRev);
              this.latestPersistedSeq = Math.max(this.latestPersistedSeq, seq);

              // Clean up mapped sequences <= seq
              const seqsToDelete: number[] = [];
              this.seqToLocalRev.forEach((_rev, s) => {
                if (s <= seq) {
                  seqsToDelete.push(s);
                }
              });
              for (let i = 0; i < seqsToDelete.length; i++) {
                this.seqToLocalRev.delete(seqsToDelete[i]);
              }

              // Only transition to 'persisted' if all local edits up to the current revision have been acknowledged
              if (this.localEditRev <= this.acknowledgedLocalRev) {
                this.updatePersistenceState('persisted');
              } else {
                // Newer local edits occurred during or after this sequence; remain editing/dirty
                this.updatePersistenceState('editing');
              }
            } else if (status === PERSISTENCE_STATUS_ERROR) {
              let errorMsg = 'Failed to persist document snapshot';
              try {
                if (decoding.hasContent(decoder)) {
                  errorMsg = decoding.readVarString(decoder);
                }
              } catch {
                // Ignore decoding error
              }

              this.seqToLocalRev.delete(seq);

              // Stale error guard: an old failure must NOT overwrite a newer successful persistence state
              // or overwrite an in-flight persistence operation for a newer revision.
              const hasNewerPersisted = seq < this.latestPersistedSeq;
              let hasNewerInFlight = false;
              this.seqToLocalRev.forEach((_rev, s) => {
                if (s > seq) {
                  hasNewerInFlight = true;
                }
              });

              if (!hasNewerPersisted && !hasNewerInFlight) {
                this.latestErrorSeq = Math.max(this.latestErrorSeq, seq);
                this.updatePersistenceState('error', { error: errorMsg });
              }
            }
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

    this.seqToLocalRev.clear();
    this.latestPersistedSeq = 0;
    this.latestErrorSeq = 0;
    this.updateStatus('disconnected');
  }
}

