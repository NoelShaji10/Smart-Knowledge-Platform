import { startPgBoss } from '@knowledge/jobs';
import {
  QUEUE_INDEX_DOCUMENT,
  QUEUE_EMBED_DOCUMENT,
  QUEUE_AI_SUGGEST,
  QUEUE_PERMISSIONS_SYNC,
  QUEUE_SNAPSHOT_COMPACT,
  QUEUE_SEND_INVITATION_EMAIL,
  QUEUE_RECONCILE_INVITATIONS,
} from '@knowledge/jobs';
import { logger } from '@knowledge/config';
import { handleIndexDocument } from './handlers/index-document';
import { handleEmbedDocument } from './handlers/embed-document';
import { handleAISuggest } from './handlers/ai-suggest';
import { handlePermissionsSync } from './handlers/permissions-sync';
import { handleSnapshotCompact } from './handlers/snapshot-compact';
import { handleSendInvitationEmail } from './handlers/send-invitation-email';
import { reconcilePendingInvitationEmails } from './handlers/reconcile-invitations';

export async function processWorkerJob(
  queue: string,
  job: { id?: string; data: any },
  handler: (data: any) => Promise<any>,
): Promise<void> {
  const documentId = job?.data?.documentId;
  const workspaceId = job?.data?.workspaceId;
  const invitationId = job?.data?.invitationId;

  try {
    await handler(job?.data);
  } catch (err: any) {
    logger.error(`Worker job execution failed on queue "${queue}"`, err, {
      queue,
      jobId: job?.id,
      documentId,
      workspaceId,
      invitationId,
    });
    // Rethrow to allow pg-boss to handle retry / terminal failure tracking
    throw err;
  }
}

export async function startWorkers() {
  const boss = await startPgBoss();

  await boss.work(QUEUE_INDEX_DOCUMENT, async (job) => {
    await processWorkerJob(QUEUE_INDEX_DOCUMENT, job, handleIndexDocument);
  });

  await boss.work(QUEUE_EMBED_DOCUMENT, async (job) => {
    await processWorkerJob(QUEUE_EMBED_DOCUMENT, job, handleEmbedDocument);
  });

  await boss.work(QUEUE_AI_SUGGEST, async (job) => {
    await processWorkerJob(QUEUE_AI_SUGGEST, job, handleAISuggest);
  });

  await boss.work(QUEUE_PERMISSIONS_SYNC, async (job) => {
    await processWorkerJob(QUEUE_PERMISSIONS_SYNC, job, handlePermissionsSync);
  });

  await boss.work(QUEUE_SNAPSHOT_COMPACT, async (job) => {
    await processWorkerJob(QUEUE_SNAPSHOT_COMPACT, job, handleSnapshotCompact);
  });

  await boss.work(QUEUE_SEND_INVITATION_EMAIL, async (job) => {
    await processWorkerJob(QUEUE_SEND_INVITATION_EMAIL, job, handleSendInvitationEmail);
  });

  await boss.work(QUEUE_RECONCILE_INVITATIONS, async (job) => {
    await processWorkerJob(QUEUE_RECONCILE_INVITATIONS, job, async () => {
      await reconcilePendingInvitationEmails(boss);
    });
  });

  if (typeof (boss as any).schedule === 'function') {
    try {
      await (boss as any).schedule(QUEUE_RECONCILE_INVITATIONS, '* * * * *', {});
    } catch (schedErr) {
      logger.warn('Failed to register recurring invitation reconciliation schedule', {
        error: String(schedErr),
      });
    }
  }

  logger.info('Background workers listening on all pg-boss queues');
  return boss;
}

export { reconcilePendingInvitationEmails };

