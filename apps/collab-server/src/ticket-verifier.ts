import { getRedisClient } from '@knowledge/redis';

export interface TicketData {
  userId: string;
  workspaceId: string;
  documentId: string;
}

export async function verifyAndConsumeTicket(ticket: string, documentId: string): Promise<TicketData | null> {
  if (!ticket) return null;

  try {
    const redis = getRedisClient();
    const key = `ws_ticket:${ticket}`;
    const raw = await redis.get(key);

    if (!raw) return null;

    // Single-use: delete immediately after reading
    await redis.del(key);

    const data = JSON.parse(raw) as TicketData;
    if (data.documentId !== documentId) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
