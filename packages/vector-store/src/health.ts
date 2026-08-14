import { getQdrantClient } from './client';

export async function checkQdrantHealth(): Promise<{ healthy: boolean; error?: string }> {
  try {
    const client = getQdrantClient();
    await client.getCollections();
    return { healthy: true };
  } catch (err: any) {
    return { healthy: false, error: err?.message || 'Qdrant ping failed' };
  }
}
