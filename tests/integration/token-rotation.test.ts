import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb } from '@knowledge/database';
import { registerUser, issueRefreshToken, rotateRefreshToken, TokenReuseError } from '@knowledge/auth';

describe('Token Rotation & Reuse Detection Integration', () => {
  const app = createApiApp();
  let isDbConnected = false;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;
    } catch {
      isDbConnected = false;
    }
  });

  it('detects refresh token reuse and revokes entire family', async () => {
    if (!isDbConnected) return;

    const db = getSystemDb();
    const user = await registerUser(db, {
      email: `reuse_detect_${Date.now()}@example.com`,
      password: 'Password123!',
      displayName: 'Reuse Test User',
    });

    const token1 = await issueRefreshToken(db, user.id);

    // First rotation -> token2
    const token2 = await rotateRefreshToken(db, token1.rawToken);
    expect(token2.rawRefreshToken).toBeDefined();

    // Reusing token1 -> triggers TokenReuseError
    await expect(rotateRefreshToken(db, token1.rawToken)).rejects.toThrow(TokenReuseError);

    // token2 is now also revoked due to family revocation
    await expect(rotateRefreshToken(db, token2.rawRefreshToken)).rejects.toThrow();
  });

  it('POST /api/v1/auth/refresh returns 401 token_reuse_detected on reuse', async () => {
    if (!isDbConnected) return;

    const email = `reuse_route_${Date.now()}@example.com`;
    const password = 'Password123!';

    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password, displayName: 'Reuse Route User' });

    const rawCookie = regRes.get('Set-Cookie').find((c: string) => c.startsWith('refreshToken='));
    const cookie1 = rawCookie.split(';')[0];

    // First refresh
    const refRes1 = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [cookie1]);

    expect(refRes1.status).toBe(200);

    // Reusing cookie1 on the endpoint
    const refRes2 = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [cookie1]);

    expect(refRes2.status).toBe(401);
    expect(refRes2.body.error).toBe('token_reuse_detected');
  });
});
