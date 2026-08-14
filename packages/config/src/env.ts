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
  DATABASE_URL: z.string().url().default('postgres://app:app@localhost:5432/knowledge'),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  QDRANT_URL: z.string().url().default('http://localhost:6333'),
  MINIO_ENDPOINT: z.string().url().default('http://localhost:9000'),
  MINIO_ACCESS_KEY: z.string().min(1).default('minioadmin'),
  MINIO_SECRET_KEY: z.string().min(1).default('minioadmin'),
  LITELLM_URL: z.string().url().default('http://localhost:4000'),
  JWT_SECRET: z.string().min(8).default('test-secret-jwt-key-min-8-chars'),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(customEnv?: Record<string, string | undefined>): Env {
  const source = customEnv || process.env;
  return envSchema.parse(source);
}

export function getEnv(): Env {
  return parseEnv();
}
