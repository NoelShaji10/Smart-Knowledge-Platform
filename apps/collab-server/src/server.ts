import http from 'http';
import { WebSocketServer } from 'ws';
import { parse as parseUrl } from 'url';
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

    // Verify ticket before upgrade — handshake rejection if invalid
    const ticketData = await verifyAndConsumeTicket(ticket, documentId);
    if (!ticketData) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, ticketData);
    });
  });

  return { server, wss };
}
