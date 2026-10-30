import crypto from 'crypto';
import { Kysely } from 'kysely';
import { Database, withSystemContext } from '@knowledge/database';
import { hashToken } from './tokens';

export class InvalidVerificationTokenError extends Error {
  public status = 400;
  public code = 'INVALID_VERIFICATION_TOKEN';
  constructor(message = 'Invalid verification token') {
    super(message);
    this.name = 'InvalidVerificationTokenError';
  }
}

export class ExpiredVerificationTokenError extends Error {
  public status = 410;
  public code = 'VERIFICATION_TOKEN_EXPIRED';
  constructor(message = 'Verification token has expired') {
    super(message);
    this.name = 'ExpiredVerificationTokenError';
  }
}

export class TokenAlreadyConsumedError extends Error {
  public status = 409;
  public code = 'VERIFICATION_TOKEN_CONSUMED';
  constructor(message = 'Verification token has already been used') {
    super(message);
    this.name = 'TokenAlreadyConsumedError';
  }
}

export class EmailAlreadyVerifiedError extends Error {
  public status = 400;
  public code = 'EMAIL_ALREADY_VERIFIED';
  constructor(message = 'Email address is already verified') {
    super(message);
    this.name = 'EmailAlreadyVerifiedError';
  }
}

export interface CreateChallengeOptions {
  expiresInHours?: number;
  deferInvalidation?: boolean;
}

export interface VerificationChallengeResult {
  rawToken: string;
  tokenHash: string;
  expiresAt: Date;
  userId: string;
  email: string;
  sequenceNumber?: number;
}

export interface VerifyTokenResult {
  userId: string;
  email: string;
  displayName: string;
}

/**
 * Creates a cryptographically random, single-use, time-limited email verification challenge.
 * Atomically invalidates any prior unconsumed tokens for this user to ensure single-active-token semantics.
 */
export async function createEmailVerificationChallenge(
  dbOrUserId: Kysely<Database> | string,
  userIdOrEmail?: string,
  emailOrOptions?: string | CreateChallengeOptions,
  maybeOptions?: CreateChallengeOptions,
): Promise<VerificationChallengeResult> {
  let userId: string;
  let email: string;
  let options: CreateChallengeOptions | undefined;

  if (typeof dbOrUserId === 'string') {
    userId = dbOrUserId;
    email = userIdOrEmail as string;
    options = emailOrOptions as CreateChallengeOptions | undefined;
  } else {
    userId = userIdOrEmail as string;
    email = emailOrOptions as string;
    options = maybeOptions;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);

  const expiresInHours = options?.expiresInHours ?? 24;
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

  return withSystemContext(async (sysDb) => {
    // 1. Verify user exists and retrieve current verification status
    const user = await sysDb
      .selectFrom('users')
      .where('id', '=', userId)
      .where('email', '=', normalizedEmail)
      .select(['id', 'email', 'email_verified'])
      .executeTakeFirst();

    if (!user) {
      throw new Error('User not found');
    }

    const now = new Date();

    // 2. Invalidate any existing unconsumed tokens for this user (unless deferred until delivery confirmed)
    if (!options?.deferInvalidation) {
      await sysDb
        .updateTable('email_verification_tokens')
        .set({ consumed_at: now })
        .where('user_id', '=', userId)
        .where('consumed_at', 'is', null)
        .execute();
    }

    // 3. Store new token challenge hash
    const insertRes = await sysDb
      .insertInto('email_verification_tokens')
      .values({
        user_id: userId,
        email: normalizedEmail,
        token_hash: tokenHash,
        expires_at: expiresAt,
        created_at: now,
      })
      .returning(['sequence_number'])
      .executeTakeFirst();

    return {
      rawToken,
      tokenHash,
      expiresAt,
      userId,
      email: normalizedEmail,
      sequenceNumber: insertRes?.sequence_number !== undefined ? Number(insertRes.sequence_number) : undefined,
    };
  });
}

/**
 * Verifies an email verification challenge token atomically.
 * Serializes concurrent requests using row locking, enforces expiry and single-use,
 * and sets users.email_verified = true.
 */
