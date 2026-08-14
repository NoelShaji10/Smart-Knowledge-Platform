import { describe, it, expect } from 'vitest';
import { BUCKET_SNAPSHOTS, BUCKET_VERSIONS } from './client';

describe('storage constants', () => {
  it('defines snapshots and versions bucket names', () => {
    expect(BUCKET_SNAPSHOTS).toBe('snapshots');
    expect(BUCKET_VERSIONS).toBe('versions');
  });
});
