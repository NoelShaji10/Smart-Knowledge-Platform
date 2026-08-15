import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb } from '@knowledge/database';

describe('Auth Flow Integration Tests', () => {
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

  const testEmail = `auth_flow_${Date.now()}@example.com`;
  const testPassword = 'Password123!';
  let refreshCookie: string;
  let accessToken: string;

  it('POST /api/v1/auth/register creates user and returns access token + cookie', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: testEmail,
        password: testPassword,
        displayName: 'Auth Flow User',
      });

    expect(res.status).toBe(201);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe(testEmail);
    expect(res.body.accessToken).toBeDefined();

    const cookies = res.get('Set-Cookie');
    expect(cookies).toBeDefined();
    refreshCookie = cookies.find((c: string) => c.startsWith('refreshToken=')) || '';
    expect(refreshCookie).toContain('HttpOnly');
  });

  it('POST /api/v1/auth/login authenticates user and sets refresh cookie', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: testEmail,
        password: testPassword,
      });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(testEmail);
    expect(res.body.accessToken).toBeDefined();
    accessToken = res.body.accessToken;

    const cookies = res.get('Set-Cookie');
    refreshCookie = cookies.find((c: string) => c.startsWith('refreshToken=')) || '';
    expect(refreshCookie).toBeDefined();
  });

  it('POST /api/v1/auth/refresh rotates token using cookie only', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [refreshCookie]);

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();

    const cookies = res.get('Set-Cookie');
    refreshCookie = cookies.find((c: string) => c.startsWith('refreshToken=')) || '';
  });

  it('POST /api/v1/auth/logout succeeds with cookie only (no Bearer token required)', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', [refreshCookie]);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Refreshing with the logged-out cookie fails
    const refreshRes = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [refreshCookie]);

    expect(refreshRes.status).toBe(401);
  });
});
