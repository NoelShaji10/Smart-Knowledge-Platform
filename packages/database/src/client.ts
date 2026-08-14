import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { getEnv } from '@knowledge/config';
import { Database } from './types';

const { Pool } = pg;

let poolInstance: pg.Pool | null = null;
let dbInstance: Kysely<Database> | null = null;

export function getPgPool(): pg.Pool {
  if (!poolInstance) {
    const env = getEnv();
    poolInstance = new Pool({
      connectionString: env.DATABASE_URL,
      max: 20,
    });
  }
  return poolInstance;
}

export function getDb(): Kysely<Database> {
  if (!dbInstance) {
    dbInstance = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: getPgPool(),
      }),
    });
  }
  return dbInstance;
}

export async function withUserContext<T>(
  userId: string,
  fn: (db: Kysely<Database>) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.transaction().execute(async (trx) => {
    await sql`SET LOCAL app.current_user_id = ${userId}`.execute(trx);
    return fn(trx);
  });
}
