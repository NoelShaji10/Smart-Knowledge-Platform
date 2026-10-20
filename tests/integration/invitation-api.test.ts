import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb, withSystemContext } from '@knowledge/database';
import * as databaseModule from '@knowledge/database';
import { registerUser, loginUser, issueAccessToken } from '@knowledge/auth';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';
import { getRedisClient } from '@knowledge/redis';
import { logger } from '@knowledge/config';
import { sanitizeUrl } from '../../apps/api-server/src/middleware/error-handler';
import * as invitationService from '../../apps/api-server/src/lib/invitation-service';

describe('Workspace Invitations HTTP API & Security Integration Tests', () => {
  const app = createApiApp();

  let owner: { id: string; email: string };
  let admin: { id: string; email: string };
  let editor: { id: string; email: string };
  let viewer: { id: string; email: string };
  let externalUserA: { id: string; email: string };
  let externalUserB: { id: string; email: string };
  let otherWorkspaceOwner: { id: string; email: string };

  let ownerToken: string;
  let adminToken: string;
  let editorToken: string;
  let viewerToken: string;
  let externalTokenA: string;
  let externalTokenB: string;
  let otherOwnerToken: string;

  let workspaceId: string;
  let otherWorkspaceId: string;

  beforeAll(async () => {
    await runMigrations();

    const db = getSystemDb();
    const timestamp = Date.now();

    // Register users
    owner = await registerUser(db, {
      email: `api_owner_${timestamp}@example.com`,
      password: 'Password123!',
      displayName: 'API Owner',
    });
    admin = await registerUser(db, {
      email: `api_admin_${timestamp}@example.com`,
      password: 'Password123!',
      displayName: 'API Admin',
    });
    editor = await registerUser(db, {
      email: `api_editor_${timestamp}@example.com`,
      password: 'Password123!',
      displayName: 'API Editor',
    });
    viewer = await registerUser(db, {
      email: `api_viewer_${timestamp}@example.com`,
      password: 'Password123!',
      displayName: 'API Viewer',
    });
    externalUserA = await registerUser(db, {
      email: `api_externalA_${timestamp}@example.com`,
      password: 'Password123!',
      displayName: 'API External A',
    });
    externalUserB = await registerUser(db, {
      email: `api_externalB_${timestamp}@example.com`,
      password: 'Password123!',
      displayName: 'API External B',
    });
    otherWorkspaceOwner = await registerUser(db, {
      email: `api_other_owner_${timestamp}@example.com`,
      password: 'Password123!',
      displayName: 'Other Owner',
    });

    // Create primary test workspace
    const ws = await createWorkspace(db, owner.id, 'API Invitations Workspace');
    workspaceId = ws.id;

    // Add members to primary workspace
    await withSystemContext(async (sysDb) => {
      await sysDb
        .insertInto('workspace_members')
        .values([
          { workspace_id: workspaceId, user_id: admin.id, role: 'admin' },
          { workspace_id: workspaceId, user_id: editor.id, role: 'editor' },
          { workspace_id: workspaceId, user_id: viewer.id, role: 'viewer' },
        ])
        .execute();
    });

    // Create secondary isolated workspace
    const otherWs = await createWorkspace(db, otherWorkspaceOwner.id, 'Other Isolated Workspace');
    otherWorkspaceId = otherWs.id;

    // Authenticate all users
    ownerToken = (await loginUser(db, { email: owner.email, password: 'Password123!' })).accessToken;
    adminToken = (await loginUser(db, { email: admin.email, password: 'Password123!' })).accessToken;
    editorToken = (await loginUser(db, { email: editor.email, password: 'Password123!' })).accessToken;
    viewerToken = (await loginUser(db, { email: viewer.email, password: 'Password123!' })).accessToken;
    externalTokenA = (await loginUser(db, { email: externalUserA.email, password: 'Password123!' })).accessToken;
    externalTokenB = (await loginUser(db, { email: externalUserB.email, password: 'Password123!' })).accessToken;
    otherOwnerToken = (await loginUser(db, { email: otherWorkspaceOwner.email, password: 'Password123!' })).accessToken;
  });

  // =========================================================================
  // 1. Route and Validation Behavior (items 1–5)
  // =========================================================================
  describe('1. Route and Validation Behavior', () => {
    it('rejects malformed workspace IDs with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/v1/workspaces/not-a-valid-uuid/invitations')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'editor' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects malformed invitation IDs with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .delete(`/api/v1/workspaces/${workspaceId}/invitations/invalid-uuid`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects missing role in request body with 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: 'test@example.com' }); // missing role

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects empty or whitespace invitation token on public resolution with 400', async () => {
      const res = await request(app).get('/api/v1/invitations/%20');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects unauthenticated invitation acceptance with 401', async () => {
      const res = await request(app)
        .post('/api/v1/invitations/some-token-without-auth/accept')
        .send();

      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
    });

    it('allows public token resolution without authentication', async () => {
      // Create a shareable invitation first
      const createRes = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'viewer' });

      expect(createRes.status).toBe(201);
      const { rawToken } = createRes.body;

      // Public GET without any Authorization header
      const resolveRes = await request(app).get(`/api/v1/invitations/${rawToken}`);

      expect(resolveRes.status).toBe(200);
      expect(resolveRes.body.invitation).toBeDefined();
      expect(resolveRes.body.invitation.workspaceName).toBe('API Invitations Workspace');
      expect(resolveRes.body.invitation.role).toBe('viewer');
      expect(resolveRes.body.invitation.isEmailBound).toBe(false);
    });

    it('returns standard 404 NOT_FOUND for unknown routes', async () => {
      const res = await request(app).get('/api/v1/invitations-unknown-route');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  // =========================================================================
  // 2. Workspace Authorization (items 6–12)
  // =========================================================================
  describe('2. Workspace Authorization Controls', () => {
    it('allows Workspace Owner to create Admin, Editor, and Viewer invitations', async () => {
      for (const role of ['admin', 'editor', 'viewer']) {
        const res = await request(app)
          .post(`/api/v1/workspaces/${workspaceId}/invitations`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ role });

        expect(res.status).toBe(201);
        expect(res.body.invitation.role).toBe(role);
        expect(res.body.rawToken).toBeDefined();
      }
    });

    it('allows Workspace Admin to create Editor and Viewer invitations', async () => {
      for (const role of ['editor', 'viewer']) {
        const res = await request(app)
          .post(`/api/v1/workspaces/${workspaceId}/invitations`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ role });

        expect(res.status).toBe(201);
        expect(res.body.invitation.role).toBe(role);
      }
    });

    it('strictly forbids Workspace Admin from creating Admin invitations (escalation guard)', async () => {
      const res = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'admin' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ADMIN_PRIVILEGE_ESCALATION');
    });

    it('strictly prevents any caller from creating Owner invitations', async () => {
      const res = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'owner' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_ROLE');
    });

    it('strictly blocks Editor and Viewer from creating or listing invitations', async () => {
      // Editor blocked
      const editorCreate = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${editorToken}`)
        .send({ role: 'viewer' });
      expect(editorCreate.status).toBe(403);

      const editorList = await request(app)
        .get(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${editorToken}`);
      expect(editorList.status).toBe(403);

      // Viewer blocked
      const viewerCreate = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ role: 'viewer' });
      expect(viewerCreate.status).toBe(403);

      const viewerList = await request(app)
        .get(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${viewerToken}`);
      expect(viewerList.status).toBe(403);
    });

    it('strictly denies cross-workspace access to invitations', async () => {
      // Other workspace owner tries to access primary workspace invitations
      const res = await request(app)
        .get(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${otherOwnerToken}`);

      expect(res.status).toBe(403);
    });

    it('forbids Admin from revoking or replacing an Admin invitation', async () => {
      // Owner creates an Admin invite
      const createRes = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'admin' });

      const inviteId = createRes.body.invitation.id;

      // Admin attempts to revoke it -> 403
      const revokeRes = await request(app)
        .delete(`/api/v1/workspaces/${workspaceId}/invitations/${inviteId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(revokeRes.status).toBe(403);
      expect(revokeRes.body.code).toBe('ADMIN_PRIVILEGE_ESCALATION');

      // Admin attempts to resend it -> 403
      const resendRes = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations/${inviteId}/resend`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(resendRes.status).toBe(403);
      expect(resendRes.body.code).toBe('ADMIN_PRIVILEGE_ESCALATION');
    });
  });

  // =========================================================================
  // 3. Token Lifecycle, Privacy and Resolution (items 13–20)
  // =========================================================================
  describe('3. Token Lifecycle and Privacy', () => {
    it('creation returns raw token only to creation caller and never stores raw secret in DB', async () => {
      const createRes = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'editor' });

      expect(createRes.status).toBe(201);
      expect(createRes.body.rawToken).toBeDefined();
      expect(createRes.body.invitation).not.toHaveProperty('token_hash');

      // Query PostgreSQL to verify database stores token_hash, not rawToken
      const storedRow = await withSystemContext(async (sysDb) => {
        return sysDb
          .selectFrom('workspace_invitations')
          .where('id', '=', createRes.body.invitation.id)
          .select(['token_hash'])
          .executeTakeFirst();
      });

      expect(storedRow?.token_hash).not.toBe(createRes.body.rawToken);
    });

    it('listing invitations never returns token_hash or rawToken', async () => {
      const res = await request(app)
        .get(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.invitations)).toBe(true);

      for (const inv of res.body.invitations) {
        expect(inv).not.toHaveProperty('token_hash');
        expect(inv).not.toHaveProperty('rawToken');
      }
    });

    it('public resolution returns sanitized public metadata and does not consume invitation', async () => {
      const createRes = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'editor', email: 'privacy_target@example.com' });

      const { rawToken } = createRes.body;

      // First resolution
      const res1 = await request(app).get(`/api/v1/invitations/${rawToken}`);
      expect(res1.status).toBe(200);
      expect(res1.body.invitation.workspaceName).toBe('API Invitations Workspace');
      expect(res1.body.invitation.role).toBe('editor');
      expect(res1.body.invitation.isEmailBound).toBe(true);
      expect(res1.body.invitation.maskedEmail).toBe('p***t@example.com');
      expect(res1.body.invitation).not.toHaveProperty('token_hash');
      expect(res1.body.invitation).not.toHaveProperty('id');

      // Second resolution: still accessible, not consumed
      const res2 = await request(app).get(`/api/v1/invitations/${rawToken}`);
      expect(res2.status).toBe(200);
    });

    it('revocation invalidates the link and returns 410 INVITATION_REVOKED on subsequent resolution', async () => {
      const createRes = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'viewer' });

      const { invitation, rawToken } = createRes.body;

      // Revoke
      const revokeRes = await request(app)
        .delete(`/api/v1/workspaces/${workspaceId}/invitations/${invitation.id}`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.ok).toBe(true);

      // Attempt resolve
      const resolveRes = await request(app).get(`/api/v1/invitations/${rawToken}`);
      expect(resolveRes.status).toBe(410);
      expect(resolveRes.body.code).toBe('INVITATION_REVOKED');
    });

    it('replacement invalidates previous token and issues fresh usable link', async () => {
      const initial = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'viewer' });

      const resendRes = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations/${initial.body.invitation.id}/resend`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(resendRes.status).toBe(200);
      expect(resendRes.body.rawToken).not.toBe(initial.body.rawToken);

      // Old token revoked
      const oldCheck = await request(app).get(`/api/v1/invitations/${initial.body.rawToken}`);
      expect(oldCheck.status).toBe(410);
      expect(oldCheck.body.code).toBe('INVITATION_REVOKED');

      // New token resolves successfully
      const newCheck = await request(app).get(`/api/v1/invitations/${resendRes.body.rawToken}`);
      expect(newCheck.status).toBe(200);
      expect(newCheck.body.invitation.role).toBe('viewer');
    });

    it('rejects expired invitation tokens with 410 INVITATION_EXPIRED', async () => {
      const createRes = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'viewer' });

      const { invitation, rawToken } = createRes.body;

      // Manually simulate expiration in PostgreSQL
      await withSystemContext(async (sysDb) => {
        await sysDb
          .updateTable('workspace_invitations')
          .set({ expires_at: new Date(Date.now() - 10000) })
          .where('id', '=', invitation.id)
          .execute();
      });

      const resolveRes = await request(app).get(`/api/v1/invitations/${rawToken}`);
      expect(resolveRes.status).toBe(410);
      expect(resolveRes.body.code).toBe('INVITATION_EXPIRED');

      const acceptRes = await request(app)
        .post(`/api/v1/invitations/${rawToken}/accept`)
        .set('Authorization', `Bearer ${externalTokenA}`);
      expect(acceptRes.status).toBe(410);
      expect(acceptRes.body.code).toBe('INVITATION_EXPIRED');
    });

    it('does not leak database or internal implementation details on invalid tokens', async () => {
      const res = await request(app).get('/api/v1/invitations/completely_random_non_existent_token');

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('INVITATION_NOT_FOUND');
      expect(res.body).not.toHaveProperty('stack');
      expect(res.body).not.toHaveProperty('sql');
    });
  });

  // =========================================================================
  // 4. Authenticated Acceptance & Fail-Closed Email Verification (items 21–27)
  // =========================================================================
  describe('4. Authenticated Acceptance and Role Enforcement', () => {
    it('accepts shareable invitation and adds user with exact role', async () => {
      const createRes = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'editor' });

      const { rawToken } = createRes.body;

      const acceptRes = await request(app)
        .post(`/api/v1/invitations/${rawToken}/accept`)
        .set('Authorization', `Bearer ${externalTokenA}`);

      expect(acceptRes.status).toBe(200);
      expect(acceptRes.body.status).toBe('accepted');
      expect(acceptRes.body.workspaceId).toBe(workspaceId);
      expect(acceptRes.body.role).toBe('editor');

      // Verify PostgreSQL record
      const member = await withSystemContext(async (sysDb) => {
        return sysDb
          .selectFrom('workspace_members')
          .where('workspace_id', '=', workspaceId)
          .where('user_id', '=', externalUserA.id)
          .select(['role'])
          .executeTakeFirst();
      });
      expect(member).toBeDefined();
      expect(member?.role).toBe('editor');

      // Second acceptance of single-use link is rejected with 409 INVITATION_ALREADY_ACCEPTED
      const secondAccept = await request(app)
        .post(`/api/v1/invitations/${rawToken}/accept`)
        .set('Authorization', `Bearer ${externalTokenB}`);

      expect(secondAccept.status).toBe(409);
      expect(secondAccept.body.code).toBe('INVITATION_ALREADY_ACCEPTED');
    });

    it('rejects email-bound invitation acceptance from standard sessions (fail-closed unverified email)', async () => {
      const targetEmail = `bound_unverified_${Date.now()}@example.com`;

      const createRes = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'viewer', email: targetEmail });

      const { rawToken } = createRes.body;

      // Register matching user (whose session token does not carry authoritative emailVerified: true)
      const db = getSystemDb();
      const user = await registerUser(db, {
        email: targetEmail,
        password: 'Password123!',
        displayName: 'Unverified Recipient',
      });
      const userToken = (await loginUser(db, { email: user.email, password: 'Password123!' })).accessToken;

      // Acceptance must fail closed with 403 EMAIL_NOT_VERIFIED
      const acceptRes = await request(app)
        .post(`/api/v1/invitations/${rawToken}/accept`)
        .set('Authorization', `Bearer ${userToken}`);

      expect(acceptRes.status).toBe(403);
      expect(acceptRes.body.code).toBe('EMAIL_NOT_VERIFIED');

      // Verify invitation is still pending and no membership created
      const invRow = await withSystemContext(async (sysDb) => {
        return sysDb
          .selectFrom('workspace_invitations')
          .where('id', '=', createRes.body.invitation.id)
          .selectAll()
          .executeTakeFirst();
      });
      expect(invRow?.status).toBe('pending');
      expect(invRow?.accepted_by).toBeNull();
      const memberRow = await withSystemContext(async (sysDb) => {
        return sysDb
          .selectFrom('workspace_members')
          .where('workspace_id', '=', workspaceId)
          .where('user_id', '=', user.id)
          .executeTakeFirst();
      });
      expect(memberRow).toBeUndefined();
    });

    it('rejects email-bound invitation when caller email does not match invitation email', async () => {
      const targetEmail = `bound_target_${Date.now()}@example.com`;

      const createRes = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'viewer', email: targetEmail });

      // Issue token for externalUserB whose email does NOT match targetEmail,
      // even if authoritative claim is present
      const tokenWithVerifiedClaim = issueAccessToken({
        id: externalUserB.id,
        email: externalUserB.email,
      });

      const acceptRes = await request(app)
        .post(`/api/v1/invitations/${createRes.body.rawToken}/accept`)
        .set('Authorization', `Bearer ${tokenWithVerifiedClaim}`);

      // Since session email does not match targetEmail, it must reject
      expect([403]).toContain(acceptRes.status);
    });

    it('handles acceptance gracefully when user is already a member without modifying role', async () => {
      // Owner creates Admin invite
      const createRes = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'admin' });

      // Existing editor attempts to accept Admin invite
      const acceptRes = await request(app)
        .post(`/api/v1/invitations/${createRes.body.rawToken}/accept`)
        .set('Authorization', `Bearer ${editorToken}`);

      expect(acceptRes.status).toBe(200);
      expect(acceptRes.body.status).toBe('already_member');
      expect(acceptRes.body.role).toBe('editor'); // Kept existing role!

      // Invitation is NOT consumed; still pending
      const resolveRes = await request(app).get(`/api/v1/invitations/${createRes.body.rawToken}`);
      expect(resolveRes.status).toBe(200);
      expect(resolveRes.body.invitation.role).toBe('admin');
    });

    it('prevents concurrent double-acceptance via transactional row locking', async () => {
      const createRes = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'viewer' });

      const { rawToken } = createRes.body;

      // Register two distinct users
      const db = getSystemDb();
      const timestamp = Date.now();
      const r1 = await registerUser(db, {
        email: `racer1_api_${timestamp}@example.com`,
        password: 'Password123!',
        displayName: 'Racer 1 API',
      });
      const r2 = await registerUser(db, {
        email: `racer2_api_${timestamp}@example.com`,
        password: 'Password123!',
        displayName: 'Racer 2 API',
      });

      const r1Token = (await loginUser(db, { email: r1.email, password: 'Password123!' })).accessToken;
      const r2Token = (await loginUser(db, { email: r2.email, password: 'Password123!' })).accessToken;

      // Launch simultaneous requests
      const [res1, res2] = await Promise.all([
        request(app).post(`/api/v1/invitations/${rawToken}/accept`).set('Authorization', `Bearer ${r1Token}`),
        request(app).post(`/api/v1/invitations/${rawToken}/accept`).set('Authorization', `Bearer ${r2Token}`),
      ]);

      const statuses = [res1.status, res2.status].sort();
      // Exactly one 200 OK and one 409 Conflict
      expect(statuses).toEqual([200, 409]);
    });
  });

  // =========================================================================
  // 5. Rate Limiting & Spoofing Protection (Task 2 Remediation)
  // =========================================================================
  describe('5. Rate Limiting & Spoofing Protection', () => {
    it('applies real sequential rate limiting to public invitation resolution without pre-seeding', async () => {
      const redis = getRedisClient();
      // Ensure clean state for any resolve keys
      const existingKeys = await redis.keys('rate:invitation-resolve:*');
      for (const k of existingKeys) {
        await redis.del(k);
      }

      // 1. Send sequential requests up to the 60 request limit
      for (let i = 0; i < 60; i++) {
        const res = await request(app).get(`/api/v1/invitations/unresolved-token-seq-${i}`);
        expect([404, 200]).toContain(res.status);
      }

      // Request 61 must receive 429 Too Many Requests
      const blockedRes = await request(app).get('/api/v1/invitations/unresolved-token-seq-60');
      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error).toBe('Too many requests');
      expect(typeof blockedRes.body.retryAfter).toBe('number');

      // 2. Attempt to evade the limiter by rotating spoofed X-Forwarded-For headers
      for (let i = 1; i <= 5; i++) {
        const spoofedRes = await request(app)
          .get('/api/v1/invitations/unresolved-token-seq-spoofed')
          .set('X-Forwarded-For', `203.0.113.${i}`);

        // Since trust proxy is false, Express req.ip ignores X-Forwarded-For and binds to socket address
        expect(spoofedRes.status).toBe(429);
        expect(spoofedRes.body.error).toBe('Too many requests');
      }

      // 3. Confirm legitimate client IP extraction and shared counter in Redis
      const resolveKeys = await redis.keys('rate:invitation-resolve:*');
      // Exactly 1 key should exist, mapped to the peer socket IP (not a spoofed header or raw token)
      expect(resolveKeys.length).toBe(1);
      expect(resolveKeys[0]).not.toContain('unresolved-token-seq');
      expect(resolveKeys[0]).not.toContain('203.0.113.');

      const counterVal = Number(await redis.get(resolveKeys[0]));
      expect(counterVal).toBeGreaterThanOrEqual(66); // 60 allowed + 1 blocked + 5 spoofed attempts

      // Clean up
      for (const k of resolveKeys) {
        await redis.del(k);
      }
    });

    it('applies rate limiter to authenticated invitation acceptance and returns 429 when exceeded', async () => {
      const redis = getRedisClient();
      const rateLimitKey = `rate:invitation-accept:${externalUserA.id}`;

      // Set redis count directly to threshold
      await redis.set(rateLimitKey, '30');
      await redis.expire(rateLimitKey, 60);

      const res = await request(app)
        .post('/api/v1/invitations/any-token-rate-limit-test/accept')
        .set('Authorization', `Bearer ${externalTokenA}`);

      expect(res.status).toBe(429);
      expect(res.body.error).toBe('Too many requests');
      expect(res.body.retryAfter).toBeDefined();

      // Clean up key
      await redis.del(rateLimitKey);
    });
  });

  // =========================================================================
  // 6. Token Log Redaction Tests (Task 2 Remediation)
  // =========================================================================
  describe('6. Token Log Redaction & Safe Error Handling', () => {
    it('redacts invitation tokens in sanitizeUrl helper for various path and query combinations', () => {
      expect(sanitizeUrl('/api/v1/invitations/secret-token-123')).toBe('/api/v1/invitations/[REDACTED]');
      expect(sanitizeUrl('/api/v1/invitations/secret-token-123/accept')).toBe('/api/v1/invitations/[REDACTED]/accept');
      expect(sanitizeUrl('/api/v1/invitations/secret-token-123/accept?source=email#target')).toBe('/api/v1/invitations/[REDACTED]/accept?source=email#target');
      expect(sanitizeUrl('/api/v1/invitations/malformed%20tok%21%40%23/accept')).toBe('/api/v1/invitations/[REDACTED]/accept');
      expect(sanitizeUrl('/api/v1/workspaces/550e8400-e29b-41d4-a716-446655440000/invitations')).toBe('/api/v1/workspaces/550e8400-e29b-41d4-a716-446655440000/invitations');
    });

    it('redacts raw token from error logs when public resolution encounters an unexpected 500 error', async () => {
      const rawSecretToken = 'super-secret-resolution-token-xyz999';
      const loggerSpy = vi.spyOn(logger, 'error');
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const resolveSpy = vi
        .spyOn(invitationService, 'resolveInvitationToken')
        .mockRejectedValueOnce(new Error('Unexpected fatal database failure'));

      const res = await request(app).get(`/api/v1/invitations/${rawSecretToken}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Internal server error');
      expect(res.body.code).toBe('INTERNAL_SERVER_ERROR');
      expect(res.body.details).toBeUndefined();

      // Assert logger.error was called with redacted URL and no raw token
      expect(loggerSpy).toHaveBeenCalled();
      for (const call of loggerSpy.mock.calls) {
        const [message, err, meta] = call;
        expect(message).not.toContain(rawSecretToken);
        expect(message).toContain('[REDACTED]');
        if (meta && typeof meta === 'object') {
          const serialized = JSON.stringify(meta);
          expect(serialized).not.toContain(rawSecretToken);
          expect(serialized).toContain('[REDACTED]');
        }
      }

      // Assert console.error was not fed raw token
      for (const call of consoleSpy.mock.calls) {
        const fullLog = call.map((c) => String(c)).join(' ');
        expect(fullLog).not.toContain(rawSecretToken);
      }

      resolveSpy.mockRestore();
      loggerSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('redacts raw token from error logs when invitation acceptance encounters an unexpected 500 error', async () => {
      const rawSecretToken = 'super-secret-acceptance-token-abc888';
      const loggerSpy = vi.spyOn(logger, 'error');
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const acceptSpy = vi
        .spyOn(invitationService, 'acceptInvitation')
        .mockRejectedValueOnce(new Error('Unexpected transaction deadlock error'));

      const res = await request(app)
        .post(`/api/v1/invitations/${rawSecretToken}/accept`)
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Internal server error');
      expect(res.body.code).toBe('INTERNAL_SERVER_ERROR');

      // Assert logger.error was called with redacted URL
      expect(loggerSpy).toHaveBeenCalled();
      for (const call of loggerSpy.mock.calls) {
        const [message, err, meta] = call;
        expect(message).not.toContain(rawSecretToken);
        expect(message).toContain('[REDACTED]/accept');
        if (meta && typeof meta === 'object') {
          const serialized = JSON.stringify(meta);
          expect(serialized).not.toContain(rawSecretToken);
          expect(serialized).toContain('[REDACTED]/accept');
        }
      }

      // Assert console.error did not receive raw token
      for (const call of consoleSpy.mock.calls) {
        const fullLog = call.map((c) => String(c)).join(' ');
        expect(fullLog).not.toContain(rawSecretToken);
      }

      acceptSpy.mockRestore();
      loggerSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('redacts malformed or unusual URL tokens from error logs', async () => {
      const malformedToken = 'malformed%20token%21%40%23';
      const loggerSpy = vi.spyOn(logger, 'error');
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const resolveSpy = vi
        .spyOn(invitationService, 'resolveInvitationToken')
        .mockRejectedValueOnce(new Error('Fatal parsing error'));

      const res = await request(app).get(`/api/v1/invitations/${malformedToken}`);

      expect(res.status).toBe(500);
      for (const call of loggerSpy.mock.calls) {
        const [message, err, meta] = call;
        expect(message).not.toContain('malformed');
        expect(message).toContain('[REDACTED]');
      }

      resolveSpy.mockRestore();
      loggerSpy.mockRestore();
      consoleSpy.mockRestore();
    });
  });

  // =========================================================================
  // 7. Middleware Ordering Regression Tests (Task 2 Remediation)
  // =========================================================================
  describe('7. Middleware Ordering: Rate Limiting Precedes DB Authorization', () => {
    it('rejects rate-limited invitation creation request with 429 without executing workspace_members database check', async () => {
      const redis = getRedisClient();
      const rateLimitKey = `rate:invitation-create:${viewer.id}`;

      // Set redis count directly to threshold for viewer
      await redis.set(rateLimitKey, '30');
      await redis.expire(rateLimitKey, 60);

      // Spy on withUserContext - this is the database execution seam for requireWorkspace
      const withUserContextSpy = vi.spyOn(databaseModule, 'withUserContext');

      // Viewer is not an admin, so if requireWorkspace ran first, it would query DB and return 403.
      // But because rateLimiter runs before requireWorkspace, it returns 429 immediately and does NOT query DB.
      const res = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations`)
        .set('Authorization', `Bearer ${viewerToken}`)
        .send({ role: 'viewer' });

      expect(res.status).toBe(429);
      expect(res.body.error).toBe('Too many requests');

      // Prove that withUserContext was NOT called during this rate-limited request
      expect(withUserContextSpy).not.toHaveBeenCalled();

      withUserContextSpy.mockRestore();
      await redis.del(rateLimitKey);
    });

    it('rejects rate-limited invitation resend request with 429 without executing workspace_members database check', async () => {
      const redis = getRedisClient();
      const rateLimitKey = `rate:invitation-resend:${viewer.id}`;
      const fakeInvitationId = '550e8400-e29b-41d4-a716-446655440000';

      // Set redis count directly to threshold for viewer
      await redis.set(rateLimitKey, '30');
      await redis.expire(rateLimitKey, 60);

      const withUserContextSpy = vi.spyOn(databaseModule, 'withUserContext');

      const res = await request(app)
        .post(`/api/v1/workspaces/${workspaceId}/invitations/${fakeInvitationId}/resend`)
        .set('Authorization', `Bearer ${viewerToken}`);

      expect(res.status).toBe(429);
      expect(res.body.error).toBe('Too many requests');

      // Prove that withUserContext was NOT called during this rate-limited request
      expect(withUserContextSpy).not.toHaveBeenCalled();

      withUserContextSpy.mockRestore();
      await redis.del(rateLimitKey);
    });
  });
});
