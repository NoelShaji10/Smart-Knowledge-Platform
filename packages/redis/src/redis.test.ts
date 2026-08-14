import { describe, it, expect } from 'vitest';
import { getDocChannel } from './pubsub';

describe('redis pubsub channel helpers', () => {
  it('formats document channel names correctly', () => {
    expect(getDocChannel('doc-123')).toBe('doc:doc-123');
  });
});
