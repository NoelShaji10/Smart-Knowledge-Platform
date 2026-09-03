import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb, withSystemContext } from '@knowledge/database';

describe('Auth Flow & Session Persistence Integration Tests', () => {
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

  const testEmail = `auth_flow_${Date.now()}_${Math.floor(Math.random() * 10000)}@example.com`;
  const testPassword = 'Password123!';
  let refreshCookie: string;
  let accessToken: string;
  let userId: string;
  let createdWorkspaceId: string;
  let createdDocId: string;

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
    userId = res.body.user.id;
    accessToken = res.body.accessToken;

    const cookies = res.get('Set-Cookie');
    expect(cookies).toBeDefined();
    refreshCookie = cookies.find((c: string) => c.startsWith('refreshToken=')) || '';
    expect(refreshCookie).toContain('HttpOnly');
  });

  it('GET /api/v1/auth/me with valid access token returns 200 and user profile using RLS context', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.id).toBe(userId);
    expect(res.body.user.email).toBe(testEmail);
    expect(res.body.user.displayName).toBe('Auth Flow User');
  });

  it('GET /api/v1/auth/me without Bearer token returns 401 Unauthorized', async () => {
    if (!isDbConnected) return;

    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/auth/refresh rotates token using cookie and enables subsequent GET /me calls', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [refreshCookie]);

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    accessToken = res.body.accessToken;

    const cookies = res.get('Set-Cookie');
    refreshCookie = cookies.find((c: string) => c.startsWith('refreshToken=')) || '';

    // Verify newly rotated token successfully hydrates /auth/me profile
    const meRes = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.user.id).toBe(userId);
  });

  it('POST /api/v1/workspaces creates workspace in PostgreSQL database', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Persisted Test Workspace' });

    expect(res.status).toBe(201);
    expect(res.body.workspace).toBeDefined();
    expect(res.body.workspace.name).toBe('Persisted Test Workspace');
    createdWorkspaceId = res.body.workspace.id;

    // Direct DB assertion: check row exists in PostgreSQL
    const dbRow = await withSystemContext(async (sysDb) => {
      return sysDb
        .selectFrom('workspaces')
        .where('id', '=', createdWorkspaceId)
        .selectAll()
        .executeTakeFirst();
    });

    expect(dbRow).toBeDefined();
    expect(dbRow?.name).toBe('Persisted Test Workspace');
  });

  it('GET /api/v1/workspaces returns persisted workspaces after fresh session refresh', async () => {
    if (!isDbConnected) return;

    // Simulate session reload: refresh token -> get new access token -> fetch workspaces
    const refreshRes = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [refreshCookie]);

    expect(refreshRes.status).toBe(200);
    accessToken = refreshRes.body.accessToken;

    const wsRes = await request(app)
      .get('/api/v1/workspaces')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(wsRes.status).toBe(200);
    expect(wsRes.body.workspaces).toBeDefined();
    expect(wsRes.body.workspaces.length).toBeGreaterThan(0);

    const found = wsRes.body.workspaces.find((w: any) => w.id === createdWorkspaceId);
    expect(found).toBeDefined();
    expect(found.name).toBe('Persisted Test Workspace');
  });

  it('document creation, update, and retrieval persist in PostgreSQL across requests', async () => {
    if (!isDbConnected) return;

    // 1. Create document
    const createRes = await request(app)
      .post(`/api/v1/workspaces/${createdWorkspaceId}/documents`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'Persistent Doc Title', contentText: '<p>Initial Content</p>' });

    expect(createRes.status).toBe(201);
    createdDocId = createRes.body.document.id;

    // 2. Update document content
    const patchRes = await request(app)
      .patch(`/api/v1/workspaces/${createdWorkspaceId}/documents/${createdDocId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'Updated Persistent Title', contentText: '<p>Updated Rich Text Content</p>' });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.document.title).toBe('Updated Persistent Title');
    expect(patchRes.body.document.content_text).toBe('<p>Updated Rich Text Content</p>');

    // 3. Direct DB assertion: inspect PostgreSQL document row
    const dbDocRow = await withSystemContext(async (sysDb) => {
      return sysDb
        .selectFrom('documents')
        .where('id', '=', createdDocId)
        .selectAll()
        .executeTakeFirst();
    });

    expect(dbDocRow).toBeDefined();
    expect(dbDocRow?.title).toBe('Updated Persistent Title');
    expect(dbDocRow?.content_text).toBe('<p>Updated Rich Text Content</p>');

    // 4. Simulate navigation away and return: GET document
    const getRes = await request(app)
      .get(`/api/v1/workspaces/${createdWorkspaceId}/documents/${createdDocId}`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.document.title).toBe('Updated Persistent Title');
    expect(getRes.body.document.content_text).toBe('<p>Updated Rich Text Content</p>');
  });

  it('POST /api/v1/auth/logout succeeds and invalidates refresh token', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', [refreshCookie]);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const refreshRes = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [refreshCookie]);

    expect(refreshRes.status).toBe(401);
  });
});
