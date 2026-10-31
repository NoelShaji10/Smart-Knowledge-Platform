import crypto from 'crypto';
import { Kysely } from 'kysely';
import { Database, ScopedDb, withSystemContext } from '@knowledge/database';
import { WorkspaceRole, InvitationRole, InvitationStatus, EmailDeliveryStatus } from '@knowledge/types';
import { encryptInvitationToken, buildInvitationAad } from '@knowledge/email';
import { getPgBoss, enqueueInvitationEmailJob } from '@knowledge/jobs';
import { emitAuditEvent } from './audit';

// ---------------------------------------------------------------------------
// Error Hierarchy
// ---------------------------------------------------------------------------

export class InvitationError extends Error {
  public status: number;
  public code: string;

  constructor(message: string, status = 400, code = 'INVITATION_ERROR') {
    super(message);
    this.name = 'InvitationError';
    this.status = status;
    this.code = code;
  }
}

export class InvitationNotFoundError extends InvitationError {
  constructor(message = 'Invitation not found') {
    super(message, 404, 'INVITATION_NOT_FOUND');
    this.name = 'InvitationNotFoundError';
  }
}

export class ExpiredInvitationError extends InvitationError {
  constructor(message = 'This invitation has expired') {
    super(message, 410, 'INVITATION_EXPIRED');
    this.name = 'ExpiredInvitationError';
  }
}

export class RevokedInvitationError extends InvitationError {
  constructor(message = 'This invitation has been revoked') {
    super(message, 410, 'INVITATION_REVOKED');
    this.name = 'RevokedInvitationError';
  }
}

export class AlreadyAcceptedError extends InvitationError {
  constructor(message = 'This invitation has already been accepted') {
    super(message, 409, 'INVITATION_ALREADY_ACCEPTED');
    this.name = 'AlreadyAcceptedError';
  }
}

export class EmailMismatchError extends InvitationError {
  constructor(message = 'This invitation was sent to a different email address') {
    super(message, 403, 'EMAIL_MISMATCH');
    this.name = 'EmailMismatchError';
  }
}

export class UnverifiedEmailError extends InvitationError {
  constructor(message = 'Account email must be verified to accept an email-bound invitation') {
    super(message, 403, 'EMAIL_NOT_VERIFIED');
    this.name = 'UnverifiedEmailError';
  }
}

export class UserAlreadyMemberError extends InvitationError {
  constructor(message = 'User is already a member of this workspace') {
    super(message, 409, 'USER_ALREADY_MEMBER');
    this.name = 'UserAlreadyMemberError';
  }
}

export class UnauthorizedInvitationError extends InvitationError {
  constructor(message = 'Unauthorized to perform this invitation action') {
    super(message, 403, 'UNAUTHORIZED');
    this.name = 'UnauthorizedInvitationError';
  }
}

export class InvalidInvitationRoleError extends InvitationError {
  constructor(message = 'Invalid invitation role requested') {
    super(message, 400, 'INVALID_ROLE');
    this.name = 'InvalidInvitationRoleError';
  }
}

export class InvalidInvitationEmailError extends InvitationError {
  constructor(message = 'Invalid invitation email format') {
    super(message, 400, 'INVALID_EMAIL');
    this.name = 'InvalidInvitationEmailError';
  }
}

export class AdminPrivilegeEscalationError extends InvitationError {
  constructor(message = 'Only workspace owners can invite or manage admin memberships') {
    super(message, 403, 'ADMIN_PRIVILEGE_ESCALATION');
    this.name = 'AdminPrivilegeEscalationError';
  }
}

export class CannotRevokeAcceptedInvitationError extends InvitationError {
  constructor(message = 'Cannot revoke an invitation that has already been accepted') {
    super(message, 409, 'CANNOT_REVOKE_ACCEPTED');
    this.name = 'CannotRevokeAcceptedInvitationError';
  }
}

