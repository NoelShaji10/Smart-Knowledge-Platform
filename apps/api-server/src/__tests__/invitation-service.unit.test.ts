import { describe, it, expect } from 'vitest';
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
});
