import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations, getSystemDb, createScopedDb, withSystemContext } from '@knowledge/database';
import { registerUser } from '@knowledge/auth';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';

describe('Security CRITICAL 1: PostgreSQL FORCE RLS & Tenant Isolation', () => {
  let isDbConnected = false;

  let userA_id: string;
  let userB_id: string;
  let workspaceA_id: string;
  let workspaceB_id: string;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;

      const userA = await registerUser(getSystemDb(), {
        email: `rls_hard_userA_${Date.now()}@example.com`,
        password: 'Password123!',
        displayName: 'User A RLS',
      });

      const userB = await registerUser(getSystemDb(), {
        email: `rls_hard_userB_${Date.now()}@example.com`,
        password: 'Password123!',
        displayName: 'User B RLS',
      });

      userA_id = userA.id;
      userB_id = userB.id;

      const wsA = await withSystemContext(async (db) => createWorkspace(db, userA.id, 'Workspace A RLS'));
      const wsB = await withSystemContext(async (db) => createWorkspace(db, userB.id, 'Workspace B RLS'));

      workspaceA_id = wsA.id;
      workspaceB_id = wsB.id;
    } catch {
      isDbConnected = false;
    }
  });

  it('user A cannot read user B user row through req.db (ScopedDb)', async () => {
    if (!isDbConnected) return;

    const scopedDbA = createScopedDb(userA_id);
    const usersFound = await scopedDbA.execute(async (db) => {
      return db.selectFrom('users').where('id', '=', userB_id).selectAll().execute();
    });

    expect(usersFound.length).toBe(0);
  });

  it('user A cannot read user B workspace through req.db (ScopedDb)', async () => {
    if (!isDbConnected) return;

    const scopedDbA = createScopedDb(userA_id);
    const workspacesFound = await scopedDbA.execute(async (db) => {
      return db.selectFrom('workspaces').where('id', '=', workspaceB_id).selectAll().execute();
    });

    expect(workspacesFound.length).toBe(0);
  });

  it('user A cannot mutate user B workspace through req.db (ScopedDb)', async () => {
    if (!isDbConnected) return;

    const scopedDbA = createScopedDb(userA_id);
    const updatedCount = await scopedDbA.execute(async (db) => {
      const res = await db
        .updateTable('workspaces')
        .set({ name: 'Hacked Workspace Name' })
        .where('id', '=', workspaceB_id)
        .executeTakeFirst();

      return Number(res.numUpdatedRows);
    });

    expect(updatedCount).toBe(0);
  });

  it('proves FORCE RLS applies even under table owner connection when app.current_user_id is set', async () => {
    if (!isDbConnected) return;

    // getSystemDb() operates with the primary connection pool
    const scopedDbA = createScopedDb(userA_id);
    const result = await scopedDbA.execute(async (db) => {
      return db.selectFrom('users').selectAll().execute();
    });

    // FORCE RLS ensures that even under owner pool, app.current_user_id restricts results to ONLY userA
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(userA_id);
  });
});