export class CannotResendAcceptedInvitationError extends InvitationError {
  constructor(message = 'Cannot resend an invitation that has already been accepted') {
    super(message, 409, 'CANNOT_RESEND_ACCEPTED');
    this.name = 'CannotResendAcceptedInvitationError';
  }
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface CreateInvitationParams {
  workspaceId: string;
  inviterId: string;
  role: InvitationRole;
  email?: string | null;
  expiresInDays?: number;
  auditContext?: {
    ipAddress?: string;
    userAgent?: string;
  };
}

export interface WorkspaceInvitationRecord {
  id: string;
  workspace_id: string;
  inviter_id: string;
  invitee_email: string | null;
  role: InvitationRole;
  status: InvitationStatus;
  expires_at: Date;
  accepted_by?: string | null;
  accepted_at?: Date | null;
  created_at: Date;
  inviter_name?: string | null;
  inviter_email?: string | null;
  email_delivery_status?: EmailDeliveryStatus;
  email_queued_at?: Date | null;
  email_sent_at?: Date | null;
  email_last_attempt_at?: Date | null;
  email_delivery_attempts?: number;
  email_failure_reason?: string | null;
}

export interface PublicInvitationDetails {
  workspaceName: string;
  inviterName: string;
  role: InvitationRole;
  expiresAt: Date;
  isEmailBound: boolean;
  maskedEmail: string | null;
}

export interface AcceptInvitationResult {
  status: 'accepted' | 'already_member';
  workspaceId: string;
  role: WorkspaceRole;
}

// ---------------------------------------------------------------------------
// Security & Token Utilities
// ---------------------------------------------------------------------------

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function generateInvitationToken(): { rawToken: string; tokenHash: string } {
  // 32 cryptographically secure random bytes = 256 bits entropy, encoded in URL-safe base64url
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashInvitationToken(rawToken);
  return { rawToken, tokenHash };
}

export function hashInvitationToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function maskEmail(email: string): string {
  const [localPart, domain] = email.split('@');
  if (!domain) return '***';
  if (localPart.length <= 2) {
    return `${localPart[0]}***@${domain}`;
  }
  return `${localPart[0]}***${localPart[localPart.length - 1]}@${domain}`;
}

// ---------------------------------------------------------------------------
// Service Methods
// ---------------------------------------------------------------------------

/**
 * Creates an email-bound or shareable invitation.
 * Enforces verified authorization against PostgreSQL `workspace_members`.
 */
export async function createInvitation(
  scopedDb: ScopedDb,
  params: CreateInvitationParams,
): Promise<{ invitation: WorkspaceInvitationRecord; rawToken: string }> {
  const { workspaceId, inviterId, role, email, expiresInDays, auditContext } = params;

  // 1. Role validation
  if (role !== 'admin' && role !== 'editor' && role !== 'viewer') {
    throw new InvalidInvitationRoleError(`Role '${role}' is not a valid invitation role`);
  }

  // 2. Email normalization & format validation
  let normalizedEmail: string | null = null;
  if (email !== undefined && email !== null && email.trim() !== '') {
    normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      throw new InvalidInvitationEmailError('Invalid email format provided for invitation');
    }
  }