export async function verifyEmailToken(
  dbOrRawToken: Kysely<Database> | string,
  rawTokenParam?: string,
): Promise<VerifyTokenResult> {
  const rawToken = typeof dbOrRawToken === 'string' ? dbOrRawToken : rawTokenParam!;

  if (!rawToken || typeof rawToken !== 'string' || rawToken.trim().length < 32) {
    throw new InvalidVerificationTokenError('Invalid verification token');
  }

  const tokenHash = hashToken(rawToken.trim());

  return withSystemContext(async (sysDb) => {
    // 1. Initial non-locking lookup to identify the challenge's user_id
    const initialLookup = await sysDb
      .selectFrom('email_verification_tokens')
      .where('token_hash', '=', tokenHash)
      .select(['user_id'])
      .executeTakeFirst();

    if (!initialLookup) {
      throw new InvalidVerificationTokenError('Invalid or unrecognised verification token');
    }

    // 2. Canonical lock ordering: acquire user-level row lock FIRST to serialize with delivery finalization
    let userQuery = sysDb
      .selectFrom('users')
      .where('id', '=', initialLookup.user_id)
      .select(['id', 'email', 'display_name']);

    if (typeof (userQuery as any).forUpdate === 'function') {
      userQuery = (userQuery as any).forUpdate();
    }
    const lockedUser = await userQuery.executeTakeFirst();

    if (!lockedUser) {
      throw new InvalidVerificationTokenError('User associated with verification token not found');
    }

    // 3. Within the serialized user context, re-read and lock the authoritative challenge row.
    // Do NOT rely on stale data from the initial lookup.
    let tokenQuery = sysDb
      .selectFrom('email_verification_tokens')
      .where('token_hash', '=', tokenHash)
      .where('user_id', '=', lockedUser.id)
      .selectAll();

    if (typeof (tokenQuery as any).forUpdate === 'function') {
      tokenQuery = (tokenQuery as any).forUpdate();
    }
    const tokenRow = await tokenQuery.executeTakeFirst();

    if (!tokenRow) {
      throw new InvalidVerificationTokenError('Invalid or unrecognised verification token');
    }

    if (tokenRow.consumed_at !== null) {
      throw new TokenAlreadyConsumedError('Verification token has already been used');
    }

    const now = new Date();
    if (new Date(tokenRow.expires_at) < now) {
      throw new ExpiredVerificationTokenError('Verification token has expired');
    }

    // Ensure email binding matches current authoritative user email
    if (lockedUser.email.trim().toLowerCase() !== tokenRow.email.trim().toLowerCase()) {
      throw new InvalidVerificationTokenError('User associated with verification token not found');
    }

    // 4. Mark this token consumed
    await sysDb
      .updateTable('email_verification_tokens')
      .set({ consumed_at: now })
      .where('id', '=', tokenRow.id)
      .execute();

    // 5. Invalidate any sibling unconsumed tokens for this user
    await sysDb
      .updateTable('email_verification_tokens')
      .set({ consumed_at: now })
      .where('user_id', '=', lockedUser.id)
      .where('consumed_at', 'is', null)
      .execute();

    // 6. Update user account to email_verified = true
    const updatedUser = await sysDb
      .updateTable('users')
      .set({
        email_verified: true,
        updated_at: now,
      })
      .where('id', '=', lockedUser.id)
      .where('email', '=', tokenRow.email)
      .returning(['id', 'email', 'display_name'])
      .executeTakeFirst();

    if (!updatedUser) {
      throw new InvalidVerificationTokenError('User associated with verification token not found');
    }

    return {
      userId: updatedUser.id,
      email: updatedUser.email,
      displayName: updatedUser.display_name,
    };
  });
}

export interface RequestChallengeResult {
  ok: boolean;
  alreadyVerified?: boolean;
  challenge?: VerificationChallengeResult;
  user?: {
    id: string;
    email: string;
    displayName: string;
  };
}

/**
 * Handles an email verification challenge request by locating the account safely
 * and creating a challenge without exposing account enumeration vectors.
 */
