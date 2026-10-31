import { withSystemContext } from '@knowledge/database';
import {
  decryptInvitationToken,
  buildInvitationAad,
  generateInvitationEmail,
  getEmailTransport,
  TokenCryptoError,
  SmtpDeliveryError,
} from '@knowledge/email';
import { SendInvitationEmailJobPayload } from '@knowledge/jobs';
import { logger } from '@knowledge/config';
import crypto from 'crypto';

function computeTokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Background worker handler for delivering invitation emails.
 *
 * Security & Reliability Invariants:
 * 1. Payload contains no raw tokens or encryption keys.
 * 2. Token is decrypted and verified using AES-256-GCM and bound AAD (invitationId).
 * 3. Authoritative DB checks verify invitation is pending, unexpired, and token matches current hash.
 * 4. Stale/revoked/accepted/replaced invitations are dropped without sending.
 * 5. Idempotent: duplicate jobs for already accepted_by_provider invitations are no-ops.
 * 6. Sanitized status and failure codes are recorded in database.
 * 7. Zero secret leakage in logs.
 *
 * Transaction Isolation & Delivery Semantics (AUD-T3-01 & AUD-T3-03):
 * - External SMTP network I/O is performed COMPLETELY OUTSIDE any database transaction.
 * - Processing state and attempt counter are committed in a short preliminary transaction before transport invocation.
 * - Outcome (acceptance or failure) is committed in a separate short transaction.
 * - Retryable errors are rethrown for pg-boss backoff ONLY AFTER the failure state is safely committed in PostgreSQL.
 *
 * Distributed At-Least-Once Delivery Limitation (AUD-T3-03):
 * - Standard SMTP does not support idempotency tokens.
 * - In the event of a worker crash, ungraceful termination, or network partition between external SMTP acceptance
 *   and database status persistence, pg-boss will reschedule the job upon timeout.
 * - A subsequent worker execution will observe 'processing' state and retransmit the email.
 * - Exactly-once delivery cannot be guaranteed across external SMTP boundaries.
 */
