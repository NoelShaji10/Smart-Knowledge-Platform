import { describe, it, expect } from 'vitest';
import { createCollabServer } from './server';

describe('collab-server instantiation', () => {
  it('creates HTTP server and WebSocketServer instances', () => {
    const { server, wss } = createCollabServer();
    expect(server).toBeDefined();
    expect(wss).toBeDefined();
  });
});
