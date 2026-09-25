import { startPgBoss } from '@knowledge/jobs';
import {
  QUEUE_INDEX_DOCUMENT,
  QUEUE_EMBED_DOCUMENT,
  QUEUE_AI_SUGGEST,
  QUEUE_PERMISSIONS_SYNC,
  QUEUE_SNAPSHOT_COMPACT,
} from '@knowledge/jobs';
import { logger } from '@knowledge/config';
import { handleIndexDocument } from './handlers/index-document';
import { handleEmbedDocument } from './handlers/embed-document';
import { handleAISuggest } from './handlers/ai-suggest';
import { handlePermissionsSync } from './handlers/permissions-sync';
import { handleSnapshotCompact } from './handlers/snapshot-compact';

export async function processWorkerJob(
  queue: string,
  job: { id?: string; data: any },
  handler: (data: any) => Promise<any>,
): Promise<void> {
  const documentId = job?.data?.documentId;
  const workspaceId = job?.data?.workspaceId;

  try {
    await handler(job?.data);
  } catch (err: any) {
    logger.error(`Worker job execution failed on queue "${queue}"`, err, {
      queue,
      jobId: job?.id,
      documentId,
      workspaceId,
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

  logger.info('Background workers listening on all pg-boss queues');
  return boss;
}
