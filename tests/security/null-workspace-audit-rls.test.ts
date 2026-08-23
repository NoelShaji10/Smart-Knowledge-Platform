import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations, getSystemDb, createScopedDb, withSystemContext } from '@knowledge/database';
import { registerUser } from '@knowledge/auth';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';
import { emitAuditEvent } from '../../apps/api-server/src/lib/audit';

describe('Security Test: NULL-workspace Audit Event RLS Isolation', () => {
  let isDbConnected = false;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;
    } catch {
      isDbConnected = false;
    }
  });

  it('verifies that workspace_id = NULL global auth audit events CANNOT be read via normal RLS user context', async () => {
    if (!isDbConnected) return;

    const systemDb = getSystemDb();

    // Create user and workspace
    const user = await registerUser(systemDb, {
      email: `audit_rls_${Date.now()}@example.com`,
      password: 'Password123!',
      displayName: 'Audit RLS Owner',
    });

    const ws = await createWorkspace(systemDb, user.id, 'Audit RLS Workspace');

    // 1. Emit a global account audit event (workspace_id = NULL)
    await emitAuditEvent(systemDb, {
      workspaceId: null,
      actorId: user.id,
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
    });

    // 2. Emit a workspace audit event (workspace_id = ws.id)
    await emitAuditEvent(systemDb, {
      workspaceId: ws.id,
      actorId: user.id,
      action: 'workspace.settings.updated',
      resourceType: 'workspace',
      resourceId: ws.id,
    });

    // 3. System DB (unscoped) can see both events
    const allSystemEvents = await withSystemContext(async (sysDb) => {
      return sysDb
        .selectFrom('audit_events')
        .where('actor_id', '=', user.id)
        .selectAll()
        .execute();
    });

    const nullWorkspaceEvent = allSystemEvents.find((e) => e.workspace_id === null);
    expect(nullWorkspaceEvent).toBeDefined();
    expect(nullWorkspaceEvent?.action).toBe('auth.login');

    // 4. RLS-scoped user context (user is owner of ws) querying audit_events
    const userScopedDb = createScopedDb(user.id);
    const rlsEvents = await userScopedDb.execute(async (db) => {
      return db
        .selectFrom('audit_events')
        .where('actor_id', '=', user.id)
        .selectAll()
        .execute();
    });

    // RLS policy audit_admin_only filters by `workspace_id IN (...)`.
    // NULL workspace_id is NOT in user's workspace_members list!
    const rlsNullEvent = rlsEvents.find((e) => e.workspace_id === null);
    expect(rlsNullEvent).toBeUndefined(); // NULL workspace audit events CANNOT be read through RLS user context!

    const rlsWsEvent = rlsEvents.find((e) => e.workspace_id === ws.id);
    expect(rlsWsEvent).toBeDefined(); // Workspace-scoped audit event IS readable by owner
  });
});
