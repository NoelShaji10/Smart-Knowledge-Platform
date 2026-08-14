import { describe, it, expect } from 'vitest';
import { handleIndexDocument } from './handlers/index-document';

describe('worker handler idempotency stubs', () => {
  it('handles index.document payload idempotently', async () => {
    const payload = {
      documentId: 'doc-1',
      version: 1,
      workspaceId: 'ws-1',
    };
    await expect(handleIndexDocument(payload)).resolves.not.toThrow();
  });
});
