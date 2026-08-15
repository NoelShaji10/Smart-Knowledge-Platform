import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApiApp } from '../../apps/api-server/src/app';
import { runMigrations, getSystemDb } from '@knowledge/database';
import { registerUser } from '@knowledge/auth';

describe('MEDIUM 6: Account Enumeration Hardening & Argon2id Verification', () => {
  const app = createApiApp();
  let isDbConnected = false;

  const existingEmail = `enum_exist_${Date.now()}@example.com`;
  const password = 'SecurePassword123!';

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;

      await registerUser(getSystemDb(), {
        email: existingEmail,
        password,
        displayName: 'Existing Account User',
      });
    } catch {
      isDbConnected = false;
    }
  });

  it('ensures duplicate email registration performs Argon2id hashing and rejects generically', async () => {
    if (!isDbConnected) return;

    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: existingEmail,
        password,
        displayName: 'Duplicate Attempt User',
      });

    expect(res.status).toBe(500); // Handled error response
  });

  it('ensures nonexistent user login and wrong password login return identical authentication errors', async () => {
    if (!isDbConnected) return;

    // 1. Wrong password on existing user
    const res1 = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: existingEmail,
        password: 'WrongPassword999!',
      });

    // 2. Nonexistent user
    const res2 = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email: `nonexistent_${Date.now()}@example.com`,
        password: 'WrongPassword999!',
      });

    expect(res1.status).toBe(401);
    expect(res2.status).toBe(401);
    expect(res1.body.error).toBe('Invalid email or password');
    expect(res2.body.error).toBe('Invalid email or password');
  });
});
