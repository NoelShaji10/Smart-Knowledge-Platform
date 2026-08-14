import { executeIdempotentJob } from '@knowledge/jobs';

export interface AISuggestJobPayload {
  documentId: string;
  version: number;
  type: string;
  userId: string | null;
  promptHash: string;
}

export async function handleAISuggest(payload: AISuggestJobPayload): Promise<void> {
  const idempotencyKey = `ai.suggest:${payload.documentId}:${payload.version}:${payload.type}:${payload.promptHash}`;
  await executeIdempotentJob(idempotencyKey, async () => {
    // Phase 0 handler stub
    return { suggested: true };
  });
}
