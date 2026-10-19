import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations, getSystemDb, createScopedDb, withSystemContext } from '@knowledge/database';
import { registerUser } from '@knowledge/auth';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';
import {
  createInvitation,
  listWorkspaceInvitations,
  revokeWorkspaceInvitation,
  resendWorkspaceInvitation,
  resolveInvitationToken,
  acceptInvitation,
  hashInvitationToken,
  InvalidInvitationRoleError,
  InvalidInvitationEmailError,
  AdminPrivilegeEscalationError,
  UnauthorizedInvitationError,
  UserAlreadyMemberError,
  InvitationNotFoundError,
  ExpiredInvitationError,
  RevokedInvitationError,
  AlreadyAcceptedError,
  EmailMismatchError,
  UnverifiedEmailError,
} from '../../apps/api-server/src/lib/invitation-service';

describe('Workspace Invitations Service & Security Integration Tests', () => {
  let owner: { id: string; email: string };
  let admin: { id: string; email: string };
  let editor: { id: string; email: string };
  let viewer: { id: string; email: string };
  let externalUserA: { id: string; email: string };
  let externalUserB: { id: string; email: string };
  let workspaceId: string;
  let otherWorkspaceId: string;

  beforeAll(async () => {
    // Run all database migrations (including 0010_workspace_invitations.sql)
    await runMigrations();

    const db = getSystemDb();
    const timestamp = Date.now();

    // Register users
    owner = await registerUser(db, {
      email: `inv_owner_${timestamp}@example.com`,
      password: 'Password123!',
      displayName: 'Inv Owner',
    });
    admin = await registerUser(db, {
      email: `inv_admin_${timestamp}@example.com`,
      password: 'Password123!',
      displayName: 'Inv Admin',
    });
    editor = await registerUser(db, {
      email: `inv_editor_${timestamp}@example.com`,
      password: 'Password123!',
      displayName: 'Inv Editor',
    });
    viewer = await registerUser(db, {
      email: `inv_viewer_${timestamp}@example.com`,
      password: 'Password123!',
      displayName: 'Inv Viewer',
    });
    externalUserA = await registerUser(db, {
      email: `inv_userA_${timestamp}@example.com`,
      password: 'Password123!',
      displayName: 'External User A',
    });
    externalUserB = await registerUser(db, {
      email: `inv_userB_${timestamp}@example.com`,
      password: 'Password123!',
      displayName: 'External User B',
    });

    // Create primary test workspace owned by owner
    const ws = await createWorkspace(db, owner.id, 'Invitations Test Workspace');
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

    // Create secondary workspace for cross-workspace testing
    const otherWs = await createWorkspace(db, owner.id, 'Other Isolated Workspace');
    otherWorkspaceId = otherWs.id;
  });

  describe('1. Creation and Authorization Controls', () => {
    it('allows Workspace Owner to create Admin, Editor, and Viewer invitations', async () => {
      const scopedDb = createScopedDb(owner.id);

      // Owner creates Admin invite
      const adminInvite = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'admin',
      });
      expect(adminInvite.invitation.role).toBe('admin');
      expect(adminInvite.rawToken).toBeDefined();

      // Owner creates Editor invite
      const editorInvite = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'editor',
      });
      expect(editorInvite.invitation.role).toBe('editor');

      // Owner creates Viewer invite
      const viewerInvite = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'viewer',
      });
      expect(viewerInvite.invitation.role).toBe('viewer');
    });

    it('allows Workspace Admin to create Editor and Viewer invitations', async () => {
      const scopedDb = createScopedDb(admin.id);

      const editorInvite = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: admin.id,
        role: 'editor',
      });
      expect(editorInvite.invitation.role).toBe('editor');

      const viewerInvite = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: admin.id,
        role: 'viewer',
      });
      expect(viewerInvite.invitation.role).toBe('viewer');
    });

    it('strictly prevents Workspace Admin from creating Admin invitations (escalation guard)', async () => {
      const scopedDb = createScopedDb(admin.id);

      await expect(
        createInvitation(scopedDb, {
          workspaceId,
          inviterId: admin.id,
          role: 'admin',
        }),
      ).rejects.toThrow(AdminPrivilegeEscalationError);
    });

    it('strictly prevents any caller from creating Owner invitations', async () => {
      const scopedDb = createScopedDb(owner.id);

      await expect(
        createInvitation(scopedDb, {
          workspaceId,
          inviterId: owner.id,
          role: 'owner' as any,
        }),
      ).rejects.toThrow(InvalidInvitationRoleError);
    });

    it('strictly blocks Editor and Viewer from creating invitations', async () => {
      const editorScopedDb = createScopedDb(editor.id);
      await expect(
        createInvitation(editorScopedDb, {
          workspaceId,
          inviterId: editor.id,
          role: 'viewer',
        }),
      ).rejects.toThrow(UnauthorizedInvitationError);

      const viewerScopedDb = createScopedDb(viewer.id);
      await expect(
        createInvitation(viewerScopedDb, {
          workspaceId,
          inviterId: viewer.id,
          role: 'viewer',
        }),
      ).rejects.toThrow(UnauthorizedInvitationError);
    });

    it('enforces default 7-day expiration and consistent email normalization', async () => {
      const scopedDb = createScopedDb(owner.id);
      const emailInput = '  UPPERCASE_User@Example.COM  ';

      const before = Date.now();
      const res = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'editor',
        email: emailInput,
      });

      expect(res.invitation.invitee_email).toBe('uppercase_user@example.com');
      const expectedMinExpiry = before + 6 * 24 * 60 * 60 * 1000;
      const expectedMaxExpiry = before + 8 * 24 * 60 * 60 * 1000;
      const expiryTime = new Date(res.invitation.expires_at).getTime();
      expect(expiryTime).toBeGreaterThan(expectedMinExpiry);
      expect(expiryTime).toBeLessThan(expectedMaxExpiry);
    });

    it('rejects malformed invitation emails', async () => {
      const scopedDb = createScopedDb(owner.id);

      await expect(
        createInvitation(scopedDb, {
          workspaceId,
          inviterId: owner.id,
          role: 'editor',
          email: 'not-an-email',
        }),
      ).rejects.toThrow(InvalidInvitationEmailError);
    });

    it('stores token hash in the database, never the raw secret', async () => {
      const scopedDb = createScopedDb(owner.id);
      const { invitation, rawToken } = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'viewer',
      });

      const row = await withSystemContext(async (sysDb) => {
        return sysDb
          .selectFrom('workspace_invitations')
          .where('id', '=', invitation.id)
          .select(['token_hash'])
          .executeTakeFirstOrThrow();
      });

      // Raw token must never equal the stored hash
      expect(row.token_hash).not.toBe(rawToken);
      // Hash of raw token must exactly match stored hash
      expect(row.token_hash).toBe(hashInvitationToken(rawToken));
    });

    it('prevents creating invitations for users who are already workspace members', async () => {
      const scopedDb = createScopedDb(owner.id);

      await expect(
        createInvitation(scopedDb, {
          workspaceId,
          inviterId: owner.id,
          role: 'editor',
          email: editor.email, // already an editor in workspace
        }),
      ).rejects.toThrow(UserAlreadyMemberError);
    });
  });

  describe('2. Listing, Revocation, and Resend Lifecycle', () => {
    it('lists workspace invitations without leaking raw secrets or token hashes', async () => {
      const scopedDb = createScopedDb(owner.id);
      const list = await listWorkspaceInvitations(scopedDb, workspaceId, owner.id);

      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);

      for (const item of list) {
        expect(item).not.toHaveProperty('token_hash');
        expect(item).not.toHaveProperty('rawToken');
        expect(item.workspace_id).toBe(workspaceId);
      }
    });

    it('blocks non-admin members from listing invitations', async () => {
      const scopedDb = createScopedDb(editor.id);
      await expect(
        listWorkspaceInvitations(scopedDb, workspaceId, editor.id),
      ).rejects.toThrow(UnauthorizedInvitationError);
    });

    it('allows revoking a pending invitation and blocks non-admins from revoking', async () => {
      const ownerScopedDb = createScopedDb(owner.id);
      const { invitation, rawToken } = await createInvitation(ownerScopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'viewer',
      });

      // Editor cannot revoke
      const editorScopedDb = createScopedDb(editor.id);
      await expect(
        revokeWorkspaceInvitation(editorScopedDb, workspaceId, invitation.id, editor.id),
      ).rejects.toThrow(UnauthorizedInvitationError);

      // Owner can revoke
      const res = await revokeWorkspaceInvitation(ownerScopedDb, workspaceId, invitation.id, owner.id);
      expect(res.ok).toBe(true);

      // Attempting to resolve or accept revoked token fails
      await expect(resolveInvitationToken(rawToken)).rejects.toThrow(RevokedInvitationError);
      await expect(
        acceptInvitation(rawToken, { userId: externalUserA.id, email: externalUserA.email }),
      ).rejects.toThrow(RevokedInvitationError);
    });

    it('resends an invitation by invalidating the prior token and issuing a fresh one', async () => {
      const ownerScopedDb = createScopedDb(owner.id);
      const initial = await createInvitation(ownerScopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'editor',
      });

      const resent = await resendWorkspaceInvitation(ownerScopedDb, workspaceId, initial.invitation.id, owner.id);

      // New token must be different from old token
      expect(resent.rawToken).not.toBe(initial.rawToken);
      expect(resent.invitation.id).not.toBe(initial.invitation.id);

      // Prior token is now revoked
      await expect(resolveInvitationToken(initial.rawToken)).rejects.toThrow(RevokedInvitationError);

      // New token resolves successfully
      const resolved = await resolveInvitationToken(resent.rawToken);
      expect(resolved.workspaceName).toBe('Invitations Test Workspace');
      expect(resolved.role).toBe('editor');
    });
  });

  describe('3. Public Resolution and Token Safety', () => {
    it('resolves valid invitation token to sanitized public metadata without consuming it', async () => {
      const scopedDb = createScopedDb(owner.id);
      const { rawToken } = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'viewer',
      });

      const details = await resolveInvitationToken(rawToken);
      expect(details.workspaceName).toBe('Invitations Test Workspace');
      expect(details.role).toBe('viewer');
      expect(details.isEmailBound).toBe(false);
      expect(details.maskedEmail).toBeNull();
      expect(details).not.toHaveProperty('token_hash');
      expect(details).not.toHaveProperty('invitationId');
    });

    it('correctly reports masked email for email-bound invitations', async () => {
      const scopedDb = createScopedDb(owner.id);
      const { rawToken } = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'editor',
        email: 'secret_recipient@example.com',
      });

      const details = await resolveInvitationToken(rawToken);
      expect(details.isEmailBound).toBe(true);
      expect(details.maskedEmail).toBe('s***t@example.com');
      expect(details.maskedEmail).not.toBe('secret_recipient@example.com');
    });

    it('rejects invalid or unknown tokens safely', async () => {
      await expect(resolveInvitationToken('completely_invalid_token')).rejects.toThrow(InvitationNotFoundError);
    });

    it('rejects expired invitation tokens', async () => {
      const scopedDb = createScopedDb(owner.id);
      const { invitation, rawToken } = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'viewer',
      });

      // Manually simulate expiration in DB
      await withSystemContext(async (sysDb) => {
        await sysDb
          .updateTable('workspace_invitations')
          .set({ expires_at: new Date(Date.now() - 10000) })
          .where('id', '=', invitation.id)
          .execute();
      });

      await expect(resolveInvitationToken(rawToken)).rejects.toThrow(ExpiredInvitationError);
      await expect(
        acceptInvitation(rawToken, { userId: externalUserA.id, email: externalUserA.email }),
      ).rejects.toThrow(ExpiredInvitationError);
    });
  });

  describe('4. Acceptance and Role Enforcement', () => {
    it('successfully accepts shareable invitation and assigns exact role', async () => {
      const scopedDb = createScopedDb(owner.id);
      const { rawToken } = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'editor',
      });

      const result = await acceptInvitation(rawToken, {
        userId: externalUserA.id,
        email: externalUserA.email,
      });

      expect(result.status).toBe('accepted');
      expect(result.workspaceId).toBe(workspaceId);
      expect(result.role).toBe('editor');

      // Verify PostgreSQL record in workspace_members
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

      // Second acceptance of single-use link is rejected with AlreadyAcceptedError
      await expect(
        acceptInvitation(rawToken, {
          userId: externalUserB.id,
          email: externalUserB.email,
        }),
      ).rejects.toThrow(AlreadyAcceptedError);
    });

    it('successfully accepts email-bound invitation when email is verified and matches', async () => {
      const scopedDb = createScopedDb(owner.id);
      const targetEmail = `bound_verified_${Date.now()}@example.com`;

      const { rawToken } = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'viewer',
        email: targetEmail,
      });

      const sysDb = getSystemDb();
      const matchingUser = await registerUser(sysDb, {
        email: targetEmail,
        password: 'Password123!',
        displayName: 'Matching User',
      });

      const result = await acceptInvitation(rawToken, {
        userId: matchingUser.id,
        email: matchingUser.email,
        emailVerified: true,
      });

      expect(result.status).toBe('accepted');
      expect(result.role).toBe('viewer');

      // Verify PostgreSQL record in workspace_members
      const member = await withSystemContext(async (sDb) => {
        return sDb
          .selectFrom('workspace_members')
          .where('workspace_id', '=', workspaceId)
          .where('user_id', '=', matchingUser.id)
          .select(['role'])
          .executeTakeFirst();
      });
      expect(member).toBeDefined();
      expect(member?.role).toBe('viewer');
    });

    it('rejects email-bound invitation acceptance when email is explicitly unverified (false)', async () => {
      const scopedDb = createScopedDb(owner.id);
      const targetEmail = `bound_unverified_${Date.now()}@example.com`;

      const { rawToken } = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'viewer',
        email: targetEmail,
      });

      const db = getSystemDb();
      const unverifiedUser = await registerUser(db, {
        email: targetEmail,
        password: 'Password123!',
        displayName: 'Unverified User',
      });

      await expect(
        acceptInvitation(rawToken, {
          userId: unverifiedUser.id,
          email: unverifiedUser.email,
          emailVerified: false,
        }),
      ).rejects.toThrow(UnverifiedEmailError);
    });

    it('rejects email-bound invitation acceptance when verification status is missing or undefined', async () => {
      const scopedDb = createScopedDb(owner.id);
      const targetEmail = `bound_missing_${Date.now()}@example.com`;

      const { rawToken } = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'viewer',
        email: targetEmail,
      });

      const sysDb = getSystemDb();
      const targetUser = await registerUser(sysDb, {
        email: targetEmail,
        password: 'Password123!',
        displayName: 'Missing Status User',
      });

      // 1. Missing property entirely
      await expect(
        acceptInvitation(rawToken, {
          userId: targetUser.id,
          email: targetUser.email,
        }),
      ).rejects.toThrow(UnverifiedEmailError);

      // 2. Explicitly undefined
      await expect(
        acceptInvitation(rawToken, {
          userId: targetUser.id,
          email: targetUser.email,
          emailVerified: undefined,
        }),
      ).rejects.toThrow(UnverifiedEmailError);
    });

    it('rejects email-bound invitation acceptance when verification status is null or malformed', async () => {
      const scopedDb = createScopedDb(owner.id);
      const targetEmail = `bound_malformed_${Date.now()}@example.com`;

      const { rawToken } = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'editor',
        email: targetEmail,
      });

      const sysDb = getSystemDb();
      const targetUser = await registerUser(sysDb, {
        email: targetEmail,
        password: 'Password123!',
        displayName: 'Malformed Status User',
      });

      // Null
      await expect(
        acceptInvitation(rawToken, {
          userId: targetUser.id,
          email: targetUser.email,
          emailVerified: null as any,
        }),
      ).rejects.toThrow(UnverifiedEmailError);

      // String "true"
      await expect(
        acceptInvitation(rawToken, {
          userId: targetUser.id,
          email: targetUser.email,
          emailVerified: 'true' as any,
        }),
      ).rejects.toThrow(UnverifiedEmailError);

      // Number 1
      await expect(
        acceptInvitation(rawToken, {
          userId: targetUser.id,
          email: targetUser.email,
          emailVerified: 1 as any,
        }),
      ).rejects.toThrow(UnverifiedEmailError);

      // Object {}
      await expect(
        acceptInvitation(rawToken, {
          userId: targetUser.id,
          email: targetUser.email,
          emailVerified: {} as any,
        }),
      ).rejects.toThrow(UnverifiedEmailError);
    });

    it('rejects email-bound invitation acceptance on verified email mismatch', async () => {
      const scopedDb = createScopedDb(owner.id);
      const targetEmail = `bound_target_${Date.now()}@example.com`;

      const { rawToken } = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'viewer',
        email: targetEmail,
      });

      // External User B has verified email, but does NOT match targetEmail
      await expect(
        acceptInvitation(rawToken, {
          userId: externalUserB.id,
          email: externalUserB.email,
          emailVerified: true,
        }),
      ).rejects.toThrow(EmailMismatchError);

      // Verify External User B was NOT added
      const memberB = await withSystemContext(async (sysDb) => {
        return sysDb
          .selectFrom('workspace_members')
          .where('workspace_id', '=', workspaceId)
          .where('user_id', '=', externalUserB.id)
          .select(['role'])
          .executeTakeFirst();
      });
      expect(memberB).toBeUndefined();
    });

    it('verification failure leaves invitation pending and creates no membership', async () => {
      const scopedDb = createScopedDb(owner.id);
      const targetEmail = `bound_pending_check_${Date.now()}@example.com`;

      const { invitation, rawToken } = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'viewer',
        email: targetEmail,
      });

      const sysDb = getSystemDb();
      const candidateUser = await registerUser(sysDb, {
        email: targetEmail,
        password: 'Password123!',
        displayName: 'Candidate User',
      });

      // Attempt acceptance with missing verification
      await expect(
        acceptInvitation(rawToken, {
          userId: candidateUser.id,
          email: candidateUser.email,
          // emailVerified omitted
        }),
      ).rejects.toThrow(UnverifiedEmailError);

      // 1. Verify invitation is still pending in PostgreSQL
      const invRow = await withSystemContext(async (sDb) => {
        return sDb
          .selectFrom('workspace_invitations')
          .where('id', '=', invitation.id)
          .select(['status', 'accepted_by', 'accepted_at'])
          .executeTakeFirst();
      });
      expect(invRow?.status).toBe('pending');
      expect(invRow?.accepted_by).toBeNull();
      expect(invRow?.accepted_at).toBeNull();

      // 2. Verify candidate user was NOT added to workspace_members
      const candidateMember = await withSystemContext(async (sDb) => {
        return sDb
          .selectFrom('workspace_members')
          .where('workspace_id', '=', workspaceId)
          .where('user_id', '=', candidateUser.id)
          .select(['role'])
          .executeTakeFirst();
      });
      expect(candidateMember).toBeUndefined();

      // 3. Verify public token resolution still works and returns pending status
      const resolved = await resolveInvitationToken(rawToken);
      expect(resolved.workspaceName).toBe('Invitations Test Workspace');
      expect(resolved.role).toBe('viewer');
    });

    it('handles acceptance gracefully when user is already a member without modifying role or consuming invite', async () => {
      const scopedDb = createScopedDb(owner.id);
      // Admin invites as 'admin', but editor attempts to accept
      const { rawToken } = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'admin',
      });

      // Editor accepts: should detect existing membership
      const result = await acceptInvitation(rawToken, {
        userId: editor.id,
        email: editor.email,
      });

      expect(result.status).toBe('already_member');
      expect(result.role).toBe('editor'); // Kept existing role, did NOT elevate to admin!

      // Invitation must remain pending so the intended user can still accept it!
      const resolved = await resolveInvitationToken(rawToken);
      expect(resolved.role).toBe('admin');
    });
  });

  describe('5. Concurrency and Atomicity', () => {
    it('prevents two concurrent requests from claiming the same single-use invitation', async () => {
      const scopedDb = createScopedDb(owner.id);
      const { rawToken } = await createInvitation(scopedDb, {
        workspaceId,
        inviterId: owner.id,
        role: 'viewer',
      });

      // Create two distinct users
      const db = getSystemDb();
      const timestamp = Date.now();
      const racer1 = await registerUser(db, {
        email: `racer1_${timestamp}@example.com`,
        password: 'Password123!',
        displayName: 'Racer 1',
      });
      const racer2 = await registerUser(db, {
        email: `racer2_${timestamp}@example.com`,
        password: 'Password123!',
        displayName: 'Racer 2',
      });

      // Launch simultaneous acceptance
      const results = await Promise.allSettled([
        acceptInvitation(rawToken, { userId: racer1.id, email: racer1.email }),
        acceptInvitation(rawToken, { userId: racer2.id, email: racer2.email }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly ONE must succeed and exactly ONE must fail
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyAcceptedError);
    });

    it('enforces cross-workspace isolation on invitation listing', async () => {
      const ownerScopedDb = createScopedDb(owner.id);

      // Create invite in other workspace
      const otherInvite = await createInvitation(ownerScopedDb, {
        workspaceId: otherWorkspaceId,
        inviterId: owner.id,
        role: 'editor',
      });

      // Primary workspace invitations must NOT contain otherWorkspaceId invite
      const primaryList = await listWorkspaceInvitations(ownerScopedDb, workspaceId, owner.id);
      const hasOtherInvite = primaryList.some((inv) => inv.id === otherInvite.invitation.id);
      expect(hasOtherInvite).toBe(false);
    });

    it('confirms runtime role knowledge_app does NOT possess BYPASSRLS', async () => {
      const db = getSystemDb();
      const roleCheck = await withSystemContext(async (sysDb) => {
        return sysDb
          .selectFrom('pg_roles' as any)
          .where('rolname', '=', 'knowledge_app')
          .select(['rolbypassrls', 'rolsuper'])
          .executeTakeFirst();
      });

      if (roleCheck) {
        expect((roleCheck as any).rolbypassrls).toBe(false);
        expect((roleCheck as any).rolsuper).toBe(false);
      }
    });
  });
});
