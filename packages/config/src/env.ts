import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: '.env' });
if (!process.env.DATABASE_URL) {
  dotenv.config({ path: path.resolve(__dirname, '../../../.env.test') });
  dotenv.config({ path: '.env.test' });
}

export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().default('3000'),
  COLLAB_PORT: z.string().default('3001'),
  DATABASE_URL: z.string().url().default('postgres://knowledge_app:knowledge_app@localhost:5432/knowledge'),
  MIGRATION_DATABASE_URL: z.string().url().default('postgres://app:app@localhost:5432/knowledge'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  QDRANT_URL: z.string().url().default('http://localhost:6333'),
  MINIO_ENDPOINT: z.string().url().default('http://localhost:9000'),
  MINIO_ACCESS_KEY: z.string().min(1).default('minioadmin'),
  MINIO_SECRET_KEY: z.string().min(1).default('minioadmin'),
  LITELLM_URL: z.string().url().default('http://localhost:4000'),
  JWT_SECRET: z.string().min(8).default('test-secret-jwt-key-min-8-chars'),
  JWT_ACCESS_EXPIRY: z.string().default('1h'),
  JWT_REFRESH_EXPIRY_DAYS: z.coerce.number().default(7),
  ARGON2_TIME_COST: z.coerce.number().default(3),
  ARGON2_MEMORY_COST: z.coerce.number().default(65536),
  ARGON2_PARALLELISM: z.coerce.number().default(1),
  RATE_LIMIT_REGISTER: z.coerce.number().default(5),
  RATE_LIMIT_LOGIN: z.coerce.number().default(10),
  RATE_LIMIT_REFRESH: z.coerce.number().default(30),
  RATE_LIMIT_WS_TICKET: z.coerce.number().default(30),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().default(60),
  SNAPSHOT_DEBOUNCE_MS: z.coerce.number().default(2000),
  INTERNAL_SERVICE_KEY: z.string().min(8).default('internal-service-secret-key-min-8-chars'),

  // Email & Delivery Configuration
  EMAIL_PROVIDER: z.enum(['mock', 'smtp']).optional(),
  EMAIL_FROM: z.string().email().default('no-reply@knowledgeplatform.local'),
  WEB_APP_URL: z.string().url().default('http://localhost:3000'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: z.coerce.boolean().default(false),
  EMAIL_ENCRYPTION_KEY: z.string().optional(),
  EMAIL_ENCRYPTION_KEY_ID: z.string().min(1).default('v1'),
  EMAIL_PREVIOUS_ENCRYPTION_KEYS: z.string().optional(),
});

const STRICT_HEX_KEY_REGEX = /^[0-9a-fA-F]{64}$/;
const STRICT_BASE64_KEY_REGEX = /^[A-Za-z0-9+/]{43}=$/;
const DEV_DEFAULT_KEY_BUF = Buffer.from('01234567890123456789012345678901');
const DEV_DEFAULT_ENCRYPTION_KEY = DEV_DEFAULT_KEY_BUF.toString('base64');