  const result = await scopedDb.execute(async (db) => {
    // 3. Authoritative inviter membership & role check
    const inviterMember = await db
      .selectFrom('workspace_members')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', inviterId)
      .select(['role'])
      .executeTakeFirst();

    if (!inviterMember) {
      throw new UnauthorizedInvitationError('Inviter is not a member of this workspace');
    }

    const inviterRole = inviterMember.role as WorkspaceRole;
    if (inviterRole !== 'owner' && inviterRole !== 'admin') {
      throw new UnauthorizedInvitationError('Only workspace owners and admins can create invitations');
    }

    // Admin privilege escalation prevention
    if (inviterRole === 'admin' && role === 'admin') {
      throw new AdminPrivilegeEscalationError('Only workspace owners can invite admin members');
    }

    // 4. Pre-check: if email-bound, ensure user is not already a member of workspace
    if (normalizedEmail) {
      const existingUser = await withSystemContext(async (sysDb) => {
        return sysDb
          .selectFrom('users')
          .where('email', '=', normalizedEmail)
          .select(['id'])
          .executeTakeFirst();
      });

      if (existingUser) {
        const existingMember = await db
          .selectFrom('workspace_members')
          .where('workspace_id', '=', workspaceId)
          .where('user_id', '=', existingUser.id)
          .select(['role'])
          .executeTakeFirst();

        if (existingMember) {
          throw new UserAlreadyMemberError('User is already a member of this workspace');
        }
      }
    }

    // 5. Generate secure token
    const { rawToken, tokenHash } = generateInvitationToken();
    const expiryDays = expiresInDays && expiresInDays > 0 ? expiresInDays : 7;
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);
    const invitationId = crypto.randomUUID();

    let encryptedTokenPayload: any = null;
    if (normalizedEmail) {
      const aad = buildInvitationAad(invitationId);
      encryptedTokenPayload = encryptInvitationToken(rawToken, undefined, {
        associatedData: aad,
      });
    }

    // 6. Invalidate previous pending invitations for this email in this workspace
    if (normalizedEmail) {
      await db
        .updateTable('workspace_invitations')
        .set({ status: 'revoked', updated_at: new Date() })
        .where('workspace_id', '=', workspaceId)
        .where('invitee_email', '=', normalizedEmail)
        .where('status', '=', 'pending')
        .execute();
    }

    // 7. Insert new invitation row
    const emailDeliveryStatus: EmailDeliveryStatus = normalizedEmail ? 'queued' : 'not_requested';
    const emailQueuedAt = normalizedEmail ? new Date() : null;

    const row = await db
      .insertInto('workspace_invitations')
      .values({
        id: invitationId,
        workspace_id: workspaceId,
        inviter_id: inviterId,
        invitee_email: normalizedEmail,
        role,
        token_hash: tokenHash,
        status: 'pending',
        expires_at: expiresAt,
        email_delivery_status: emailDeliveryStatus,
        email_queued_at: emailQueuedAt,
        email_delivery_attempts: 0,
        encrypted_token: encryptedTokenPayload ? JSON.stringify(encryptedTokenPayload) : null,
      })
      .returning([
        'id',
        'workspace_id',
        'inviter_id',
        'invitee_email',
        'role',
        'status',
        'expires_at',
        'created_at',
        'email_delivery_status',
        'email_queued_at',
        'email_sent_at',
        'email_last_attempt_at',
        'email_delivery_attempts',
        'email_failure_reason',
      ])
      .executeTakeFirstOrThrow();

    // 8. Audit logging (Never log raw token or token hash)
    await emitAuditEvent(db, {
      workspaceId,
      actorId: inviterId,
      action: 'workspace.invitation.created',
      resourceType: 'invitation',
      resourceId: row.id,
      metadata: {
        role,
        inviteeEmail: normalizedEmail,
        isEmailBound: Boolean(normalizedEmail),
        expiresAt: expiresAt.toISOString(),
      },
      ipAddress: auditContext?.ipAddress,
      userAgent: auditContext?.userAgent,
    });

    return {
      invitation: {
        id: row.id,
        workspace_id: row.workspace_id,
        inviter_id: row.inviter_id,
        invitee_email: row.invitee_email,
        role: row.role as InvitationRole,
        status: row.status as InvitationStatus,
        expires_at: row.expires_at,
        created_at: row.created_at,
        email_delivery_status: row.email_delivery_status as EmailDeliveryStatus,
        email_queued_at: row.email_queued_at,
        email_sent_at: row.email_sent_at,
        email_last_attempt_at: row.email_last_attempt_at,
        email_delivery_attempts: row.email_delivery_attempts,
        email_failure_reason: row.email_failure_reason,
      },
      rawToken,
      encryptedTokenPayload,
    };
  });

  // 9. Post-commit enqueue: Enqueue pg-boss delivery job AFTER transaction commits to prevent worker visibility race (AUD-T3-02)
  if (normalizedEmail && result.encryptedTokenPayload) {
    try {
      const boss = getPgBoss();
      await enqueueInvitationEmailJob(boss, {
        invitationId: result.invitation.id,
        workspaceId,
        encryptedToken: result.encryptedTokenPayload,
        keyId: result.encryptedTokenPayload.keyId,
      });
    } catch (enqueueErr: any) {
      // In the rare event of enqueue failure after commit, record failure state in DB and fail closed
      await withSystemContext(async (sysDb) => {
        await sysDb
          .updateTable('workspace_invitations')
          .set({
            email_delivery_status: 'failed',
            email_failure_reason: 'QUEUE_ENQUEUE_FAILED',
            email_last_attempt_at: new Date(),
            updated_at: new Date(),
          })
          .where('id', '=', result.invitation.id)
          .execute();
      });

      result.invitation.email_delivery_status = 'failed';
      result.invitation.email_failure_reason = 'QUEUE_ENQUEUE_FAILED';

      throw new Error(`Failed to enqueue invitation delivery job: ${enqueueErr?.message || 'Queue error'}`);
    }
  }

  return result;
}

