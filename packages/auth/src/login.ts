import { Kysely } from 'kysely';
import { Database, withSystemContext } from '@knowledge/database';
import { verifyPassword, DUMMY_HASH } from './password';
import { issueAccessToken, issueRefreshToken } from './tokens';

export interface LoginParams {
  email: string;
  password: string;
}

export async function loginUser(dbOrParams: Kysely<Database> | LoginParams, params?: LoginParams) {
  const actualParams: LoginParams = params ? params : (dbOrParams as LoginParams);
  const email = actualParams.email.trim().toLowerCase();

  return withSystemContext(async (db) => {
    const user = await db
      .selectFrom('users')
      .where('email', '=', email)
      .selectAll()
      .executeTakeFirst();

    if (!user || !user.password_hash) {
      // Constant-time timing attack mitigation
      await verifyPassword(actualParams.password, DUMMY_HASH);
      throw new Error('Invalid email or password');
    }

    const valid = await verifyPassword(actualParams.password, user.password_hash);
    if (!valid) {
      throw new Error('Invalid email or password');
    }

    const memberships = await db
      .selectFrom('workspace_members')
      .where('user_id', '=', user.id)
      .select(['workspace_id as id', 'role'])
      .execute();

    const accessToken = issueAccessToken(
      { id: user.id, email: user.email },
      memberships,
    );

    const refreshTokenData = await issueRefreshToken(db, user.id);

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        workspaces: memberships,
      },
      accessToken,
      rawRefreshToken: refreshTokenData.rawToken,
      refreshExpiresAt: refreshTokenData.expiresAt,
    };
  });
}
