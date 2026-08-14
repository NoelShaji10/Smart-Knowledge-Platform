import { executeIdempotentJob } from '@knowledge/jobs';

export interface EmbedDocumentJobPayload {
  documentId: string;
  version: number;
  chunks: Array<{ index: number; text: string; hash: string }>;
}

export async function handleEmbedDocument(payload: EmbedDocumentJobPayload): Promise<void> {
  for (const chunk of payload.chunks) {
    const idempotencyKey = `embed.document:${payload.documentId}:${chunk.index}:${chunk.hash}`;
    await executeIdempotentJob(idempotencyKey, async () => {
      // Phase 0 handler stub
      return { embedded: true };
    });
  }
}
