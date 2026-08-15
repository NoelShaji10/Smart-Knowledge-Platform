import { Kysely, Transaction } from 'kysely';
import { Database } from './types';
import { withUserContext } from './client';

export interface ScopedDb {
  /**
   * Execute a callback within a transaction that has
   * SET LOCAL app.current_user_id = '<userId>'.
   * This is the default way to query the database from an authenticated route handler.
   * RLS policies are enforced for every query inside the callback.
   */
  execute<T>(fn: (db: Kysely<Database> | Transaction<Database>) => Promise<T>): Promise<T>;

  /** The user ID this scoped DB is bound to. */
  readonly userId: string;
}

export function createScopedDb(userId: string): ScopedDb {
  return {
    userId,
    execute: <T>(fn: (db: Kysely<Database> | Transaction<Database>) => Promise<T>): Promise<T> => {
      return withUserContext(userId, fn);
    },
  };
}
