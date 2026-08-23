import crypto from 'crypto';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Kysely, sql } from 'kysely';
import { getEnv } from '@knowledge/config';
import { Database, withSystemContext } from '@knowledge/database';

export class TokenReuseError extends Error {
  constructor(message = 'Refresh token reuse detected') {
    super(message);
    this.name = 'TokenReuseError';
  }
}

export interface WorkspaceClaim {
  id: string;
  role: string;
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function issueAccessToken(
  user: { id: string; email: string },
  workspaces: WorkspaceClaim[] = [],
): string {
  const env = getEnv();
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      workspaces,
    },
    env.JWT_SECRET,
    {
      expiresIn: env.JWT_ACCESS_EXPIRY as jwt.SignOptions['expiresIn'],
    },
  );
}

export function verifyAccessToken(token: string): JwtPayload {
  const env = getEnv();
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
}

export async function issueRefreshToken(
  db: Kysely<Database>,
  userId: string,
  existingFamilyId?: string,
): Promise<{ rawToken: string; familyId: string; expiresAt: Date }> {
  const env = getEnv();
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const familyId = existingFamilyId || crypto.randomUUID();

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + env.JWT_REFRESH_EXPIRY_DAYS);

  await withSystemContext(async (sysDb) => {
    await sysDb
      .insertInto('refresh_tokens')
      .values({
        user_id: userId,
        family_id: familyId,
        token_hash: tokenHash,
        expires_at: expiresAt,
      })
      .execute();
  });

  return { rawToken, familyId, expiresAt };
}

export async function rotateRefreshToken(
  dbOrToken: Kysely<Database> | string,
  oldRawToken?: string,
): Promise<{ accessToken: string; rawRefreshToken: string; expiresAt: Date }> {
  const tokenToUse = typeof dbOrToken === 'string' ? dbOrToken : oldRawToken!;
  const oldHash = hashToken(tokenToUse);

  const res = await withSystemContext(async (systemDb) => {
    // 1. SELECT ... FOR UPDATE to lock the token row
    const tokenRow = await systemDb
      .selectFrom('refresh_tokens')
      .where('token_hash', '=', oldHash)
      .selectAll()
      .forUpdate()
      .executeTakeFirst();

    if (!tokenRow) {
      return { error: new Error('Invalid refresh token') };
    }

    // 2. Reuse detection: if revoked_at IS NOT NULL, revoke entire family!
    if (tokenRow.revoked_at !== null) {
      await systemDb
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date() })
        .where('family_id', '=', tokenRow.family_id)
        .execute();

      return { reuse: true };
    }

    // 3. Expiration check
    if (new Date(tokenRow.expires_at) < new Date()) {
      return { error: new Error('Expired refresh token') };
    }

    // 4. Revoke current token
    const now = new Date();
    await systemDb
      .updateTable('refresh_tokens')
      .set({ revoked_at: now })
      .where('id', '=', tokenRow.id)
      .execute();

    // 5. Fetch user & workspaces for new access token
    const user = await systemDb
      .selectFrom('users')
      .where('id', '=', tokenRow.user_id)
      .select(['id', 'email'])
      .executeTakeFirst();

    if (!user) {
      return { error: new Error('User not found') };
    }

    const memberships = await systemDb
      .selectFrom('workspace_members')
      .where('user_id', '=', user.id)
      .select(['workspace_id as id', 'role'])
      .execute();

    // 6. Issue replacement token with same family_id
    const env = getEnv();
    const rawToken = crypto.randomBytes(32).toString('hex');
    const newHash = hashToken(rawToken);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + env.JWT_REFRESH_EXPIRY_DAYS);

    await systemDb
      .insertInto('refresh_tokens')
      .values({
        user_id: user.id,
        family_id: tokenRow.family_id,
        token_hash: newHash,
        expires_at: expiresAt,
      })
      .execute();

    const accessToken = issueAccessToken(user, memberships);

    return {
      accessToken,
      rawRefreshToken: rawToken,
      expiresAt,
    };
  });

  if ('reuse' in res) {
    throw new TokenReuseError();
  }
  if ('error' in res) {
    throw res.error;
  }
  return res;
}

export async function revokeTokenFamily(dbOrFamilyId: Kysely<Database> | string, familyId?: string): Promise<void> {
  const targetFamilyId = typeof dbOrFamilyId === 'string' ? dbOrFamilyId : familyId!;
  return withSystemContext(async (systemDb) => {
    await systemDb
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('family_id', '=', targetFamilyId)
      .where('revoked_at', 'is', null)
      .execute();
  });
}

export async function revokeAllUserTokens(dbOrUserId: Kysely<Database> | string, userId?: string): Promise<void> {
  const targetUserId = typeof dbOrUserId === 'string' ? dbOrUserId : userId!;
  return withSystemContext(async (systemDb) => {
    await systemDb
      .updateTable('refresh_tokens')
      .set({ revoked_at: new Date() })
      .where('user_id', '=', targetUserId)
      .where('revoked_at', 'is', null)
      .execute();
  });
}

export async function revokeRefreshTokenByRaw(
  dbOrToken: Kysely<Database> | string,
  rawToken?: string,
): Promise<{ userId: string; familyId: string } | null> {
  const tokenToUse = typeof dbOrToken === 'string' ? dbOrToken : rawToken!;
  const tokenHash = hashToken(tokenToUse);

  return withSystemContext(async (systemDb) => {
    const tokenRow = await systemDb
      .selectFrom('refresh_tokens')
      .where('token_hash', '=', tokenHash)
      .select(['id', 'user_id', 'family_id', 'revoked_at'])
      .executeTakeFirst();

    if (!tokenRow) return null;

    if (tokenRow.revoked_at === null) {
      await revokeTokenFamily(systemDb, tokenRow.family_id);
    }

    return { userId: tokenRow.user_id, familyId: tokenRow.family_id };
  });
}
