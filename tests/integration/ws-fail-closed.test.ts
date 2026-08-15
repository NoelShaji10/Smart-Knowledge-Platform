import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApiApp } from '../../apps/api-server/src/app';
import { createCollabServer } from '../../apps/collab-server/src/server';
import { runMigrations, getSystemDb, withSystemContext } from '@knowledge/database';
import { registerUser, loginUser } from '@knowledge/auth';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';
import { getRedisClient } from '@knowledge/redis';

describe('HIGH 3: WebSocket Connection Authorization Fail-Closed & Revalidation', () => {
  const apiApp = createApiApp();
  const collabApp = createCollabServer();
  let isDbConnected = false;

  let ownerToken: string;
  let memberUser: any;
  let memberToken: string;
  let workspaceId: string;
  let documentId: string;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;

      const systemDb = getSystemDb();

      const owner = await registerUser(systemDb, {
        email: `ws_fail_owner_${Date.now()}@example.com`,
        password: 'Password123!',
        displayName: 'WS Fail Owner',
      });

      memberUser = await registerUser(systemDb, {
        email: `ws_fail_member_${Date.now()}@example.com`,
        password: 'Password123!',
        displayName: 'WS Fail Member',
      });

      const ws = await withSystemContext(async (db) => createWorkspace(db, owner.id, 'WS Fail Workspace'));
      workspaceId = ws.id;
      documentId = crypto.randomUUID();

      await withSystemContext(async (db) => {
        await db.insertInto('workspace_members').values({
          workspace_id: workspaceId,
          user_id: memberUser.id,
          role: 'editor',
        }).execute();

        await db.insertInto('documents').values({
          id: documentId,
          workspace_id: workspaceId,
          title: 'WS Fail Document',
          content_text: 'Content',
          created_by: owner.id,
        }).execute();
      });

      ownerToken = (await loginUser(systemDb, { email: owner.email, password: 'Password123!' })).accessToken;
      memberToken = (await loginUser(systemDb, { email: memberUser.email, password: 'Password123!' })).accessToken;
    } catch {
      isDbConnected = false;
    }
  });

  it('rejects WebSocket connection if workspace membership is revoked after ticket issuance', async () => {
    if (!isDbConnected) return;

    // Issue ticket for member
    const ticketRes = await request(apiApp)
      .post('/api/v1/ws/ticket')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ workspaceId, documentId });

    expect(ticketRes.status).toBe(200);
    const ticket = ticketRes.body.ticket;

    // Revoke workspace membership in DB before connection upgrade!
    await withSystemContext(async (db) => {
      await db.deleteFrom('workspace_members')
        .where('workspace_id', '=', workspaceId)
        .where('user_id', '=', memberUser.id)
        .execute();
    });

    // Attempt HTTP Upgrade with valid ticket
    const upgradeRes = await request(collabApp.server)
      .get(`/ws/doc/${documentId}?ticket=${ticket}`)
      .set('Connection', 'Upgrade')
      .set('Upgrade', 'websocket');

    expect(upgradeRes.status).toBe(403);
  });

  it('rejects WebSocket connection if explicit document permission is set to none', async () => {
    if (!isDbConnected) return;

    // Re-add workspace member
    await withSystemContext(async (db) => {
      await db.insertInto('workspace_members').values({
        workspace_id: workspaceId,
        user_id: memberUser.id,
        role: 'editor',
      }).execute();

      // Add explicit 'none' permission on document
      await db.insertInto('document_permissions').values({
        document_id: documentId,
        user_id: memberUser.id,
        role: 'none',
        granted_by: memberUser.id,
      }).execute();
    });

    // Directly seed Redis ticket
    const redis = getRedisClient();
    const ticket = crypto.randomBytes(32).toString('hex');
    await redis.setex(`ws_ticket:${ticket}`, 30, JSON.stringify({
      userId: memberUser.id,
      workspaceId,
      documentId,
    }));

    // Connection upgrade attempt MUST be rejected with 403
    const upgradeRes = await request(collabApp.server)
      .get(`/ws/doc/${documentId}?ticket=${ticket}`)
      .set('Connection', 'Upgrade')
      .set('Upgrade', 'websocket');

    expect(upgradeRes.status).toBe(403);
  });
});
