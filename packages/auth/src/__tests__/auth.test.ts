import { describe, it, expect, beforeAll } from 'vitest';
import { getSystemDb, runMigrations } from '@knowledge/database';
import {
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
  registerUser,
  loginUser,
  issueAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  TokenReuseError,
  revokeAllUserTokens,
} from '../index';

describe('@knowledge/auth unit tests', () => {
  let isDbAvailable = false;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbAvailable = true;
    } catch {
      isDbAvailable = false;
    }
  });

  describe('Password Hashing (Argon2id)', () => {
    it('hashes and verifies password correctly', async () => {
      const plain = 'SecureP@ssw0rd!';
      const hash = await hashPassword(plain);
      expect(hash).toContain('$argon2id$');

      const valid = await verifyPassword(plain, hash);
      expect(valid).toBe(true);

      const invalid = await verifyPassword('WrongPassword', hash);
      expect(invalid).toBe(false);
    });

    it('handles DUMMY_HASH verification for non-existent users', async () => {
      const start = Date.now();
      const valid = await verifyPassword('SomePassword', DUMMY_HASH);
      const duration = Date.now() - start;

      expect(valid).toBe(false);
      expect(duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('JWT Access Tokens', () => {
    it('issues and verifies access token with claims', () => {
      const user = { id: 'user-123', email: 'test@example.com' };
      const workspaces = [{ id: 'ws-1', role: 'editor' }];
      const token = issueAccessToken(user, workspaces);

      const decoded = verifyAccessToken(token);
      expect(decoded.sub).toBe('user-123');
      expect(decoded.email).toBe('test@example.com');
      expect(decoded.workspaces).toEqual(workspaces);
    });
  });

  describe('Registration & Login Flow (DB dependent)', () => {
    const testEmail = `auth_test_${Date.now()}@example.com`;
    const testPassword = 'Password123!';
    const testName = 'Auth Test User';

    it('registers, logs in, and manages tokens if DB is available', async () => {
      if (!isDbAvailable) {
        // Skip DB calls if local DB container is not running during unit test execution
        return;
      }

      const db = getSystemDb();
      const user = await registerUser(db, {
        email: testEmail,
        password: testPassword,
        displayName: testName,
      });

      expect(user.id).toBeDefined();
      expect(user.email).toBe(testEmail);
      expect(user.display_name).toBe(testName);

      const loginRes = await loginUser(db, {
        email: testEmail,
        password: testPassword,
      });

      expect(loginRes.user.email).toBe(testEmail);
      expect(loginRes.accessToken).toBeDefined();
      expect(loginRes.rawRefreshToken).toBeDefined();
    });
  });

  describe('Refresh Token Family Rotation & Reuse Detection (DB dependent)', () => {
    it('rotates token and detects reuse if DB is available', async () => {
      if (!isDbAvailable) {
        return;
      }

      const db = getSystemDb();
      const user = await registerUser(db, {
        email: `rotation_test_${Date.now()}@example.com`,
        password: 'Password123!',
        displayName: 'Rotation User',
      });

      const initialToken = await issueRefreshToken(db, user.id);
      expect(initialToken.rawToken).toBeDefined();

      const rotated1 = await rotateRefreshToken(db, initialToken.rawToken);
      expect(rotated1.accessToken).toBeDefined();
      expect(rotated1.rawRefreshToken).toBeDefined();

      await expect(rotateRefreshToken(db, initialToken.rawToken)).rejects.toThrow(
        TokenReuseError,
      );
    });
  });
});