/**
 * Lists invitations for a workspace. Accessible only to workspace owners and admins.
 * Token hashes and raw tokens are never selected or returned.
 */
export async function listWorkspaceInvitations(
  scopedDb: ScopedDb,
  workspaceId: string,
  actorUserId: string,
): Promise<WorkspaceInvitationRecord[]> {
  return scopedDb.execute(async (db) => {
    // 1. Authoritative membership & admin check
    const member = await db
      .selectFrom('workspace_members')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', actorUserId)
      .select(['role'])
      .executeTakeFirst();

    if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
      throw new UnauthorizedInvitationError('Only workspace owners and admins can view invitations');
    }

    // 2. Query invitations (excluding token_hash)
    const rows = await db
      .selectFrom('workspace_invitations')
      .leftJoin('users as inviter', 'inviter.id', 'workspace_invitations.inviter_id')
      .where('workspace_invitations.workspace_id', '=', workspaceId)
      .orderBy('workspace_invitations.created_at', 'desc')
      .select([
        'workspace_invitations.id',
        'workspace_invitations.workspace_id',
        'workspace_invitations.inviter_id',
        'workspace_invitations.invitee_email',
        'workspace_invitations.role',
        'workspace_invitations.status',
        'workspace_invitations.expires_at',
        'workspace_invitations.accepted_by',
        'workspace_invitations.accepted_at',
        'workspace_invitations.created_at',
        'workspace_invitations.email_delivery_status',
        'workspace_invitations.email_queued_at',
        'workspace_invitations.email_sent_at',
        'workspace_invitations.email_last_attempt_at',
        'workspace_invitations.email_delivery_attempts',
        'workspace_invitations.email_failure_reason',
        'inviter.display_name as inviter_name',
        'inviter.email as inviter_email',
      ])
      .execute();

    const now = new Date();
    return rows.map((r) => {
      let computedStatus = r.status as InvitationStatus;
      if (computedStatus === 'pending' && r.expires_at < now) {
        computedStatus = 'expired';
      }
      return {
        id: r.id,
        workspace_id: r.workspace_id,
        inviter_id: r.inviter_id,
        invitee_email: r.invitee_email,
        role: r.role as InvitationRole,
        status: computedStatus,
        expires_at: r.expires_at,
        accepted_by: r.accepted_by,
        accepted_at: r.accepted_at,
        created_at: r.created_at,
        inviter_name: r.inviter_name,
        inviter_email: r.inviter_email,
        email_delivery_status: r.email_delivery_status as EmailDeliveryStatus,
        email_queued_at: r.email_queued_at,
        email_sent_at: r.email_sent_at,
        email_last_attempt_at: r.email_last_attempt_at,
        email_delivery_attempts: r.email_delivery_attempts,
        email_failure_reason: r.email_failure_reason,
      };
    });
  });
}

/**
 * Revokes a pending invitation.
 */
export async function revokeWorkspaceInvitation(
  scopedDb: ScopedDb,
  workspaceId: string,
  invitationId: string,
  actorUserId: string,
  auditContext?: { ipAddress?: string; userAgent?: string },
): Promise<{ ok: boolean }> {
  return scopedDb.execute(async (db) => {
    // 1. Authoritative membership & admin check
    const member = await db
      .selectFrom('workspace_members')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', actorUserId)
      .select(['role'])
      .executeTakeFirst();

    if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
      throw new UnauthorizedInvitationError('Only workspace owners and admins can revoke invitations');
    }

    // 2. Fetch invitation to check status and permissions
    const invitation = await db
      .selectFrom('workspace_invitations')
      .where('id', '=', invitationId)
      .where('workspace_id', '=', workspaceId)
      .select(['id', 'role', 'status'])
      .executeTakeFirst();

    if (!invitation) {
      throw new InvitationNotFoundError('Invitation not found in this workspace');
    }

    if (invitation.status === 'accepted') {
      throw new CannotRevokeAcceptedInvitationError();
    }

    // Admin privilege guard: only owner can manage admin invitations
    if (member.role === 'admin' && invitation.role === 'admin') {
      throw new AdminPrivilegeEscalationError('Only workspace owners can revoke admin invitations');
    }

    if (invitation.status === 'revoked') {
      return { ok: true };
    }

    // 3. Mark as revoked
    await db
      .updateTable('workspace_invitations')
      .set({ status: 'revoked', updated_at: new Date() })
      .where('id', '=', invitationId)
      .where('workspace_id', '=', workspaceId)
      .execute();

    // 4. Emit audit event
    await emitAuditEvent(db, {
      workspaceId,
      actorId: actorUserId,
      action: 'workspace.invitation.revoked',
      resourceType: 'invitation',
      resourceId: invitationId,
      metadata: { role: invitation.role },
      ipAddress: auditContext?.ipAddress,
      userAgent: auditContext?.userAgent,
    });

    return { ok: true };
  });
}

