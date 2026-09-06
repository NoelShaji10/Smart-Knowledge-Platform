import http from 'http';
import crypto from 'crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { parse as parseUrl } from 'url';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import type { WorkspaceRole, DocumentRole } from '@knowledge/types';

import { withSystemContext } from '@knowledge/database';
import { verifyAndConsumeTicket, TicketData } from './ticket-verifier';
import { checkCollabServerHealth } from './health';
import {
  getOrCreateRoom,
  addConnectionToRoom,
  removeConnectionFromRoom,
  removeRoomIfEmpty,
  ClientConnection,
  Room,
  MESSAGE_YJS_SYNC,
} from './room-manager';

export function sendBinary(ws: WebSocket, payload: Uint8Array): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(payload, { binary: true });
    } catch {
      // Ignored: socket errors handled by ws error/close listeners
    }
  }
}

export function sendSyncStep1(conn: ClientConnection, room: Room): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_YJS_SYNC);
  syncProtocol.writeSyncStep1(encoder, room.doc);
  sendBinary(conn.ws, encoding.toUint8Array(encoder));
}

export function handleIncomingMessage(
  client: ClientConnection,
  room: Room,
  data: WebSocket.RawData,
): void {
  let buf: Uint8Array;
  if (Buffer.isBuffer(data)) {
    buf = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else if (data instanceof ArrayBuffer) {
    buf = new Uint8Array(data);
  } else if (Array.isArray(data)) {
    buf = new Uint8Array(Buffer.concat(data));
  } else {
    // Unsupported text frame format — ignore safely
    return;
  }

  if (buf.length === 0) return;

  try {
    const decoder = decoding.createDecoder(buf);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case MESSAGE_YJS_SYNC: {
        const syncMessageType = decoding.readVarUint(decoder);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_YJS_SYNC);

        if (syncMessageType === syncProtocol.messageYjsSyncStep1) {
          // SyncStep1: Read client state vector and reply with server SyncStep2 (so viewer receives room state)
          syncProtocol.readSyncStep1(decoder, encoder, room.doc);
          if (encoding.length(encoder) > 1) {
            sendBinary(client.ws, encoding.toUint8Array(encoder));
          }
        } else if (
          syncMessageType === syncProtocol.messageYjsSyncStep2 ||
          syncMessageType === syncProtocol.messageYjsUpdate
        ) {
          // SyncStep2 or Update: Document mutation requested!
          if (!client.canEdit) {
            // VIEWER WRITE ENFORCEMENT: Client does not have write permission on this document.
            // Server DROPS update. Do NOT call readSyncStep2 or readUpdate.
            // Do NOT mutate room.doc.
            // Do NOT trigger snapshot debounce, indexing, versioning, or broadcast.
            return;
          }

          if (syncMessageType === syncProtocol.messageYjsSyncStep2) {
            syncProtocol.readSyncStep2(decoder, room.doc, client);
          } else {
            syncProtocol.readUpdate(decoder, room.doc, client);
          }
        }
        break;
      }
      case 1: {
        // Awareness message — broadcast to other connections in room
        for (const conn of room.connections) {
          if (conn !== client && conn.ws.readyState === WebSocket.OPEN) {
            sendBinary(conn.ws, buf);
          }
        }
        break;
      }
      default: {
        // Unknown message type — ignore safely
        break;
      }
    }
  } catch {
    // Malformed/unparseable Yjs packet — catch safely without crashing process
  }
}

export interface CollabAuthContext extends TicketData {
  canEdit: boolean;
  effectiveRole: WorkspaceRole | DocumentRole;
}

