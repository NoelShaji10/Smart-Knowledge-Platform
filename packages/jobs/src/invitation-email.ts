import PgBoss from 'pg-boss';
import { QUEUE_SEND_INVITATION_EMAIL } from './queues';
import { EncryptedPayload } from '@knowledge/email';

export interface SendInvitationEmailJobPayload {
  invitationId: string;
  workspaceId: string;
  encryptedToken: EncryptedPayload;
  keyId?: string;
}

export interface EnqueueInvitationEmailOptions {
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  expireInSeconds?: number;
}

/**
 * Enqueues an asynchronous invitation email delivery job into pg-boss.
 * The payload contains ONLY non-secret metadata and the authenticated encrypted token envelope.
 * Uses singletonKey by invitationId to prevent duplicate concurrent delivery jobs.
 */
export async function enqueueInvitationEmailJob(
  boss: PgBoss,
  payload: SendInvitationEmailJobPayload,
  options?: EnqueueInvitationEmailOptions,
): Promise<string | null> {
  if (!payload || !payload.invitationId || !payload.workspaceId || !payload.encryptedToken) {
    throw new Error('Invalid invitation email job payload: missing required fields');
  }

  const jobId = await boss.send(
    QUEUE_SEND_INVITATION_EMAIL,
    payload,
    {
      retryLimit: options?.retryLimit ?? 3,
      retryDelay: options?.retryDelay ?? 30,
      retryBackoff: options?.retryBackoff ?? true,
      expireInSeconds: options?.expireInSeconds ?? 300,
      singletonKey: payload.invitationId,
    },
  );

  return jobId;
}
