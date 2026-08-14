import { executeIdempotentJob } from '@knowledge/jobs';

export interface IndexDocumentJobPayload {
  documentId: string;
  version: number;
  workspaceId: string;
}

export async function handleIndexDocument(payload: IndexDocumentJobPayload): Promise<void> {
  const idempotencyKey = `index.document:${payload.documentId}:${payload.version}`;
  await executeIdempotentJob(idempotencyKey, async () => {
    // Phase 0 handler stub
    return { indexed: true };
  });
}
