import { describe, it, expect, beforeEach } from 'vitest';
import { QUEUE_INDEX_DOCUMENT, QUEUE_EMBED_DOCUMENT } from './queues';
import { executeIdempotentJob, clearIdempotencyCache } from './idempotency';

describe('jobs queue constants & idempotency wrapper', () => {
  beforeEach(() => {
    clearIdempotencyCache();
  });

  it('defines correct queue names', () => {
    expect(QUEUE_INDEX_DOCUMENT).toBe('index.document');
    expect(QUEUE_EMBED_DOCUMENT).toBe('embed.document');
  });

  it('executes job handler once for duplicate idempotency keys', async () => {
    let callCount = 0;
    const handler = async () => {
      callCount++;
      return 'done';
    };

    const first = await executeIdempotentJob('key-123', handler);
    expect(first.executed).toBe(true);
    expect(first.result).toBe('done');
    expect(callCount).toBe(1);

    const second = await executeIdempotentJob('key-123', handler);
    expect(second.executed).toBe(false);
    expect(callCount).toBe(1);
  });
});
