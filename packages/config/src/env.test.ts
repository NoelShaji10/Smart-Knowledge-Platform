import { describe, it, expect } from 'vitest';
import { parseEnv } from './env';

describe('env configuration schema', () => {
  const baseValid = {
    NODE_ENV: 'test',
    PORT: '3000',
    COLLAB_PORT: '3001',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    QDRANT_URL: 'http://localhost:6333',
    MINIO_ENDPOINT: 'http://localhost:9000',
    MINIO_ACCESS_KEY: 'minioadmin',
    MINIO_SECRET_KEY: 'minioadmin',
    LITELLM_URL: 'http://localhost:4000',
    JWT_SECRET: 'test-secret-key-123456',
  };

  it('parses valid environment configuration with defaults', () => {
    const parsed = parseEnv(baseValid);
    expect(parsed.DATABASE_URL).toBe(baseValid.DATABASE_URL);
    expect(parsed.NODE_ENV).toBe('test');
    expect(parsed.EMAIL_PROVIDER).toBe('mock');
    expect(parsed.WEB_APP_URL).toBe('http://localhost:3000');
    expect(parsed.EMAIL_FROM).toBe('no-reply@knowledgeplatform.local');
  });

  it('fails validation when mandatory URL is invalid or missing', () => {
    const invalid = {
      ...baseValid,
      DATABASE_URL: 'not-a-url',
    };
    expect(() => parseEnv(invalid)).toThrow();
  });

  it('validates WEB_APP_URL as an absolute http or https URL', () => {
    expect(() =>
      parseEnv({
        ...baseValid,
        WEB_APP_URL: 'invalid-url',
      }),
    ).toThrow();

    expect(() =>
      parseEnv({
        ...baseValid,
        WEB_APP_URL: '/relative/path',
      }),
    ).toThrow();

    expect(() =>
      parseEnv({
        ...baseValid,
        WEB_APP_URL: 'ftp://localhost:3000',
      }),
    ).toThrow(/http or https/i);

    const validCustomUrl = parseEnv({
      ...baseValid,
      WEB_APP_URL: 'https://knowledge.example.com',
    });
    expect(validCustomUrl.WEB_APP_URL).toBe('https://knowledge.example.com');
  });

  it('requires SMTP_HOST when EMAIL_PROVIDER is smtp', () => {
    expect(() =>
      parseEnv({
        ...baseValid,
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: '',
      }),
    ).toThrow(/SMTP_HOST is required/);

    const validSmtp = parseEnv({
      ...baseValid,
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.mailgun.org',
      SMTP_PORT: '587',
    });
    expect(validSmtp.EMAIL_PROVIDER).toBe('smtp');
    expect(validSmtp.SMTP_HOST).toBe('smtp.mailgun.org');
    expect(validSmtp.SMTP_PORT).toBe(587);
  });

  it('ensures production configuration cannot silently select mock delivery', () => {
    // When in production with no EMAIL_PROVIDER specified, it defaults to smtp and demands SMTP settings
    expect(() =>
      parseEnv({
        ...baseValid,
        NODE_ENV: 'production',
      }),
    ).toThrow(/SMTP_HOST is required/);

    // Explicitly requesting mock delivery in production is rejected
    expect(() =>
      parseEnv({
        ...baseValid,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'mock',
      }),
    ).toThrow(/cannot be set to mock in production/i);
  });

  it('requires SMTP credentials in production when EMAIL_PROVIDER is smtp', () => {
    expect(() =>
      parseEnv({
        ...baseValid,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.sendgrid.net',
        // Missing SMTP_USER and SMTP_PASS
      }),
    ).toThrow(/SMTP_USER is required in production/);

    expect(() =>
      parseEnv({
        ...baseValid,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.sendgrid.net',
        SMTP_USER: 'apikey',
        // Missing SMTP_PASS
      }),
    ).toThrow(/SMTP_PASS is required in production/);

    const validProd = parseEnv({
      ...baseValid,
      NODE_ENV: 'production',
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.sendgrid.net',
      SMTP_USER: 'apikey',
      SMTP_PASS: 'secret-smtp-password',
      SMTP_SECURE: 'true',
      EMAIL_ENCRYPTION_KEY: Buffer.from('a'.repeat(32)).toString('base64'),
    });
    expect(validProd.NODE_ENV).toBe('production');
    expect(validProd.EMAIL_PROVIDER).toBe('smtp');
    expect(validProd.SMTP_SECURE).toBe(true);
    expect(validProd.EMAIL_ENCRYPTION_KEY).toBe(Buffer.from('a'.repeat(32)).toString('base64'));
  });

  it('validates EMAIL_ENCRYPTION_KEY length and production requirements', () => {
    // Missing key in production
    expect(() =>
      parseEnv({
        ...baseValid,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'admin',
        SMTP_PASS: 'secret',
        EMAIL_ENCRYPTION_KEY: '',
      }),
    ).toThrow(/EMAIL_ENCRYPTION_KEY is required in production/);

    // Dev default key used in production
    const devDefaultKey = Buffer.from('01234567890123456789012345678901').toString('base64');
    expect(() =>
      parseEnv({
        ...baseValid,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'admin',
        SMTP_PASS: 'secret',
        EMAIL_ENCRYPTION_KEY: devDefaultKey,
      }),
    ).toThrow(/cannot use default development key in production/);

    // Invalid length (16 bytes instead of 32)
    const shortKey = Buffer.from('1234567890123456').toString('base64');
    expect(() =>
      parseEnv({
        ...baseValid,
        EMAIL_ENCRYPTION_KEY: shortKey,
      }),
    ).toThrow(/must decode to exactly 32 bytes/);

    // Valid 64-char hex key
    const hexKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const parsedHex = parseEnv({
      ...baseValid,
      EMAIL_ENCRYPTION_KEY: hexKey,
    });
    expect(parsedHex.EMAIL_ENCRYPTION_KEY).toBe(hexKey);

    // Rejects dev key when configured in hex representation in production (AUD-T2-01)
    const hexDevKey = Buffer.from('01234567890123456789012345678901').toString('hex');
    expect(() =>
      parseEnv({
        ...baseValid,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'admin',
        SMTP_PASS: 'secret',
        EMAIL_ENCRYPTION_KEY: hexDevKey,
      }),
    ).toThrow(/cannot use default development key in production/);

    // Rejects non-canonical base64 containing invalid characters or whitespace (AUD-T2-03)
    expect(() =>
      parseEnv({
        ...baseValid,
        EMAIL_ENCRYPTION_KEY: 'not-valid-base64!@#$%^&*()1234567890abcdef==',
      }),
    ).toThrow(/strictly-encoded/);
  });

  it('rejects WEB_APP_URL with embedded credentials (AUD-T2-04)', () => {
    expect(() =>
      parseEnv({
        ...baseValid,
        WEB_APP_URL: 'https://admin:secret@app.knowledgeplatform.com',
      }),
    ).toThrow(/WEB_APP_URL must not contain embedded username or password credentials/);
  });

  it('validates EMAIL_PREVIOUS_ENCRYPTION_KEYS for key rotation (AUD-T2-02)', () => {
    const validKey1 = Buffer.from('1'.repeat(32)).toString('base64');
    const validKey2 = Buffer.from('2'.repeat(32)).toString('hex');

    const parsed = parseEnv({
      ...baseValid,
      EMAIL_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({
        'key-2025': validKey1,
        'key-2024': validKey2,
      }),
    });
    expect(parsed.EMAIL_PREVIOUS_ENCRYPTION_KEYS).toBeDefined();

    // Rejects invalid JSON or invalid key format in ring
    expect(() =>
      parseEnv({
        ...baseValid,
        EMAIL_PREVIOUS_ENCRYPTION_KEYS: 'not-json',
      }),
    ).toThrow(/must be a valid JSON string/);

    expect(() =>
      parseEnv({
        ...baseValid,
        EMAIL_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({
          'key-bad': 'too-short-key',
        }),
      }),
    ).toThrow(/not a valid strictly-encoded 32-byte key/);
  });

  it('surfaces SMTP configuration errors clearly without exposing secrets', () => {
    try {
      parseEnv({
        ...baseValid,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'admin',
        SMTP_PASS: '', // empty password
        EMAIL_ENCRYPTION_KEY: Buffer.from('b'.repeat(32)).toString('base64'),
      });
      expect.fail('Expected parseEnv to throw');
    } catch (err: any) {
      expect(err.message).toContain('SMTP_PASS is required');
      expect(err.message).not.toContain('secret-smtp-password');
    }
  });
});
