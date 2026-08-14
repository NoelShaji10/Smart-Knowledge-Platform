import { sql } from 'kysely';
import { getDb } from './client';

export async function checkDatabaseHealth(): Promise<{ healthy: boolean; error?: string }> {
  try {
    const db = getDb();
    await sql`SELECT 1`.execute(db);
    return { healthy: true };
  } catch (err: any) {
    return { healthy: false, error: err?.message || 'Database ping failed' };
  }
}
