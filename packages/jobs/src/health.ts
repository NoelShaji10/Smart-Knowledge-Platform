import { getPgBoss } from './boss';

export async function checkJobsHealth(): Promise<{ healthy: boolean; error?: string }> {
  try {
    const boss = getPgBoss();
    return { healthy: boss !== null };
  } catch (err: any) {
    return { healthy: false, error: err?.message || 'pg-boss check failed' };
  }
}