export function createCollabServer() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      const health = await checkCollabServerHealth();
      res.writeHead(health.healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (request, socket, head) => {
    const { pathname, query } = parseUrl(request.url || '', true);

    // Expect route: /ws/doc/:documentId?ticket=:opaqueTicket
    const match = pathname?.match(/^\/ws\/doc\/([^/]+)$/);
    if (!match) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const documentId = match[1];
    const ticket = query.ticket as string;

    // 1. Verify ticket before upgrade — handshake rejection if invalid
    const ticketData = await verifyAndConsumeTicket(ticket, documentId);
    if (!ticketData) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // 2. Full Authorization Revalidation & Effective Role Resolution (Fail-Closed)
    try {
      const authResult = await withSystemContext(async (systemDb) => {
        // a. Authenticated user exists
        const user = await systemDb
          .selectFrom('users')
          .where('id', '=', ticketData.userId)
          .select(['id'])
          .executeTakeFirst();

        if (!user) return { ok: false, status: 401, canEdit: false, effectiveRole: 'viewer' as const };

        // b. Workspace membership check
        const member = await systemDb
          .selectFrom('workspace_members')
          .where('workspace_id', '=', ticketData.workspaceId)
          .where('user_id', '=', ticketData.userId)
          .select(['role'])
          .executeTakeFirst();

        if (!member) return { ok: false, status: 403, canEdit: false, effectiveRole: 'viewer' as const };

        const wsRole = member.role as WorkspaceRole;

        // c. Document exists and belongs to workspaceId
        const doc = await systemDb
          .selectFrom('documents')
          .where('id', '=', ticketData.documentId)
          .select(['workspace_id', 'is_archived'])
          .executeTakeFirst();

        if (!doc || doc.workspace_id !== ticketData.workspaceId) {
          return { ok: false, status: 403, canEdit: false, effectiveRole: 'viewer' as const };
        }

        // d. Check for explicit document permission override
        const docPerm = await systemDb
          .selectFrom('document_permissions')
          .where('document_id', '=', ticketData.documentId)
          .where('user_id', '=', ticketData.userId)
          .select(['role'])
          .executeTakeFirst();

        const overrideRole = docPerm ? (docPerm.role as DocumentRole) : null;

        if (overrideRole === 'none') {
          return { ok: false, status: 403, canEdit: false, effectiveRole: 'none' as const };
        }

        const isArchived = Boolean(doc.is_archived);
        let canEdit = false;

        if (wsRole === 'owner' || wsRole === 'admin') {
          canEdit = !isArchived;
        } else if (wsRole === 'editor') {
          canEdit = overrideRole !== 'viewer' && !isArchived;
        } else if (wsRole === 'viewer') {
          canEdit = overrideRole === 'editor' && !isArchived;
        }

        const effectiveRole = overrideRole || wsRole;

        return { ok: true, status: 200, canEdit, effectiveRole };
      });

      if (!authResult.ok) {
        const statusCode = authResult.status === 401 ? '401 Unauthorized' : '403 Forbidden';
        socket.write(`HTTP/1.1 ${statusCode}\r\n\r\n`);
        socket.destroy();
        return;
      }

      const authContext: CollabAuthContext = {
        ...ticketData,
        canEdit: authResult.canEdit,
        effectiveRole: authResult.effectiveRole,
      };

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, authContext);
      });
    } catch (err) {
      // FAIL CLOSED: Database error during connection authorization MUST reject connection
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
      return;
    }
  });

  wss.on('connection', async (ws: WebSocket, request: http.IncomingMessage, authContext: CollabAuthContext) => {
    const connectionId = crypto.randomUUID();
    let room: Room;
    try {
      room = await getOrCreateRoom(authContext.documentId);
    } catch (err) {
      console.error(`[collab-server] Failed to load room for document ${authContext.documentId}:`, err);
      ws.close(1011, 'Internal Server Error loading document room');
      return;
    }

    const clientConn: ClientConnection = {
      id: connectionId,
      ws,
      userId: authContext.userId,
      workspaceId: authContext.workspaceId,
      documentId: authContext.documentId,
      canEdit: authContext.canEdit,
      effectiveRole: authContext.effectiveRole,
    };

    addConnectionToRoom(room, clientConn);

    // Initial Sync: Send SyncStep1 from server to client
    sendSyncStep1(clientConn, room);

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        handleIncomingMessage(clientConn, room, data);
      } catch {
        // Safe exception handling
      }
    });

    const handleCleanup = () => {
      removeConnectionFromRoom(room, clientConn);
      removeRoomIfEmpty(authContext.documentId, authContext.userId).catch((err) => {
        console.error(`[collab-server] Error removing room ${authContext.documentId}:`, err);
      });
    };

    ws.onclose = handleCleanup;
    ws.onerror = handleCleanup;
  });

  return { server, wss };
}