export async function requestEmailVerificationChallenge(
  identifier: { userId?: string | null; email?: string },
  options?: CreateChallengeOptions,
): Promise<RequestChallengeResult> {
  const userRow = await withSystemContext(async (sysDb) => {
    let q = sysDb.selectFrom('users').select(['id', 'email', 'display_name', 'email_verified']);
    if (identifier.userId) {
      q = q.where('id', '=', identifier.userId);
    } else if (identifier.email) {
      q = q.where('email', '=', identifier.email.trim().toLowerCase());
    } else {
      return undefined;
    }

    return q.executeTakeFirst();
  });

  if (!userRow) {
    // Prevent email enumeration: return generic ok without challenge
    return { ok: true, alreadyVerified: false };
  }

  if (userRow.email_verified) {
    return { ok: true, alreadyVerified: true };
  }

  const challenge = await createEmailVerificationChallenge(userRow.id, userRow.email, options);

  return {
    ok: true,
    alreadyVerified: false,
    challenge,
    user: {
      id: userRow.id,
      email: userRow.email,
      displayName: userRow.display_name,
    },
  };
}

/**
 * Safely removes an undelivered verification challenge so it does not
 * linger in the database or block user recovery.
 * Uses exact token_hash matching to prevent corrupting challenges created
 * by concurrent requests.
 */
export async function cleanupFailedVerificationChallenge(tokenHash: string): Promise<void> {
  if (!tokenHash) return;
  await withSystemContext(async (sysDb) => {
    await sysDb
      .deleteFrom('email_verification_tokens')
      .where('token_hash', '=', tokenHash)
      .where('consumed_at', 'is', null)
      .execute();
  });
}

/**
 * Finalizes successful delivery of an email verification challenge by atomically
 * invalidating any older unconsumed challenges for this user.
 *
 * Concurrency & Ordering Guarantees:
 * 1. User-level row lock: Acquires `SELECT id FROM users WHERE id = userId FOR UPDATE`.
 *    This strictly serializes finalization transactions for the same user, preventing
 *    interleaved execution or concurrent race conditions.
 * 2. Monotonic sequence ordering: Every challenge has a monotonic `sequence_number`.
 *    Invalidation strictly targets challenges where `sequence_number < currentSeq`.
 *    An older challenge can NEVER invalidate a newer challenge, even when timestamps tie
 *    or transactions commit out of order.
 * 3. Superseded challenge guard: If the active challenge has already been consumed or superseded
 *    (`consumed_at IS NOT NULL`), finalization safely no-ops.
 */
export async function finalizeVerificationChallengeDelivery(
  userId: string,
  activeTokenHash: string,
): Promise<void> {
  if (!userId || !activeTokenHash) return;
  const now = new Date();
  await withSystemContext(async (sysDb) => {
    // 1. Acquire user-level row lock to strictly serialize finalization transactions for this user.
    let userQuery = sysDb
      .selectFrom('users')
      .where('id', '=', userId)
      .select(['id']);

    if (typeof (userQuery as any).forUpdate === 'function') {
      userQuery = (userQuery as any).forUpdate();
    }
    const lockedUser = await userQuery.executeTakeFirst();
    if (!lockedUser) return;

    // 2. Fetch the challenge being finalized within the serialized user context.
    const activeToken = await sysDb
      .selectFrom('email_verification_tokens')
      .where('token_hash', '=', activeTokenHash)
      .where('user_id', '=', userId)
      .select(['id', 'sequence_number', 'consumed_at'])
      .executeTakeFirst();

    // 3. If the challenge does not exist or has already been consumed/superseded,
    // safely no-op to prevent invalidating newer challenges.
    if (!activeToken || activeToken.consumed_at !== null) {
      return;
    }

    const currentSeq = Number(activeToken.sequence_number);

    // 4. Invalidate only older unconsumed sibling challenges.
    // We order strictly by sequence_number, guaranteeing that an older challenge
    // can NEVER invalidate a newer challenge even if timestamps tie or transactions overlap!
    await sysDb
      .updateTable('email_verification_tokens')
      .set({ consumed_at: now })
      .where('user_id', '=', userId)
      .where('token_hash', '!=', activeTokenHash)
      .where('sequence_number', '<', currentSeq)
      .where('consumed_at', 'is', null)
      .execute();
  });
}
