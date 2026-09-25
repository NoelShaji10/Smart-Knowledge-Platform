import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations } from '@knowledge/database';

describe('Task 9: Failure-Path End-to-End API Integration Tests', () => {
  const app = createApiApp();
  let userToken: string;
  let workspaceId: string;

  beforeAll(async () => {
    // Database migration must succeed; if unavailable, fail visibly rather than silently skipping
    await runMigrations();

    // Register a test user and obtain access token
    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: `fail_paths_${Date.now()}_${Math.floor(Math.random() * 10000)}@example.com`,
        password: 'Password123!',
        displayName: 'Failure Path User',
      });

    if (regRes.status !== 201) {
      throw new Error(`Failed to register test user in beforeAll: ${JSON.stringify(regRes.body)}`);
    }
    userToken = regRes.body.accessToken;

    // Create a workspace
    const wsRes = await request(app)
      .post('/api/v1/workspaces')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ name: 'Failure Path Workspace' });

    if (wsRes.status !== 201) {
      throw new Error(`Failed to create test workspace in beforeAll: ${JSON.stringify(wsRes.body)}`);
    }
    workspaceId = wsRes.body.workspace.id;
  });

  // Verify test prerequisites are fully initialized (guards against false-positive passes)
  it('ensures test infrastructure and authentication prerequisites are initialized', () => {
    expect(userToken).toBeDefined();
    expect(typeof userToken).toBe('string');
    expect(userToken.length).toBeGreaterThan(0);
    expect(workspaceId).toBeDefined();
    expect(typeof workspaceId).toBe('string');
    expect(workspaceId.length).toBeGreaterThan(0);
  });

  // 1. Validation Failures (HTTP 400 with VALIDATION_ERROR)
  it('returns HTTP 400 Bad Request with VALIDATION_ERROR when document payload fails schema validation', async () => {
    expect(userToken).toBeDefined();
    expect(workspaceId).toBeDefined();

    // Title is empty string, which violates min(1) constraint in schema
    const res = await request(app)
      .post(`/api/v1/workspaces/${workspaceId}/documents`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ title: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request payload');
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it('returns HTTP 400 Bad Request when JSON payload is malformed', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "bad json');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid JSON payload');
    expect(res.body.code).toBe('INVALID_JSON');
  });

  // 2. Authentication Failures (HTTP 401)
  it('returns HTTP 401 Unauthorized when authorization header is missing on protected routes', async () => {
    const res = await request(app).get('/api/v1/workspaces');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Missing or invalid authorization header');
  });

  it('returns HTTP 401 Unauthorized when token is forged or invalid', async () => {
    const res = await request(app)
      .get('/api/v1/workspaces')
      .set('Authorization', 'Bearer invalid.forged.jwt.token');

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or expired token');
  });

  // 3. Authorization Failures (HTTP 403)
  it('returns HTTP 403 Forbidden when requesting resources in a workspace without access', async () => {
    expect(userToken).toBeDefined();

    // Arbitrary workspace UUID where user is not a member
    const foreignWorkspaceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const res = await request(app)
      .get(`/api/v1/workspaces/${foreignWorkspaceId}/documents`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Access denied');
  });

  // 4. Missing Resource Failures (HTTP 404 / 403)
  it('returns HTTP 403 Forbidden for non-existent or inaccessible workspace (enumeration protection)', async () => {
    expect(userToken).toBeDefined();

    const nonexistentId = '99999999-9999-9999-9999-999999999999';
    const res = await request(app)
      .get(`/api/v1/workspaces/${nonexistentId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Access denied');
  });

  it('returns HTTP 404 Not Found for non-existent document in workspace', async () => {
    expect(userToken).toBeDefined();
    expect(workspaceId).toBeDefined();

    const nonexistentDocId = '88888888-8888-8888-8888-888888888888';
    const res = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}/documents/${nonexistentDocId}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Document not found');
  });

  it('returns HTTP 404 for completely unmatched route endpoints', async () => {
    const res = await request(app).get('/api/v1/nonexistent-route-endpoint');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Endpoint not found');
    expect(res.body.code).toBe('NOT_FOUND');
  });

  // 5. Server Error Redaction Security Invariant (HTTP 500)
  it('preserves security invariant: 5xx server responses never expose raw SQL, stack traces, or schema', async () => {
    expect(userToken).toBeDefined();

    // Attempting an invalid UUID in parameter triggers database rejection
    const res = await request(app)
      .get('/api/v1/workspaces/not-a-uuid/documents')
      .set('Authorization', `Bearer ${userToken}`);

    // Must fail with 500 and strictly redact raw SQL / schema
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.error).not.toContain('syntax');
    expect(res.body.error).not.toContain('SELECT');
    expect(res.body.stack).toBeUndefined();
  });
});
