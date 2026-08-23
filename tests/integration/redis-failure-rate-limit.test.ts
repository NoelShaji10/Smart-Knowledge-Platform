import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { issueAccessToken } from '@knowledge/auth';
import * as redisModule from '@knowledge/redis';

describe('MEDIUM 5: Auth Rate Limiting Fail-Closed on Redis Failure', () => {
  const app = createApiApp();
  const dummyToken = issueAccessToken({ id: '00000000-0000-0000-0000-000000000001', email: 'test@example.com' });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 503 Rate limiter unavailable when Redis throws error on register', async () => {
    vi.spyOn(redisModule, 'getRedisClient').mockReturnValueOnce({
      incr: vi.fn().mockRejectedValue(new Error('Redis connection lost')),
    } as any);

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'test@example.com', password: 'Password123!', displayName: 'Test' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Rate limiter unavailable');
  });

  it('returns 503 Rate limiter unavailable when Redis throws error on login', async () => {
    vi.spyOn(redisModule, 'getRedisClient').mockReturnValueOnce({
      incr: vi.fn().mockRejectedValue(new Error('Redis connection lost')),
    } as any);

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'test@example.com', password: 'Password123!' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Rate limiter unavailable');
  });

  it('returns 503 Rate limiter unavailable when Redis throws error on refresh', async () => {
    vi.spyOn(redisModule, 'getRedisClient').mockReturnValueOnce({
      incr: vi.fn().mockRejectedValue(new Error('Redis connection lost')),
    } as any);

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', ['refreshToken=dummy']);

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Rate limiter unavailable');
  });

  it('returns 503 Rate limiter unavailable when Redis throws error on ws ticket issuance', async () => {
    vi.spyOn(redisModule, 'getRedisClient').mockReturnValueOnce({
      incr: vi.fn().mockRejectedValue(new Error('Redis connection lost')),
    } as any);

    const res = await request(app)
      .post('/api/v1/ws/ticket')
      .set('Authorization', `Bearer ${dummyToken}`)
      .send({ workspaceId: '00000000-0000-0000-0000-000000000000', documentId: '00000000-0000-0000-0000-000000000000' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Rate limiter unavailable');
  });
});
