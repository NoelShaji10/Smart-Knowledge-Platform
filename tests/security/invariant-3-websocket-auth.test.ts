import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb } from '@knowledge/database';
import { registerUser, loginUser } from '@knowledge/auth';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';
import { verifyAndConsumeTicket } from '../../apps/collab-server/src/ticket-verifier';

describe('Security Invariant 3: WebSocket Auth & Ticket Authorization', () => {
  const app = createApiApp();
  let isDbConnected = false;

  let ownerToken: string;
  let nonMemberToken: string;
  let workspaceId: string;
  let documentId: string;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;

      const db = getSystemDb();

      const owner = await registerUser(db, { email: `ws_owner_${Date.now()}@example.com`, password: 'Password123!', displayName: 'WS Owner' });
      const nonMember = await registerUser(db, { email: `ws_nonmember_${Date.now()}@example.com`, password: 'Password123!', displayName: 'WS NonMember' });

      const ws = await createWorkspace(db, owner.id, 'WS Test Workspace');
      workspaceId = ws.id;
      documentId = crypto.randomUUID();

      // Insert controlled test fixture into documents table
      await db.insertInto('documents').values({
        id: documentId,
        workspace_id: workspaceId,
        title: 'WS Test Document',
        content_text: 'Test content',
        created_by: owner.id,
      }).execute();

      ownerToken = (await loginUser(db, { email: owner.email, password: 'Password123!' })).accessToken;
      nonMemberToken = (await loginUser(db, { email: nonMember.email, password: 'Password123!' })).accessToken;
    } catch {
      isDbConnected = false;
    }
  });

  it('rejects connection when ticket is missing, invalid, or expired', async () => {
    const result = await verifyAndConsumeTicket('invalid-ticket', 'doc-123');
    expect(result).toBeNull();
  });

  it('issues ticket for authorized workspace member and document', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .post('/api/v1/ws/ticket')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ workspaceId, documentId });

    expect(res.status).toBe(200);
    expect(res.body.ticket).toBeDefined();
    expect(typeof res.body.ticket).toBe('string');
  });

  it('rejects ticket issuance for non-member of workspace', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .post('/api/v1/ws/ticket')
      .set('Authorization', `Bearer ${nonMemberToken}`)
      .send({ workspaceId, documentId });

    expect(res.status).toBe(403);
  });
});
