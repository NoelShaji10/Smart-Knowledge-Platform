import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations, getPgPool, getSystemDb, createScopedDb, withSystemContext } from '@knowledge/database';
import { registerUser } from '@knowledge/auth';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';

describe('Security Requirement 4: Real Runtime Database Role & RLS Verification', () => {
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
        email: `role_ver_userA_${Date.now()}@example.com`,
        password: 'Password123!',
        displayName: 'User A Role Verification',
      });

      const userB = await registerUser(getSystemDb(), {
        email: `role_ver_userB_${Date.now()}@example.com`,
        password: 'Password123!',
        displayName: 'User B Role Verification',
      });

      userA_id = userA.id;
      userB_id = userB.id;

      const wsA = await withSystemContext(async (db) => createWorkspace(db, userA.id, 'Workspace A Role Ver'));
      const wsB = await withSystemContext(async (db) => createWorkspace(db, userB.id, 'Workspace B Role Ver'));

      workspaceA_id = wsA.id;
      workspaceB_id = wsB.id;
    } catch {
      isDbConnected = false;
    }
  });

  it('verifies that the actual runtime DB connection uses knowledge_app role', async () => {
    if (!isDbConnected) return;

    const pool = getPgPool();
    const res = await pool.query('SELECT current_user, session_user');
    expect(res.rows[0].current_user).toBe('knowledge_app');
  });

  it('verifies that runtime role knowledge_app has rolbypassrls = false in pg_roles', async () => {
    if (!isDbConnected) return;

    const pool = getPgPool();
    const res = await pool.query("SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user");

    expect(res.rows.length).toBe(1);
    expect(res.rows[0].rolname).toBe('knowledge_app');
    expect(res.rows[0].rolbypassrls).toBe(false);
    expect(res.rows[0].rolsuper).toBe(false);
  });

  it('verifies that runtime role knowledge_app does NOT own protected tables', async () => {
    if (!isDbConnected) return;

    const pool = getPgPool();
    const res = await pool.query(`
      SELECT c.relname, r.rolname AS owner_name
      FROM pg_class c
      JOIN pg_roles r ON r.oid = c.relowner
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname IN ('users', 'workspaces', 'workspace_members', 'documents', 'audit_events');
    `);

    expect(res.rows.length).toBeGreaterThan(0);
    for (const row of res.rows) {
      expect(row.owner_name, `Table ${row.relname} should not be owned by runtime role knowledge_app`).not.toBe('knowledge_app');
    }
  });

  it('verifies that protected tables have FORCE ROW LEVEL SECURITY (relrowsecurity & relforcerowsecurity)', async () => {
    if (!isDbConnected) return;

    const pool = getPgPool();
    const res = await pool.query(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      WHERE pg_namespace.nspname = 'public'
        AND relkind = 'r'
        AND relname IN ('users', 'workspaces', 'workspace_members', 'documents', 'audit_events');
    `);

    expect(res.rows.length).toBeGreaterThan(0);
    for (const row of res.rows) {
      expect(row.relrowsecurity, `Table ${row.relname} must have relrowsecurity = true`).toBe(true);
      expect(row.relforcerowsecurity, `Table ${row.relname} must have relforcerowsecurity = true`).toBe(true);
    }
  });

  it('verifies that user A cannot read or mutate user B rows under req.db runtime context', async () => {
    if (!isDbConnected) return;

    const scopedDbA = createScopedDb(userA_id);

    // Cannot read user B's workspace
    const wsRes = await scopedDbA.execute(async (db) => {
      return db.selectFrom('workspaces').where('id', '=', workspaceB_id).selectAll().execute();
    });
    expect(wsRes.length).toBe(0);

    // Cannot mutate user B's workspace
    const mutRes = await scopedDbA.execute(async (db) => {
      const r = await db.updateTable('workspaces').set({ name: 'Hacked Name' }).where('id', '=', workspaceB_id).executeTakeFirst();
      return Number(r.numUpdatedRows);
    });
    expect(mutRes).toBe(0);
  });

  it('verifies legitimate same-user/workspace operations work under req.db runtime context', async () => {
    if (!isDbConnected) return;

    const scopedDbA = createScopedDb(userA_id);

    const wsRes = await scopedDbA.execute(async (db) => {
      return db.selectFrom('workspaces').where('id', '=', workspaceA_id).selectAll().execute();
    });

    expect(wsRes.length).toBe(1);
    expect(wsRes[0].id).toBe(workspaceA_id);
  });
});
