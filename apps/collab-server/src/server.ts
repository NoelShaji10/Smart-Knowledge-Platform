import http from 'http';
import { WebSocketServer } from 'ws';
import { parse as parseUrl } from 'url';
import { getSystemDb, withSystemContext } from '@knowledge/database';
import { verifyAndConsumeTicket } from './ticket-verifier';
import { checkCollabServerHealth } from './health';

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

    // 2. Full Authorization Revalidation at Connection Time (Fail-Closed)
    try {
      const isAuthorized = await withSystemContext(async (systemDb) => {
        // a. Authenticated user exists
        const user = await systemDb
          .selectFrom('users')
          .where('id', '=', ticketData.userId)
          .select(['id'])
          .executeTakeFirst();

        if (!user) return { ok: false, status: 401 };

        // b. Workspace membership check
        const member = await systemDb
          .selectFrom('workspace_members')
          .where('workspace_id', '=', ticketData.workspaceId)
          .where('user_id', '=', ticketData.userId)
          .select(['role'])
          .executeTakeFirst();

        if (!member) return { ok: false, status: 403 };

        // c. Document exists and belongs to workspaceId
        const doc = await systemDb
          .selectFrom('documents')
          .where('id', '=', ticketData.documentId)
          .select(['workspace_id'])
          .executeTakeFirst();

        if (!doc || doc.workspace_id !== ticketData.workspaceId) {
          return { ok: false, status: 403 };
        }

        // d. Check for explicit document permission denial
        const docPerm = await systemDb
          .selectFrom('document_permissions')
          .where('document_id', '=', ticketData.documentId)
          .where('user_id', '=', ticketData.userId)
          .select(['role'])
          .executeTakeFirst();

        if (docPerm && docPerm.role === 'none') {
          return { ok: false, status: 403 };
        }

        return { ok: true, status: 200 };
      });

      if (!isAuthorized.ok) {
        const statusCode = isAuthorized.status === 401 ? '401 Unauthorized' : '403 Forbidden';
        socket.write(`HTTP/1.1 ${statusCode}\r\n\r\n`);
        socket.destroy();
        return;
      }
    } catch (err) {
      // FAIL CLOSED: Database error during connection authorization MUST reject the connection
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, ticketData);
    });
  });

  return { server, wss };
}
