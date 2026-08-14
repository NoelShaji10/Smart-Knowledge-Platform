import { describe, it, expect } from 'vitest';
import { GET } from './api/health/route';

describe('Next.js web health API route', () => {
  it('returns healthy status JSON response', async () => {
    const res = await GET();
    const data = await res.json();
    expect(data.status).toBe('healthy');
    expect(data.app).toBe('web');
  });
});
