import { getRedisClient } from '@knowledge/redis';

export interface TicketData {
  userId: string;
  workspaceId: string;
  documentId: string;
}

const ATOMIC_CONSUME_LUA = `
  local val = redis.call('GET', KEYS[1])
  if val then
    redis.call('DEL', KEYS[1])
  end
  return val
`;

export async function verifyAndConsumeTicket(
  ticket: string,
  documentId: string,
): Promise<TicketData | null> {
  if (!ticket) return null;

  try {
    const redis = getRedisClient();
    const key = `ws_ticket:${ticket}`;

    // Atomic one-time ticket consumption (prevents replay under concurrent requests)
    const raw = (await redis.eval(ATOMIC_CONSUME_LUA, 1, key)) as string | null;

    if (!raw) return null;

    const data = JSON.parse(raw) as TicketData;
    if (data.documentId !== documentId) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