export function decodeStrict32ByteKey(rawInput: string): Buffer | null {
  const raw = rawInput.trim();
  if (STRICT_HEX_KEY_REGEX.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  if (STRICT_BASE64_KEY_REGEX.test(raw)) {
    const buf = Buffer.from(raw, 'base64');
    return buf.length === 32 ? buf : null;
  }
  return null;
}

export const envSchema = baseEnvSchema
  .transform((data) => {
    // In production, default to 'smtp' if not set; in dev/test default to 'mock'
    const provider = data.EMAIL_PROVIDER ?? (data.NODE_ENV === 'production' ? 'smtp' : 'mock');
    const encryptionKey =
      data.EMAIL_ENCRYPTION_KEY ??
      (data.NODE_ENV === 'production' ? undefined : DEV_DEFAULT_ENCRYPTION_KEY);

    return {
      ...data,
      EMAIL_PROVIDER: provider as 'mock' | 'smtp',
      EMAIL_ENCRYPTION_KEY: encryptionKey,
    };
  })
  .superRefine((data, ctx) => {
    // 1. Validate WEB_APP_URL protocol and credentials
    try {
      const parsedUrl = new URL(data.WEB_APP_URL);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEB_APP_URL'],
          message: 'WEB_APP_URL must use http or https protocol',
        });
      }
      if (parsedUrl.username || parsedUrl.password) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['WEB_APP_URL'],
          message: 'WEB_APP_URL must not contain embedded username or password credentials',
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WEB_APP_URL'],
        message: 'WEB_APP_URL must be a valid absolute URL',
      });
    }

    // 2. Production configuration cannot silently select mock delivery or run with mock delivery
    if (data.NODE_ENV === 'production' && data.EMAIL_PROVIDER === 'mock') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_PROVIDER'],
        message: 'EMAIL_PROVIDER cannot be set to mock in production environment',
      });
    }

    // 3. SMTP configuration validation
    if (data.EMAIL_PROVIDER === 'smtp') {
      if (!data.SMTP_HOST || data.SMTP_HOST.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SMTP_HOST'],
          message: 'SMTP_HOST is required when EMAIL_PROVIDER is "smtp"',
        });
      }

      if (data.NODE_ENV === 'production') {
        if (!data.SMTP_USER || data.SMTP_USER.trim().length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['SMTP_USER'],
            message: 'SMTP_USER is required in production when EMAIL_PROVIDER is "smtp"',
          });
        }
        if (!data.SMTP_PASS || data.SMTP_PASS.trim().length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['SMTP_PASS'],
            message: 'SMTP_PASS is required in production when EMAIL_PROVIDER is "smtp"',
          });
        }
      }
    }

    // 4. Token payload encryption key validation
    if (data.NODE_ENV === 'production') {
      if (!data.EMAIL_ENCRYPTION_KEY || data.EMAIL_ENCRYPTION_KEY.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EMAIL_ENCRYPTION_KEY'],
          message: 'EMAIL_ENCRYPTION_KEY is required in production environment',
        });
      }
    }

    if (data.EMAIL_ENCRYPTION_KEY) {
      const decodedKey = decodeStrict32ByteKey(data.EMAIL_ENCRYPTION_KEY);
      if (!decodedKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EMAIL_ENCRYPTION_KEY'],
          message:
            'EMAIL_ENCRYPTION_KEY must decode to exactly 32 bytes and be strictly-encoded (44-character base64 with "=" padding or 64-character hex)',
        });
      } else if (
        data.NODE_ENV === 'production' &&
        crypto.timingSafeEqual(decodedKey, DEV_DEFAULT_KEY_BUF)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EMAIL_ENCRYPTION_KEY'],
          message: 'EMAIL_ENCRYPTION_KEY cannot use default development key in production',
        });
      }
    }

    // 5. Previous encryption keys ring validation (for zero-downtime key rotation)
    if (data.EMAIL_PREVIOUS_ENCRYPTION_KEYS) {
      try {
        const parsed = JSON.parse(data.EMAIL_PREVIOUS_ENCRYPTION_KEYS);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['EMAIL_PREVIOUS_ENCRYPTION_KEYS'],
            message: 'EMAIL_PREVIOUS_ENCRYPTION_KEYS must be a JSON object mapping key IDs to key strings',
          });
        } else {
          for (const [keyId, keyVal] of Object.entries(parsed)) {
            if (typeof keyVal !== 'string' || !decodeStrict32ByteKey(keyVal)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['EMAIL_PREVIOUS_ENCRYPTION_KEYS'],
                message: `Previous encryption key for id "${keyId}" is not a valid strictly-encoded 32-byte key`,
              });
            }
          }
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['EMAIL_PREVIOUS_ENCRYPTION_KEYS'],
          message: 'EMAIL_PREVIOUS_ENCRYPTION_KEYS must be a valid JSON string',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function parseEnv(customEnv?: Record<string, string | undefined>): Env {
  const source = customEnv || process.env;
  return envSchema.parse(source);
}

export function getEnv(): Env {
  return parseEnv();
}

