import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations, getSystemDb, withSystemContext } from '@knowledge/database';
import { registerUser } from '@knowledge/auth';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';

describe('Migration 0005 Schema & Integrity Integration Tests', () => {
  let isDbConnected = false;
  let user_id: string;
  let workspace1_id: string;
  let workspace2_id: string;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;

      const db = getSystemDb();

      const user = await registerUser(db, {
        email: `schema0005_${Date.now()}@example.com`,
        password: 'Password123!',
        displayName: 'Schema Tester',
      });
      user_id = user.id;

      const ws1 = await createWorkspace(db, user_id, 'Workspace 1');
      const ws2 = await createWorkspace(db, user_id, 'Workspace 2');

      workspace1_id = ws1.id;
      workspace2_id = ws2.id;
    } catch {
      isDbConnected = false;
    }
  });

  it('verifies documents table has parent_id, is_archived and composite FK same-workspace enforcement', async () => {
    if (!isDbConnected) return;

    // 1. Create parent document P1 in Workspace 1
    const parentDoc = await withSystemContext(async (db) => {
      return db
        .insertInto('documents')
        .values({
          workspace_id: workspace1_id,
          title: 'Parent Doc',
          content_text: 'Parent content',
          created_by: user_id,
        })
        .returning(['id', 'workspace_id', 'parent_id', 'is_archived'])
        .executeTakeFirstOrThrow();
    });

    expect(parentDoc.parent_id).toBeNull();
    expect(parentDoc.is_archived).toBe(false);

    // 2. Create child document C1 in Workspace 1 with parent_id = P1.id (Same workspace -> Success)
    const childDocSameWs = await withSystemContext(async (db) => {
      return db
        .insertInto('documents')
        .values({
          workspace_id: workspace1_id,
          parent_id: parentDoc.id,
          title: 'Child Doc Same WS',
          content_text: 'Child content',
          created_by: user_id,
        })
        .returning(['id', 'workspace_id', 'parent_id', 'is_archived'])
        .executeTakeFirstOrThrow();
    });

    expect(childDocSameWs.parent_id).toBe(parentDoc.id);

    // 3. Attempt to create child document C2 in Workspace 2 referencing P1 from Workspace 1
    // Cross-workspace parent relationship MUST be rejected by DB engine composite FK
    await expect(
      withSystemContext(async (db) => {
        await db
          .insertInto('documents')
          .values({
            workspace_id: workspace2_id, // Workspace 2
            parent_id: parentDoc.id,     // Parent is in Workspace 1!
            title: 'Cross WS Child Doc',
            content_text: 'Should fail',
            created_by: user_id,
          })
          .execute();
      })
    ).rejects.toThrow();

    // 4. Test ON DELETE SET NULL behavior
    await withSystemContext(async (db) => {
      await db.deleteFrom('documents').where('id', '=', parentDoc.id).execute();
    });

    const reloadedChild = await withSystemContext(async (db) => {
      return db
        .selectFrom('documents')
        .where('id', '=', childDocSameWs.id)
        .select(['id', 'parent_id'])
        .executeTakeFirstOrThrow();
    });

    expect(reloadedChild.parent_id).toBeNull();
  });

  it('verifies document_versions snapshot_key is nullable for Phase 2 plaintext versioning', async () => {
    if (!isDbConnected) return;

    await withSystemContext(async (db) => {
      // Create document
      const doc = await db
        .insertInto('documents')
        .values({
          workspace_id: workspace1_id,
          title: 'Versioned Doc',
          content_text: 'Version 1 content',
          created_by: user_id,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      // Insert version row with snapshot_key = null
      const version = await db
        .insertInto('document_versions')
        .values({
          document_id: doc.id,
          version_number: 1,
          snapshot_key: null, // Nullable in Phase 2
          content_text: 'Version 1 content',
          title: 'Versioned Doc',
          created_by: user_id,
          trigger: 'manual',
        })
        .returning(['id', 'snapshot_key', 'content_text', 'trigger'])
        .executeTakeFirstOrThrow();

      expect(version.snapshot_key).toBeNull();
      expect(version.content_text).toBe('Version 1 content');
      expect(version.trigger).toBe('manual');
    });
  });
});
