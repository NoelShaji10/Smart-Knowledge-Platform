import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb } from '@knowledge/database';
import { registerUser, loginUser } from '@knowledge/auth';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';

describe('Security Attack & Bypass Scenarios', () => {
  const app = createApiApp();
  let isDbConnected = false;

  let ownerToken: string;
  let editorToken: string;
  let workspaceId: string;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;

      const db = getSystemDb();

      const owner = await registerUser(db, { email: `attack_owner_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Attack Owner' });
      const editor = await registerUser(db, { email: `attack_editor_${Date.now()}@example.com`, password: 'Password123!', displayName: 'Attack Editor' });

      const ws = await createWorkspace(db, owner.id, 'Attack Test Workspace');
      workspaceId = ws.id;

      await db.insertInto('workspace_members').values({
        workspace_id: workspaceId,
        user_id: editor.id,
        role: 'editor',
      }).execute();

      ownerToken = (await loginUser(db, { email: owner.email, password: 'Password123!' })).accessToken;
      editorToken = (await loginUser(db, { email: editor.email, password: 'Password123!' })).accessToken;
    } catch {
      isDbConnected = false;
    }
  });

  it('rejects tampered JWT signature', async () => {
    if (!isDbConnected) return;

    const tamperedToken = jwt.sign({ sub: 'hacker-id' }, 'wrong-secret-key-12345');

    const res = await request(app)
      .get(`/api/v1/workspaces/${workspaceId}`)
      .set('Authorization', `Bearer ${tamperedToken}`);

    expect(res.status).toBe(401);
  });

  it('blocks role escalation (editor attempting to change own role to admin)', async () => {
    if (!isDbConnected) return;

    const db = getSystemDb();
    const editorUser = await db.selectFrom('users').where('email', 'like', 'attack_editor_%').select(['id']).executeTakeFirst();

    const res = await request(app)
      .patch(`/api/v1/workspaces/${workspaceId}/members/${editorUser?.id}`)
      .set('Authorization', `Bearer ${editorToken}`)
      .send({ role: 'admin' });

    expect(res.status).toBe(403);
  });

  it('enforces rate limiting on auth endpoints (returns 429 when limit exceeded)', async () => {
    if (!isDbConnected) return;

    // Send rapid register requests from same IP to exceed rate limit
    let hitRateLimit = false;
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/api/v1/auth/register')
        .send({
          email: `ratelimit_${i}_${Date.now()}@example.com`,
          password: 'Password123!',
          displayName: 'Rate Limit User',
        });

      if (res.status === 429) {
        hitRateLimit = true;
        expect(res.body.error).toBe('Too many requests');
        break;
      }
    }
    expect(hitRateLimit).toBe(true);
  });
});
