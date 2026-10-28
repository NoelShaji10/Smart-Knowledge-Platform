import { describe, it, expect, vi } from 'vitest';
import { createEmailTransport } from '../transport-factory';
import { MockEmailTransport } from '../mock-transport';
import { SmtpEmailTransport } from '../smtp-transport';
import { Env } from '@knowledge/config';

describe('createEmailTransport factory', () => {
  const baseMockEnv: Env = {
    NODE_ENV: 'test',
    PORT: '3000',
    COLLAB_PORT: '3001',
    DATABASE_URL: 'postgres://localhost:5432/db',
    MIGRATION_DATABASE_URL: 'postgres://localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    QDRANT_URL: 'http://localhost:6333',
    MINIO_ENDPOINT: 'http://localhost:9000',
    MINIO_ACCESS_KEY: 'minioadmin',
    MINIO_SECRET_KEY: 'minioadmin',
    LITELLM_URL: 'http://localhost:4000',
    JWT_SECRET: 'jwt-secret-min-8',
    JWT_ACCESS_EXPIRY: '1h',
    JWT_REFRESH_EXPIRY_DAYS: 7,
    ARGON2_TIME_COST: 3,
    ARGON2_MEMORY_COST: 65536,
    ARGON2_PARALLELISM: 1,
    RATE_LIMIT_REGISTER: 5,
    RATE_LIMIT_LOGIN: 10,
    RATE_LIMIT_REFRESH: 30,
    RATE_LIMIT_WS_TICKET: 30,
    RATE_LIMIT_WINDOW_SECONDS: 60,
    SNAPSHOT_DEBOUNCE_MS: 2000,
    INTERNAL_SERVICE_KEY: 'internal-secret-min-8',
    EMAIL_PROVIDER: 'mock',
    EMAIL_FROM: 'no-reply@knowledgeplatform.local',
    WEB_APP_URL: 'http://localhost:3000',
    SMTP_PORT: 587,
    SMTP_SECURE: false,
    EMAIL_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=',
    EMAIL_ENCRYPTION_KEY_ID: 'v1',
  };

  it('instantiates MockEmailTransport when EMAIL_PROVIDER is mock', () => {
    const transport = createEmailTransport(baseMockEnv);
    expect(transport).toBeInstanceOf(MockEmailTransport);
    expect(transport.providerName).toBe('mock');
  });

  it('instantiates SmtpEmailTransport when EMAIL_PROVIDER is smtp', () => {
    const mockTransporterFactory = vi.fn().mockReturnValue({ sendMail: vi.fn() } as any);
    const smtpEnv: Env = {
      ...baseMockEnv,
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.sendgrid.net',
      SMTP_PORT: 587,
      SMTP_USER: 'apikey',
      SMTP_PASS: 'secret',
      SMTP_SECURE: true,
    };

    const transport = createEmailTransport(smtpEnv, mockTransporterFactory);
    expect(transport).toBeInstanceOf(SmtpEmailTransport);
    expect(transport.providerName).toBe('smtp');
    expect(mockTransporterFactory).toHaveBeenCalledWith({
      host: 'smtp.sendgrid.net',
      port: 587,
      secure: true,
      from: 'no-reply@knowledgeplatform.local',
      auth: {
        user: 'apikey',
        pass: 'secret',
      },
    });
  });
});