export async function handleSendInvitationEmail(
  payload: SendInvitationEmailJobPayload,
): Promise<{ delivered: boolean; reason?: string }> {
  if (!payload || !payload.invitationId || !payload.workspaceId || !payload.encryptedToken) {
    logger.error('Invalid invitation email job payload: missing required fields');
    return { delivered: false, reason: 'INVALID_PAYLOAD' };
  }

  const { invitationId, workspaceId, encryptedToken } = payload;

  // 1. Decrypt token using context-bound AAD
  let rawToken: string;
  try {
    const aad = buildInvitationAad(invitationId);
    rawToken = decryptInvitationToken(encryptedToken, undefined, {
      associatedData: aad,
    });
  } catch (err: any) {
    logger.error('Failed to decrypt invitation token for delivery', err, {
      invitationId,
      workspaceId,
      code: err?.code || 'CRYPTO_ERROR',
    });

    // Permanent cryptographic failure: mark invitation delivery permanently failed in short transaction
    await withSystemContext(async (db) => {
      await db
        .updateTable('workspace_invitations')
        .set({
          email_delivery_status: 'permanently_failed',
          email_failure_reason: 'CRYPTO_DECRYPTION_FAILED',
          email_last_attempt_at: new Date(),
          updated_at: new Date(),
        })
        .where('id', '=', invitationId)
        .execute();
    });

    return { delivered: false, reason: 'CRYPTO_DECRYPTION_FAILED' };
  }

  // 2. Transaction 1 (Preparation & Claim Lease): Authoritative check & atomic lease claim (AUD-T3-06)
  const claimId = crypto.randomUUID();
  const LEASE_DURATION_MS = 5 * 60 * 1000; // 5 minutes claim lease

  const preparation = await withSystemContext(async (db) => {
    let sel = db
      .selectFrom('workspace_invitations')
      .where('workspace_invitations.id', '=', invitationId)
      .select([
        'workspace_invitations.id',
        'workspace_invitations.workspace_id',
        'workspace_invitations.inviter_id',
        'workspace_invitations.invitee_email',
        'workspace_invitations.role',
        'workspace_invitations.status',
        'workspace_invitations.token_hash',
        'workspace_invitations.expires_at',
        'workspace_invitations.email_delivery_status',
        'workspace_invitations.email_delivery_attempts',
        'workspace_invitations.claim_id',
        'workspace_invitations.claim_expires_at',
      ]);

    if (typeof (sel as any).forUpdate === 'function') {
      sel = (sel as any).forUpdate();
    }

    const invitationRow = await sel.executeTakeFirst();

    if (!invitationRow) {
      return { shouldProceed: false, reason: 'NOT_FOUND' as const };
    }

    // Resolve workspace name and inviter display name without outer joins on FOR UPDATE
    let workspaceName = (invitationRow as any)?.workspace_name || 'Knowledge Workspace';
    let inviterName: string | null = (invitationRow as any)?.inviter_name || null;

    try {
      const ws = await db
        .selectFrom('workspaces')
        .where('id', '=', invitationRow.workspace_id)
        .select(['name'])
        .executeTakeFirst();
      if (ws?.name) {
        workspaceName = ws.name;
      }

      if (invitationRow.inviter_id) {
        const inviter = await db
          .selectFrom('users')
          .where('id', '=', invitationRow.inviter_id)
          .select(['display_name'])
          .executeTakeFirst();
        if (inviter?.display_name) {
          inviterName = inviter.display_name;
        }
      }
    } catch {
      // Fallback preserved
    }

    const invitation = {
      ...invitationRow,
      workspace_name: workspaceName,
      inviter_name: inviterName,
    };

    if (!invitation) {
      return { shouldProceed: false, reason: 'NOT_FOUND' as const };
    }

    // Idempotency: already accepted by provider
    if (invitation.email_delivery_status === 'accepted_by_provider') {
      return { shouldProceed: false, reason: 'ALREADY_ACCEPTED_BY_PROVIDER' as const };
    }

    // Revocation and business state checks
    if (invitation.status !== 'pending') {
      await db
        .updateTable('workspace_invitations')
        .set({
          email_delivery_status: 'failed',
          email_failure_reason: `INVITATION_${invitation.status.toUpperCase()}`,
          email_last_attempt_at: new Date(),
          updated_at: new Date(),
        })
        .where('id', '=', invitationId)
        .execute();

      return {
        shouldProceed: false,
        reason: `INVITATION_${invitation.status.toUpperCase()}` as const,
      };
    }

    // Expiration check
    const now = new Date();
    if (invitation.expires_at < now) {
      await db
        .updateTable('workspace_invitations')
        .set({
          status: 'expired',
          email_delivery_status: 'failed',
          email_failure_reason: 'INVITATION_EXPIRED',
          email_last_attempt_at: now,
          updated_at: now,
        })
        .where('id', '=', invitationId)
        .execute();

      return { shouldProceed: false, reason: 'INVITATION_EXPIRED' as const };
    }

    // Anti-race check: Verify that token has not been replaced/superseded by resend
    const currentTokenHash = computeTokenHash(rawToken);
    if (currentTokenHash !== invitation.token_hash) {
      await db
        .updateTable('workspace_invitations')
        .set({
          email_delivery_status: 'failed',
          email_failure_reason: 'TOKEN_SUPERSEDED',
          email_last_attempt_at: now,
          updated_at: now,
        })
        .where('id', '=', invitationId)
        .execute();

      return { shouldProceed: false, reason: 'TOKEN_SUPERSEDED' as const };
    }

    if (!invitation.invitee_email) {
      return { shouldProceed: false, reason: 'NO_RECIPIENT_EMAIL' as const };
    }

    // Lease Concurrency Check (AUD-T3-06):
    // If another worker is currently processing with an active, unexpired lease, drop duplicate job
    if (
      invitation.email_delivery_status === 'processing' &&
      invitation.claim_expires_at &&
      new Date(invitation.claim_expires_at).getTime() > now.getTime()
    ) {
      return { shouldProceed: false, reason: 'CLAIM_ACTIVE' as const };
    }

    // Increment attempt count and record processing status with explicit lease claim
    const attemptCount = (invitation.email_delivery_attempts || 0) + 1;
    const claimExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS);

    const updateResults = await db
      .updateTable('workspace_invitations')
      .set({
        email_delivery_status: 'processing',
        email_delivery_attempts: attemptCount,
        claim_id: claimId,
        claim_expires_at: claimExpiresAt,
        email_last_attempt_at: now,
        updated_at: now,
      })
      .where('id', '=', invitationId)
      .where('status', '=', 'pending')
      .where('token_hash', '=', currentTokenHash)
      .where((eb) =>
        eb.or([
          eb('email_delivery_status', 'in', ['queued', 'failed']),
          eb.and([
            eb('email_delivery_status', '=', 'processing'),
            eb.or([
              eb('claim_expires_at', 'is', null),
              eb('claim_expires_at', '<=', now),
            ]),
          ]),
        ]),
      )
      .execute();

    const numUpdated =
      updateResults && updateResults[0] && updateResults[0].numUpdatedRows !== undefined
        ? Number(updateResults[0].numUpdatedRows)
        : 1;

    if (numUpdated === 0) {
      return { shouldProceed: false, reason: 'CLAIM_CONFLICT' as const };
    }

    return {
      shouldProceed: true,
      invitation,
      attemptCount,
      claimId,
    };
  });

  // Handle terminal/skip preparation outcomes
  if (!preparation.shouldProceed) {
    if (preparation.reason === 'NOT_FOUND') {
      logger.warn('Invitation record not found for delivery job, dropping', {
        invitationId,
        workspaceId,
      });
      return { delivered: false, reason: 'NOT_FOUND' };
    }

    if (preparation.reason === 'ALREADY_ACCEPTED_BY_PROVIDER') {
      logger.info('Invitation email already accepted by provider, skipping duplicate delivery', {
        invitationId,
        workspaceId,
      });
      return { delivered: true, reason: 'ALREADY_ACCEPTED_BY_PROVIDER' };
    }

    if (preparation.reason === 'CLAIM_ACTIVE') {
      logger.info('Invitation email delivery already in progress with active lease, skipping duplicate job', {
        invitationId,
        workspaceId,
      });
      return { delivered: false, reason: 'CLAIM_ACTIVE' };
    }

    if (preparation.reason === 'CLAIM_CONFLICT') {
      logger.info('Invitation email delivery claim conflict, skipping', {
        invitationId,
        workspaceId,
      });
      return { delivered: false, reason: 'CLAIM_CONFLICT' };
    }

    if (preparation.reason === 'NO_RECIPIENT_EMAIL') {
      logger.info('Invitation is shareable without recipient email, skipping email send', {
        invitationId,
        workspaceId,
      });
      return { delivered: false, reason: 'NO_RECIPIENT_EMAIL' };
    }

    logger.info(`Invitation delivery halted during preparation (reason: ${preparation.reason})`, {
      invitationId,
      workspaceId,
    });
    return { delivered: false, reason: preparation.reason };
  }

  const { invitation, attemptCount } = preparation as {
    shouldProceed: true;
    invitation: NonNullable<typeof preparation['invitation']>;
    attemptCount: number;
    claimId: string;
  };

  // 3. Render email template OUTSIDE database transaction
  const emailMessage = generateInvitationEmail({
    recipientEmail: invitation.invitee_email!,
    workspaceName: invitation.workspace_name,
    inviterName: invitation.inviter_name || undefined,
    role: invitation.role,
    rawToken,
    expiresAt: invitation.expires_at,
  });

  // 4. Send email via configured transport OUTSIDE database transaction
  try {
    const transport = getEmailTransport();
    const result = await transport.send(emailMessage);

    if (!result.accepted) {
      throw new Error('Email transport did not accept message');
    }

    // 5. Transaction 2: Record provider acceptance conditionally on active claimId & pending status
    const updateResults = await withSystemContext(async (db) => {
      return db
        .updateTable('workspace_invitations')
        .set({
          email_delivery_status: 'accepted_by_provider',
          email_sent_at: new Date(),
          email_last_attempt_at: new Date(),
          email_failure_reason: null,
          claim_id: null,
          claim_expires_at: null,
          encrypted_token: null, // Purge ciphertext after verified acceptance
          updated_at: new Date(),
        })
        .where('id', '=', invitationId)
        .where('claim_id', '=', claimId)
        .where('status', '=', 'pending')
        .execute();
    });

    const numUpdated =
      updateResults && updateResults[0] && updateResults[0].numUpdatedRows !== undefined
        ? Number(updateResults[0].numUpdatedRows)
        : 1;

    if (numUpdated === 0) {
      logger.warn('Invitation claim superseded or invitation no longer pending; not recording success', {
        invitationId,
        workspaceId,
        claimId,
      });
      return { delivered: false, reason: 'CLAIM_SUPERSEDED' };
    }

    logger.info('Invitation email accepted by provider', {
      invitationId,
      workspaceId,
      provider: result.provider,
    });

    return { delivered: true };
  } catch (sendErr: any) {
    const isRetryable =
      sendErr instanceof SmtpDeliveryError ? sendErr.isRetryable : true;
    const originalCode =
      (sendErr instanceof SmtpDeliveryError ? sendErr.originalCode : null) ||
      sendErr?.code ||
      'SEND_ERROR';

    const isPermanent = !isRetryable || attemptCount >= 3;
    const status = isPermanent ? 'permanently_failed' : 'failed';

    // 6. Transaction 3: Persist failure outcome conditionally on active claimId BEFORE rethrowing
    const updateResults = await withSystemContext(async (db) => {
      return db
        .updateTable('workspace_invitations')
        .set({
          email_delivery_status: status,
          email_last_attempt_at: new Date(),
          email_failure_reason: String(originalCode).slice(0, 50),
          claim_id: null,
          claim_expires_at: null,
          updated_at: new Date(),
        })
        .where('id', '=', invitationId)
        .where('claim_id', '=', claimId)
        .execute();
    });

    const numUpdated =
      updateResults && updateResults[0] && updateResults[0].numUpdatedRows !== undefined
        ? Number(updateResults[0].numUpdatedRows)
        : 1;

    if (numUpdated === 0) {
      logger.warn('Invitation claim superseded before error recorded; skipping rethrow', {
        invitationId,
        workspaceId,
        claimId,
      });
      return { delivered: false, reason: 'CLAIM_SUPERSEDED' };
    }

    logger.error('Failed to deliver invitation email', sendErr, {
      invitationId,
      workspaceId,
      attemptCount,
      isRetryable,
      deliveryStatus: status,
    });

    // 7. Rethrow retryable error for pg-boss backoff ONLY AFTER failure state is committed in DB
    if (isRetryable && !isPermanent) {
      throw sendErr;
    }

    return { delivered: false, reason: String(originalCode) };
  }
}