/**
 * Replaces and resends a pending invitation with a fresh secret and 7-day expiry.
 */
export async function resendWorkspaceInvitation(
  scopedDb: ScopedDb,
  workspaceId: string,
  invitationId: string,
  actorUserId: string,
  auditContext?: { ipAddress?: string; userAgent?: string },
): Promise<{ invitation: WorkspaceInvitationRecord; rawToken: string }> {
  const result = await scopedDb.execute(async (db) => {
    // 1. Authoritative membership & admin check
    const member = await db
      .selectFrom('workspace_members')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', actorUserId)
      .select(['role'])
      .executeTakeFirst();

    if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
      throw new UnauthorizedInvitationError('Only workspace owners and admins can resend invitations');
    }

    // 2. Fetch existing invitation
    const existing = await db
      .selectFrom('workspace_invitations')
      .where('id', '=', invitationId)
      .where('workspace_id', '=', workspaceId)
      .selectAll()
      .executeTakeFirst();

    if (!existing) {
      throw new InvitationNotFoundError('Invitation not found in this workspace');
    }

    if (existing.status === 'accepted') {
      throw new CannotResendAcceptedInvitationError();
    }

    if (member.role === 'admin' && existing.role === 'admin') {
      throw new AdminPrivilegeEscalationError('Only workspace owners can resend admin invitations');
    }

    // 3. Invalidate old invitation
    await db
      .updateTable('workspace_invitations')
      .set({ status: 'revoked', updated_at: new Date() })
      .where('id', '=', invitationId)
      .execute();

    // 4. Generate new secret
    const { rawToken, tokenHash } = generateInvitationToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const newInvitationId = crypto.randomUUID();

    let encryptedTokenPayload: any = null;
    if (existing.invitee_email) {
      const aad = buildInvitationAad(newInvitationId);
      encryptedTokenPayload = encryptInvitationToken(rawToken, undefined, {
        associatedData: aad,
      });
    }

    // 5. Insert replacement invitation row
    const emailDeliveryStatus: EmailDeliveryStatus = existing.invitee_email ? 'queued' : 'not_requested';
    const emailQueuedAt = existing.invitee_email ? new Date() : null;

    const newRow = await db
      .insertInto('workspace_invitations')
      .values({
        id: newInvitationId,
        workspace_id: workspaceId,
        inviter_id: actorUserId,
        invitee_email: existing.invitee_email,
        role: existing.role,
        token_hash: tokenHash,
        status: 'pending',
        expires_at: expiresAt,
        email_delivery_status: emailDeliveryStatus,
        email_queued_at: emailQueuedAt,
        email_delivery_attempts: 0,
        encrypted_token: encryptedTokenPayload ? JSON.stringify(encryptedTokenPayload) : null,
      })
      .returning([
        'id',
        'workspace_id',
        'inviter_id',
        'invitee_email',
        'role',
        'status',
        'expires_at',
        'created_at',
        'email_delivery_status',
        'email_queued_at',
        'email_sent_at',
        'email_last_attempt_at',
        'email_delivery_attempts',
        'email_failure_reason',
      ])
      .executeTakeFirstOrThrow();

    // 6. Audit logging
    await emitAuditEvent(db, {
      workspaceId,
      actorId: actorUserId,
      action: 'workspace.invitation.resent',
      resourceType: 'invitation',
      resourceId: newRow.id,
      metadata: {
        role: newRow.role,
        previousInvitationId: invitationId,
        inviteeEmail: newRow.invitee_email,
        expiresAt: expiresAt.toISOString(),
      },
      ipAddress: auditContext?.ipAddress,
      userAgent: auditContext?.userAgent,
    });

    return {
      invitation: {
        id: newRow.id,
        workspace_id: newRow.workspace_id,
        inviter_id: newRow.inviter_id,
        invitee_email: newRow.invitee_email,
        role: newRow.role as InvitationRole,
        status: newRow.status as InvitationStatus,
        expires_at: newRow.expires_at,
        created_at: newRow.created_at,
        email_delivery_status: newRow.email_delivery_status as EmailDeliveryStatus,
        email_queued_at: newRow.email_queued_at,
        email_sent_at: newRow.email_sent_at,
        email_last_attempt_at: newRow.email_last_attempt_at,
        email_delivery_attempts: newRow.email_delivery_attempts,
        email_failure_reason: newRow.email_failure_reason,
      },
      rawToken,
      encryptedTokenPayload,
    };
  });

  // 7. Post-commit enqueue: Enqueue pg-boss delivery job AFTER transaction commits to prevent worker visibility race (AUD-T3-02)
  if (result.invitation.invitee_email && result.encryptedTokenPayload) {
    try {
      const boss = getPgBoss();
      await enqueueInvitationEmailJob(boss, {
        invitationId: result.invitation.id,
        workspaceId,
        encryptedToken: result.encryptedTokenPayload,
        keyId: result.encryptedTokenPayload.keyId,
      });
    } catch (enqueueErr: any) {
      // In the rare event of enqueue failure after commit, record failure state in DB and fail closed
      await withSystemContext(async (sysDb) => {
        await sysDb
          .updateTable('workspace_invitations')
          .set({
            email_delivery_status: 'failed',
            email_failure_reason: 'QUEUE_ENQUEUE_FAILED',
            email_last_attempt_at: new Date(),
            updated_at: new Date(),
          })
          .where('id', '=', result.invitation.id)
          .execute();
      });

      result.invitation.email_delivery_status = 'failed';
      result.invitation.email_failure_reason = 'QUEUE_ENQUEUE_FAILED';

      throw new Error(
        `Failed to enqueue replacement invitation delivery job: ${enqueueErr?.message || 'Queue error'}`,
      );
    }
  }

  return result;
}

