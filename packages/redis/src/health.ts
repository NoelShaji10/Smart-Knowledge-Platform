import { getRedisClient } from './client';

export async function checkRedisHealth(): Promise<{ healthy: boolean; error?: string }> {
  try {
    const client = getRedisClient();
    const res = await client.ping();
    return { healthy: res === 'PONG' };
  } catch (err: any) {
    return { healthy: false, error: err?.message || 'Redis ping failed' };
  }
}
