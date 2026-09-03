import crypto from 'crypto';
import { Kysely } from 'kysely';
import { Database, ScopedDb, withSystemContext } from '@knowledge/database';
import { WorkspaceRole } from '@knowledge/types';

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function createWorkspace(
  db: ScopedDb | Kysely<Database>,
  userId: string,
  name: string,
) {
  const baseSlug = slugify(name) || 'workspace';
  const uniqueSlug = `${baseSlug}-${crypto.randomBytes(4).toString('hex')}`;
  const workspaceId = crypto.randomUUID();

  return withSystemContext(async (systemDb) => {
    const workspace = await systemDb
      .insertInto('workspaces')
      .values({
        id: workspaceId,
        name: name.trim(),
        slug: uniqueSlug,
        settings: '{}',
      })
      .returning(['id', 'name', 'slug', 'settings', 'created_at'])
      .executeTakeFirstOrThrow();

    await systemDb
      .insertInto('workspace_members')
      .values({
        workspace_id: workspace.id,
        user_id: userId,
        role: 'owner',
      })
      .execute();

    return workspace;
  });
}

export async function getUserWorkspaces(scopedDb: ScopedDb) {
  return scopedDb.execute(async (db) => {
    return db
      .selectFrom('workspaces')
      .innerJoin('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
      .where('workspace_members.user_id', '=', scopedDb.userId)
      .select([
        'workspaces.id',
        'workspaces.name',
        'workspaces.slug',
        'workspaces.settings',
        'workspace_members.role',
        'workspaces.created_at',
      ])
      .execute();
  });
}

export async function getWorkspaceById(scopedDb: ScopedDb, workspaceId: string) {
  return scopedDb.execute(async (db) => {
    return db
      .selectFrom('workspaces')
      .where('id', '=', workspaceId)
      .selectAll()
      .executeTakeFirst();
  });
}

export async function updateWorkspace(
  scopedDb: ScopedDb,
  workspaceId: string,
  updates: { name?: string; settings?: Record<string, unknown> },
) {
  return scopedDb.execute(async (db) => {
    const setValues: Record<string, unknown> = {
      updated_at: new Date(),
    };
    if (updates.name) setValues.name = updates.name.trim();
    if (updates.settings) setValues.settings = JSON.stringify(updates.settings);

    return db
      .updateTable('workspaces')
      .set(setValues)
      .where('id', '=', workspaceId)
      .returning(['id', 'name', 'slug', 'settings', 'updated_at'])
      .executeTakeFirst();
  });
}

export async function deleteWorkspace(scopedDb: ScopedDb, workspaceId: string) {
  return scopedDb.execute(async (db) => {
    await db.deleteFrom('workspaces').where('id', '=', workspaceId).execute();
  });
}

export async function getWorkspaceMembers(scopedDb: ScopedDb, workspaceId: string) {
  return scopedDb.execute(async (db) => {
    return db
      .selectFrom('workspace_members')
      .innerJoin('users', 'users.id', 'workspace_members.user_id')
      .where('workspace_members.workspace_id', '=', workspaceId)
      .select([
        'users.id',
        'users.email',
        'users.display_name',
        'users.avatar_url',
        'workspace_members.role',
        'workspace_members.created_at',
      ])
      .execute();
  });
}

export async function addWorkspaceMember(
  scopedDb: ScopedDb,
  workspaceId: string,
  email: string,
  role: WorkspaceRole,
) {
  return scopedDb.execute(async (db) => {
    const user = await db
      .selectFrom('users')
      .where('email', '=', email.trim().toLowerCase())
      .select(['id', 'email', 'display_name'])
      .executeTakeFirst();

    if (!user) {
      throw new Error('User not found with provided email');
    }

    const existing = await db
      .selectFrom('workspace_members')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', user.id)
      .select(['role'])
      .executeTakeFirst();

    if (existing) {
      throw new Error('User is already a member of this workspace');
    }

    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: workspaceId,
        user_id: user.id,
        role,
      })
      .execute();

    return { user, role };
  });
}

export async function changeWorkspaceMemberRole(
  scopedDb: ScopedDb,
  workspaceId: string,
  targetUserId: string,
  newRole: WorkspaceRole,
  actorRole: WorkspaceRole,
) {
  return scopedDb.execute(async (db) => {
    const targetMember = await db
      .selectFrom('workspace_members')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', targetUserId)
      .select(['role'])
      .executeTakeFirst();

    if (!targetMember) {
      throw new Error('Member not found');
    }

    if (targetMember.role === 'owner') {
      throw new Error('Cannot change the role of the workspace owner');
    }

    if (newRole === 'owner') {
      throw new Error('Cannot promote member to owner. Ownership transfer is a separate operation.');
    }

    // HIGH 4 RBAC Escalation Fix: Admin cannot modify an admin or assign admin role
    if (actorRole === 'admin' && (targetMember.role === 'admin' || newRole === 'admin')) {
      throw new Error('Only the workspace owner can modify or assign admin memberships');
    }

    await db
      .updateTable('workspace_members')
      .set({ role: newRole })
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', targetUserId)
      .execute();

    return { userId: targetUserId, role: newRole };
  });
}

export async function removeWorkspaceMember(
  scopedDb: ScopedDb,
  workspaceId: string,
  targetUserId: string,
  actorUserId: string,
) {
  return scopedDb.execute(async (db) => {
    const targetMember = await db
      .selectFrom('workspace_members')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', targetUserId)
      .select(['role'])
      .executeTakeFirst();

    if (!targetMember) {
      throw new Error('Member not found');
    }

    if (targetMember.role === 'owner') {
      throw new Error('Cannot remove the workspace owner from the workspace');
    }

    // HIGH 4 RBAC Escalation Fix: Only owner can remove an admin (unless admin removing self)
    if (actorUserId !== targetUserId && targetMember.role === 'admin') {
      const actorMember = await db
        .selectFrom('workspace_members')
        .where('workspace_id', '=', workspaceId)
        .where('user_id', '=', actorUserId)
        .select(['role'])
        .executeTakeFirst();

      if (actorMember?.role !== 'owner') {
        throw new Error('Only the workspace owner can remove an admin');
      }
    }

    await db
      .deleteFrom('workspace_members')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', targetUserId)
      .execute();
  });
}
