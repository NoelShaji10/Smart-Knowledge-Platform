import { Kysely } from 'kysely';
import { Database, withSystemContext } from '@knowledge/database';
import { hashPassword } from './password';

export interface RegisterParams {
  email: string;
  password: string;
  displayName: string;
}

export async function registerUser(dbOrParams: Kysely<Database> | RegisterParams, params?: RegisterParams) {
  const actualParams: RegisterParams = params ? params : (dbOrParams as RegisterParams);
  const email = actualParams.email.trim().toLowerCase();
  const displayName = actualParams.displayName.trim();

  if (!email || !email.includes('@')) {
    throw new Error('Invalid email address');
  }

  if (!actualParams.password || actualParams.password.length < 8) {
    throw new Error('Password must be at least 8 characters long');
  }

  if (!displayName) {
    throw new Error('Display name is required');
  }

  return withSystemContext(async (db) => {
    // Check email uniqueness
    const existing = await db
      .selectFrom('users')
      .where('email', '=', email)
      .select(['id'])
      .executeTakeFirst();

    if (existing) {
      // Also run password hash on duplicate registration to equalize CPU timing (MEDIUM 6)
      await hashPassword(actualParams.password);
      throw new Error('Registration failed');
    }

    const passwordHash = await hashPassword(actualParams.password);
    const userId = crypto.randomUUID();

    const user = await db
      .insertInto('users')
      .values({
        id: userId,
        email,
        display_name: displayName,
        auth_provider: 'local',
        auth_subject: userId,
        password_hash: passwordHash,
      })
      .returning(['id', 'email', 'display_name', 'created_at'])
      .executeTakeFirstOrThrow();

    return user;
  });
}
