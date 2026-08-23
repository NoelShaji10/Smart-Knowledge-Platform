import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { getEnv } from '@knowledge/config';
import { Database } from './types';

const { Pool } = pg;

let poolInstance: pg.Pool | null = null;
let migrationPoolInstance: pg.Pool | null = null;
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

export function getMigrationPgPool(): pg.Pool {
  if (!migrationPoolInstance) {
    const env = getEnv();
    migrationPoolInstance = new Pool({
      connectionString: env.MIGRATION_DATABASE_URL || env.DATABASE_URL,
      max: 5,
    });
  }
  return migrationPoolInstance;
}

export function getSystemDb(): Kysely<Database> {
  if (!dbInstance) {
    dbInstance = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: getPgPool(),
      }),
    });
  }
  return dbInstance;
}

/**
 * @deprecated Use getSystemDb() for explicit system access, or req.db for authenticated request-scoped access.
 */
export function getDb(): Kysely<Database> {
  return getSystemDb();
}

export async function withUserContext<T>(
  userId: string,
  fn: (db: Kysely<Database>) => Promise<T>,
): Promise<T> {
  const db = getDb();
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.current_user_id', ${userId}, true)`.execute(trx);
    return fn(trx);
  });
}

export async function withSystemContext<T>(
  fn: (db: Kysely<Database>) => Promise<T>,
): Promise<T> {
  const db = getSystemDb();
  return db.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.is_system', 'true', true)`.execute(trx);
    return fn(trx);
  });
}
