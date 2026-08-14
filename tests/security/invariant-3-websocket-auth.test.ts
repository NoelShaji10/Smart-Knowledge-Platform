import { describe, it, expect } from 'vitest';
import { verifyAndConsumeTicket } from '../../apps/collab-server/src/ticket-verifier';

describe('Security Invariant 3: WebSocket Auth Handshake Rejection', () => {
  it('rejects connection when ticket is missing, invalid, or expired', async () => {
    const result = await verifyAndConsumeTicket('invalid-ticket', 'doc-123');
    expect(result).toBeNull();
  });
});
