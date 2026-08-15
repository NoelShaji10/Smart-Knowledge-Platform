import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import * as redisModule from '@knowledge/redis';
import { verifyAndConsumeTicket } from '../../apps/collab-server/src/ticket-verifier';

describe('HIGH 2: Atomic WebSocket Ticket Consumption & Concurrent Replay Prevention', () => {
  it('ensures 1 valid ticket with 2 concurrent consumption attempts yields exactly 1 success', async () => {
    const ticket = crypto.randomBytes(32).toString('hex');
    const documentId = crypto.randomUUID();

    const ticketData = {
      userId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      documentId,
    };

    // In-memory store simulating atomic Redis GETDEL Lua execution
    const store = new Map<string, string>();
    store.set(`ws_ticket:${ticket}`, JSON.stringify(ticketData));

    const mockRedis = {
      eval: vi.fn().mockImplementation(async (script: string, numKeys: number, key: string) => {
        const val = store.get(key) || null;
        if (val) {
          store.delete(key);
        }
        return val;
      }),
    };

    vi.spyOn(redisModule, 'getRedisClient').mockReturnValue(mockRedis as any);

    // Fire 2 concurrent verification requests for the exact same ticket
    const [res1, res2] = await Promise.all([
      verifyAndConsumeTicket(ticket, documentId),
      verifyAndConsumeTicket(ticket, documentId),
    ]);

    const successes = [res1, res2].filter((r) => r !== null);
    const failures = [res1, res2].filter((r) => r === null);

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(successes[0]?.documentId).toBe(documentId);
    expect(mockRedis.eval).toHaveBeenCalledTimes(2);
  });
});