/**
 * Resolves a raw invitation token into sanitized public metadata.
 * Does not expose internal IDs, secrets, or whether users exist.
 * Does not mutate or consume the invitation.
 */
export async function resolveInvitationToken(rawToken: string): Promise<PublicInvitationDetails> {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new InvitationNotFoundError('Invalid invitation token');
  }

  const tokenHash = hashInvitationToken(rawToken);

  return withSystemContext(async (systemDb) => {
    const row = await systemDb
      .selectFrom('workspace_invitations')
      .innerJoin('workspaces', 'workspaces.id', 'workspace_invitations.workspace_id')
      .leftJoin('users as inviter', 'inviter.id', 'workspace_invitations.inviter_id')
      .where('workspace_invitations.token_hash', '=', tokenHash)
      .select([
        'workspaces.name as workspace_name',
        'inviter.display_name as inviter_name',
        'workspace_invitations.role',
        'workspace_invitations.status',
        'workspace_invitations.expires_at',
        'workspace_invitations.invitee_email',
      ])
      .executeTakeFirst();

    if (!row) {
      throw new InvitationNotFoundError('Invalid invitation link');
    }

    if (row.status === 'revoked') {
      throw new RevokedInvitationError();
    }

    if (row.status === 'accepted') {
      throw new AlreadyAcceptedError();
    }

    if (row.status === 'expired' || row.expires_at < new Date()) {
      throw new ExpiredInvitationError();
    }

    return {
      workspaceName: row.workspace_name,
      inviterName: row.inviter_name || 'A team member',
      role: row.role as InvitationRole,
      expiresAt: row.expires_at,
      isEmailBound: Boolean(row.invitee_email),
      maskedEmail: row.invitee_email ? maskEmail(row.invitee_email) : null,
    };
  });
}

