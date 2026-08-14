import { startPgBoss } from '@knowledge/jobs';
import {
  QUEUE_INDEX_DOCUMENT,
  QUEUE_EMBED_DOCUMENT,
  QUEUE_AI_SUGGEST,
  QUEUE_PERMISSIONS_SYNC,
  QUEUE_SNAPSHOT_COMPACT,
} from '@knowledge/jobs';
import { handleIndexDocument } from './handlers/index-document';
import { handleEmbedDocument } from './handlers/embed-document';
import { handleAISuggest } from './handlers/ai-suggest';
import { handlePermissionsSync } from './handlers/permissions-sync';
import { handleSnapshotCompact } from './handlers/snapshot-compact';

export async function startWorkers() {
  const boss = await startPgBoss();

  await boss.work(QUEUE_INDEX_DOCUMENT, async (job) => {
    await handleIndexDocument(job.data as any);
  });

  await boss.work(QUEUE_EMBED_DOCUMENT, async (job) => {
    await handleEmbedDocument(job.data as any);
  });

  await boss.work(QUEUE_AI_SUGGEST, async (job) => {
    await handleAISuggest(job.data as any);
  });

  await boss.work(QUEUE_PERMISSIONS_SYNC, async (job) => {
    await handlePermissionsSync(job.data as any);
  });

  await boss.work(QUEUE_SNAPSHOT_COMPACT, async (job) => {
    await handleSnapshotCompact(job.data as any);
  });

  console.log('Background workers listening on all pg-boss queues');
  return boss;
}
