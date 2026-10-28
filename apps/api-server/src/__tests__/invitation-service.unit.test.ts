import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as jobsModule from '@knowledge/jobs';
import * as databaseModule from '@knowledge/database';
import {
  generateInvitationToken,
  hashInvitationToken,
  maskEmail,
  createInvitation,
  acceptInvitation,
  InvalidInvitationRoleError,
  InvalidInvitationEmailError,
  InvitationNotFoundError,
  ExpiredInvitationError,
  RevokedInvitationError,
  AlreadyAcceptedError,
  EmailMismatchError,
  UnverifiedEmailError,
  UserAlreadyMemberError,
  UnauthorizedInvitationError,
  AdminPrivilegeEscalationError,
  CannotRevokeAcceptedInvitationError,
  CannotResendAcceptedInvitationError,
} from '../lib/invitation-service';

describe('Invitation Service Unit Tests (Pure Logic & Cryptography)', () => {
  describe('Token Generation & Hashing', () => {
    it('generates 32-byte cryptographically secure random token and valid SHA-256 hash', () => {
      const { rawToken, tokenHash } = generateInvitationToken();

      // 32 bytes base64url has length 43
      expect(rawToken).toBeDefined();
      expect(rawToken.length).toBeGreaterThanOrEqual(43);
      expect(tokenHash).toBeDefined();
      expect(tokenHash).toHaveLength(64); // SHA-256 produces 64 hex characters
      expect(/^[0-9a-f]{64}$/.test(tokenHash)).toBe(true);

      // Verify hashing is deterministic
      expect(hashInvitationToken(rawToken)).toBe(tokenHash);
    });

    it('generates unique tokens on subsequent calls (high entropy)', () => {
      const token1 = generateInvitationToken();
      const token2 = generateInvitationToken();

      expect(token1.rawToken).not.toBe(token2.rawToken);
      expect(token1.tokenHash).not.toBe(token2.tokenHash);
    });
  });

  describe('Email Masking Helper', () => {
    it('masks standard email addresses safely', () => {
      expect(maskEmail('jane.doe@company.com')).toBe('j***e@company.com');
      expect(maskEmail('alice@example.org')).toBe('a***e@example.org');
    });

    it('handles short local parts safely', () => {
      expect(maskEmail('ab@test.com')).toBe('a***@test.com');
      expect(maskEmail('a@test.com')).toBe('a***@test.com');
    });

    it('handles malformed input safely', () => {
      expect(maskEmail('invalid')).toBe('***');
    });
  });

  describe('Creation Validation & Escapes', () => {
    it('rejects owner role with InvalidInvitationRoleError', async () => {
      const mockScopedDb: any = { execute: () => Promise.resolve() };

      await expect(
        createInvitation(mockScopedDb, {
          workspaceId: '00000000-0000-0000-0000-000000000001',
          inviterId: '00000000-0000-0000-0000-000000000002',
          role: 'owner' as any,
        }),
      ).rejects.toThrow(InvalidInvitationRoleError);
    });

    it('rejects invalid email format with InvalidInvitationEmailError', async () => {
      const mockScopedDb: any = { execute: () => Promise.resolve() };

      await expect(
        createInvitation(mockScopedDb, {
          workspaceId: '00000000-0000-0000-0000-000000000001',
          inviterId: '00000000-0000-0000-0000-000000000002',
          role: 'editor',
          email: 'not-valid-email',
        }),
      ).rejects.toThrow(InvalidInvitationEmailError);
    });
  });

  describe('Acceptance Input Validations', () => {
    it('rejects acceptance with empty token', async () => {
      await expect(
        acceptInvitation('', { userId: 'u1', email: 'test@example.com' }),
      ).rejects.toThrow(InvitationNotFoundError);
    });

    it('rejects acceptance without authenticated user context', async () => {
      await expect(
        acceptInvitation('some-token', null as any),
      ).rejects.toThrow(UnauthorizedInvitationError);

      await expect(
        acceptInvitation('some-token', { userId: '', email: '' }),
      ).rejects.toThrow(UnauthorizedInvitationError);
    });
  });

  describe('Custom Error Classes Hierarchy', () => {
    it('ensures all error types inherit from Error and have correct names', () => {
      const errors = [
        new InvitationNotFoundError(),
        new ExpiredInvitationError(),
        new RevokedInvitationError(),
        new AlreadyAcceptedError(),
        new EmailMismatchError(),
        new UnverifiedEmailError(),
        new UserAlreadyMemberError(),
        new UnauthorizedInvitationError(),
        new InvalidInvitationRoleError(),
        new InvalidInvitationEmailError(),
        new AdminPrivilegeEscalationError(),
        new CannotRevokeAcceptedInvitationError(),
        new CannotResendAcceptedInvitationError(),
      ];

      for (const err of errors) {
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe(err.constructor.name);
        expect(err.message).toBeDefined();
      }
    });
  });

  describe('AUD-T3-02: Post-Commit Queueing & Recovery', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('enqueues pg-boss job only after database transaction successfully returns (commits)', async () => {
      let transactionCommitted = false;
      const mockRow = {
        id: 'inv-uuid-1234',
        workspace_id: 'ws-uuid-5678',
        inviter_id: 'user-uuid-admin',
        invitee_email: 'newuser@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000),
        created_at: new Date(),
        email_delivery_status: 'queued',
        email_queued_at: new Date(),
        email_sent_at: null,
        email_last_attempt_at: null,
        email_delivery_attempts: 0,
        email_failure_reason: null,
      };

      vi.spyOn(databaseModule, 'withSystemContext').mockImplementation(async (callback: any) => {
        const mockSysDb: any = {
          selectFrom: () => ({
            where: () => ({
              select: () => ({
                executeTakeFirst: async () => null, // no existing user with email
              }),
            }),
          }),
          insertInto: () => ({
            values: () => ({
              execute: async () => [],
            }),
          }),
        };
        return callback(mockSysDb);
      });

      const mockScopedDb: any = {
        execute: async (callback: any) => {
          const mockDb: any = {
            selectFrom: () => ({
              where: () => ({
                where: () => ({
                  select: () => ({
                    executeTakeFirst: async () => ({ role: 'owner' }),
                  }),
                }),
              }),
            }),
            updateTable: () => ({
              set: () => ({
                where: () => ({
                  where: () => ({
                    where: () => ({
                      execute: async () => [],
                    }),
                  }),
                }),
              }),
            }),
            insertInto: () => ({
              values: () => ({
                execute: async () => [],
                returning: () => ({
                  executeTakeFirstOrThrow: async () => mockRow,
                }),
              }),
            }),
          };
          const res = await callback(mockDb);
          transactionCommitted = true;
          return res;
        },
      };

      const mockBoss = {
        send: vi.fn().mockImplementation(async () => {
          // Verify that when pg-boss enqueue is called, the database transaction has ALREADY committed
          expect(transactionCommitted).toBe(true);
          return 'job-id-test-123';
        }),
      };
      const bossSpy = vi.spyOn(jobsModule, 'getPgBoss').mockReturnValue(mockBoss as any);

      const result = await createInvitation(mockScopedDb, {
        workspaceId: 'ws-uuid-5678',
        inviterId: 'user-uuid-admin',
        role: 'editor',
        email: 'newuser@example.com',
      });

      expect(transactionCommitted).toBe(true);
      expect(mockBoss.send).toHaveBeenCalledTimes(1);
      expect(result.invitation.id).toBe('inv-uuid-1234');
      expect(result.invitation.email_delivery_status).toBe('queued');
    });

    it('recovers and marks invitation delivery as failed if pg-boss enqueueing fails post-commit', async () => {
      let recoveryDbUpdated = false;
      let updatedStatus = '';
      let updatedReason = '';

      const mockRow = {
        id: 'inv-uuid-fail-queue',
        workspace_id: 'ws-uuid-5678',
        inviter_id: 'user-uuid-admin',
        invitee_email: 'newuser@example.com',
        role: 'editor',
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000),
        created_at: new Date(),
        email_delivery_status: 'queued',
        email_queued_at: new Date(),
        email_sent_at: null,
        email_last_attempt_at: null,
        email_delivery_attempts: 0,
        email_failure_reason: null,
      };

      const mockScopedDb: any = {
        execute: async (callback: any) => {
          const mockDb: any = {
            selectFrom: () => ({
              where: () => ({
                where: () => ({
                  select: () => ({
                    executeTakeFirst: async () => ({ role: 'owner' }),
                  }),
                }),
              }),
            }),
            updateTable: () => ({
              set: () => ({
                where: () => ({
                  where: () => ({
                    where: () => ({
                      execute: async () => [],
                    }),
                  }),
                }),
              }),
            }),
            insertInto: () => ({
              values: () => ({
                execute: async () => [],
                returning: () => ({
                  executeTakeFirstOrThrow: async () => mockRow,
                }),
              }),
            }),
          };
          return callback(mockDb);
        },
      };

      // Mock queue enqueue failure
      const mockBoss = {
        send: vi.fn().mockRejectedValueOnce(new Error('PgBoss connection pool exhausted')),
      };
      vi.spyOn(jobsModule, 'getPgBoss').mockReturnValue(mockBoss as any);

      // Mock system DB: handles both the pre-check (selectFrom) and the post-failure recovery (updateTable)
      vi.spyOn(databaseModule, 'withSystemContext').mockImplementation(async (callback: any) => {
        const mockSysDb: any = {
          selectFrom: () => ({
            where: () => ({
              select: () => ({
                executeTakeFirst: async () => null, // no existing user with email
              }),
            }),
          }),
          insertInto: () => ({
            values: () => ({
              execute: async () => [],
            }),
          }),
          updateTable: () => ({
            set: (vals: any) => ({
              where: () => ({
                execute: async () => {
                  recoveryDbUpdated = true;
                  updatedStatus = vals.email_delivery_status;
                  updatedReason = vals.email_failure_reason;
                  return [];
                },
              }),
            }),
          }),
        };
        return callback(mockSysDb);
      });

      await expect(
        createInvitation(mockScopedDb, {
          workspaceId: 'ws-uuid-5678',
          inviterId: 'user-uuid-admin',
          role: 'editor',
          email: 'newuser@example.com',
        }),
      ).rejects.toThrow(/Failed to enqueue invitation delivery job/);

      expect(recoveryDbUpdated).toBe(true);
      expect(updatedStatus).toBe('failed');
      expect(updatedReason).toBe('QUEUE_ENQUEUE_FAILED');
    });
  });
});