/**
 * Accepts an invitation transactionally with row-level locking.
 * Enforces email matching (if email-bound), idempotently handles existing membership,
 * and atomically creates workspace membership.
 */
export async function acceptInvitation(
  rawToken: string,
  user: { userId: string; email?: string; emailVerified?: boolean | unknown },
  auditContext?: { ipAddress?: string; userAgent?: string },
): Promise<AcceptInvitationResult> {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new InvitationNotFoundError('Invalid invitation token');
  }

  if (!user || typeof user !== 'object' || !user.userId) {
    throw new UnauthorizedInvitationError('Valid authenticated user is required to accept an invitation');
  }

  const tokenHash = hashInvitationToken(rawToken);

  return withSystemContext(async (systemDb) => {
    // 1. Lock the invitation row to serialize concurrent claims
    let query = systemDb
      .selectFrom('workspace_invitations')
      .where('token_hash', '=', tokenHash)
      .selectAll();

    if (typeof (query as any).forUpdate === 'function') {
      query = (query as any).forUpdate();
    }

    const invitation = await query.executeTakeFirst();

    if (!invitation) {
      throw new InvitationNotFoundError('Invalid invitation link');
    }

    // 2. Validate current state
    if (invitation.status === 'revoked') {
      throw new RevokedInvitationError();
    }

    if (invitation.status === 'accepted') {
      throw new AlreadyAcceptedError();
    }

    const now = new Date();
    if (invitation.expires_at < now || invitation.status === 'expired') {
      await systemDb
        .updateTable('workspace_invitations')
        .set({ status: 'expired', updated_at: now })
        .where('id', '=', invitation.id)
        .execute();
      throw new ExpiredInvitationError();
    }

    // 3. Authenticate current user against PostgreSQL and verify email-binding (Fail-closed)
    const dbUser = await systemDb
      .selectFrom('users')
      .where('id', '=', user.userId)
      .select(['id', 'email', 'email_verified'])
      .executeTakeFirst();

    if (!dbUser) {
      throw new UnauthorizedInvitationError('User account not found');
    }

    if (invitation.invitee_email) {
      const normalizedDbEmail = typeof dbUser.email === 'string' ? dbUser.email.trim().toLowerCase() : '';
      const normalizedInviteeEmail = invitation.invitee_email.trim().toLowerCase();
      if (normalizedDbEmail !== normalizedInviteeEmail) {
        throw new EmailMismatchError('This invitation is intended for a different email address');
      }

      // Require an authoritative verification status of exactly boolean true from PostgreSQL.
      // Reject false, undefined, null, missing, malformed, or stale JWT verification claims.
      if (dbUser.email_verified !== true) {
        throw new UnverifiedEmailError('Account email must be verified to accept an email-bound invitation');
      }
    }

    // 4. Idempotent check: is user already a member?
    const existingMembership = await systemDb
      .selectFrom('workspace_members')
      .where('workspace_id', '=', invitation.workspace_id)
      .where('user_id', '=', user.userId)
      .select(['role'])
      .executeTakeFirst();

    if (existingMembership) {
      // User already belongs to the workspace: return existing membership without consuming invitation
      return {
        status: 'already_member',
        workspaceId: invitation.workspace_id,
        role: existingMembership.role as WorkspaceRole,
      };
    }

    // 5. Insert workspace membership atomically
    await systemDb
      .insertInto('workspace_members')
      .values({
        workspace_id: invitation.workspace_id,
        user_id: user.userId,
        role: invitation.role,
      })
      .execute();

    // 6. Transition invitation status to 'accepted'
    await systemDb
      .updateTable('workspace_invitations')
      .set({
        status: 'accepted',
        accepted_by: user.userId,
        accepted_at: now,
        updated_at: now,
      })
      .where('id', '=', invitation.id)
      .execute();

    // 7. Audit log emission
    await emitAuditEvent(systemDb, {
      workspaceId: invitation.workspace_id,
      actorId: user.userId,
      action: 'workspace.invitation.accepted',
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: {
        role: invitation.role,
        isEmailBound: Boolean(invitation.invitee_email),
      },
      ipAddress: auditContext?.ipAddress,
      userAgent: auditContext?.userAgent,
    });

    return {
      status: 'accepted',
      workspaceId: invitation.workspace_id,
      role: invitation.role as WorkspaceRole,
    };
  });
}
