import { withSystemContext } from '@knowledge/database';
import { enqueueInvitationEmailJob, PgBoss } from '@knowledge/jobs';
import { logger } from '@knowledge/config';

export interface ReconcilePendingInvitationsOptions {
  batchSize?: number;
  staleThresholdMs?: number; // default: 30000ms (30 seconds)
}

export interface ReconcileResult {
  discovered: number;
  enqueued: number;
  skipped: number;
  expired: number;
  failed: number;
}

/**
 * Reconciles stranded 'queued' invitations that were committed to the database
 * but never received a pg-boss delivery job due to an API server process crash
 * or unexpected termination between database commit and queue enqueue (AUD-T3-05).
 *
 * Guarantees:
 * 1. Safe & observable discovery using the partial index `idx_workspace_invitations_reconcile`.
 * 2. Deduplication: uses pg-boss singletonKey to prevent duplicate jobs.
 * 3. Token security: reconstructs job payloads from authenticated AES-256-GCM encrypted_token;
 *    never stores or requires plaintext tokens.
 * 4. Stale/expired/revoked invitations are transitioned or skipped instead of re-enqueued.
 * 5. Strictly idempotent and safe across repeated runs.
 */
export async function reconcilePendingInvitationEmails(
  boss: PgBoss,
  options?: ReconcilePendingInvitationsOptions,
): Promise<ReconcileResult> {
  const staleThresholdMs = options?.staleThresholdMs ?? 30000;
  const batchSize = options?.batchSize ?? 50;
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - staleThresholdMs);

  const result: ReconcileResult = {
    discovered: 0,
    enqueued: 0,
    skipped: 0,
    expired: 0,
    failed: 0,
  };

  // 1. Query stranded queued invitations using system context
  const candidates = await withSystemContext(async (db) => {
    return db
      .selectFrom('workspace_invitations')
      .where('email_delivery_status', '=', 'queued')
      .where('email_queued_at', '<=', staleThreshold)
      .where('encrypted_token', 'is not', null)
      .select([
        'id',
        'workspace_id',
        'invitee_email',
        'status',
        'expires_at',
        'token_hash',
        'encrypted_token',
        'email_delivery_status',
        'email_delivery_attempts',
      ])
      .orderBy('email_queued_at', 'asc')
      .limit(batchSize)
      .execute();
  });

  result.discovered = candidates.length;
  if (candidates.length === 0) {
    return result;
  }

  logger.info(`Discovered ${candidates.length} potentially stranded queued invitations for delivery reconciliation`, {
    staleThresholdMs,
  });

  for (const invitation of candidates) {
    // 2. State validation: check for revoked or already accepted
    if (invitation.status !== 'pending') {
      logger.info('Skipping reconciliation for invitation that is no longer pending', {
        invitationId: invitation.id,
        invitationStatus: invitation.status,
      });
      result.skipped++;
      continue;
    }

    // 3. Expiration validation
    if (invitation.expires_at <= now) {
      logger.info('Invitation expired while queued; marking expired during reconciliation', {
        invitationId: invitation.id,
      });
      await withSystemContext(async (db) => {
        await db
          .updateTable('workspace_invitations')
          .set({
            status: 'expired',
            email_delivery_status: 'failed',
            email_failure_reason: 'INVITATION_EXPIRED',
            email_last_attempt_at: now,
            updated_at: now,
          })
          .where('id', '=', invitation.id)
          .where('status', '=', 'pending')
          .execute();
      });
      result.expired++;
      continue;
    }

    // 4. Reconstruct authenticated encrypted token envelope
    let encryptedToken: any;
    try {
      encryptedToken =
        typeof invitation.encrypted_token === 'string'
          ? JSON.parse(invitation.encrypted_token)
          : invitation.encrypted_token;

      if (!encryptedToken || !encryptedToken.ciphertext || !encryptedToken.iv || !encryptedToken.tag) {
        throw new Error('Encrypted token envelope is missing required cryptographic fields');
      }
    } catch (parseErr: any) {
      logger.error('Failed to parse encrypted token envelope during reconciliation', parseErr, {
        invitationId: invitation.id,
      });
      await withSystemContext(async (db) => {
        await db
          .updateTable('workspace_invitations')
          .set({
            email_delivery_status: 'permanently_failed',
            email_failure_reason: 'CORRUPT_ENCRYPTED_PAYLOAD',
            email_last_attempt_at: now,
            updated_at: now,
          })
          .where('id', '=', invitation.id)
          .execute();
      });
      result.failed++;
      continue;
    }

    // 5. Enqueue delivery job with pg-boss using singletonKey deduplication
    try {
      const jobId = await enqueueInvitationEmailJob(boss, {
        invitationId: invitation.id,
        workspaceId: invitation.workspace_id,
        encryptedToken,
        keyId: encryptedToken.keyId,
      });

      if (jobId) {
        logger.info('Successfully recovered and enqueued stranded invitation email job', {
          invitationId: invitation.id,
          jobId,
        });
        result.enqueued++;
      } else {
        // pg-boss singleton deduplication: active job already exists
        logger.info('Invitation delivery job already active in pg-boss; deduplicated', {
          invitationId: invitation.id,
        });
        result.skipped++;
      }
    } catch (enqueueErr: any) {
      logger.error('Failed to re-enqueue stranded invitation delivery job during reconciliation', enqueueErr, {
        invitationId: invitation.id,
      });
      result.failed++;
    }
  }

  return result;
}
