import PgBoss from 'pg-boss';
import { getEnv } from '@knowledge/config';

let bossInstance: PgBoss | null = null;

export function getPgBoss(): PgBoss {
  if (!bossInstance) {
    const env = getEnv();
    bossInstance = new PgBoss({
      connectionString: env.DATABASE_URL,
    });
  }
  return bossInstance;
}

export async function startPgBoss(): Promise<PgBoss> {
  const boss = getPgBoss();
  await boss.start();
  return boss;
}

export async function stopPgBoss(): Promise<void> {
  if (bossInstance) {
    await bossInstance.stop();
    bossInstance = null;
  }
}
