import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config({ path: '.env' });
if (!process.env.DATABASE_URL) {
  dotenv.config({ path: '.env.test' });
}

export const envSchema = z.object({
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
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(customEnv?: Record<string, string | undefined>): Env {
  const source = customEnv || process.env;
  return envSchema.parse(source);
}

export function getEnv(): Env {
  return parseEnv();
}
