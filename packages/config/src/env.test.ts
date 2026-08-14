import { describe, it, expect } from 'vitest';
import { parseEnv } from './env';

describe('env configuration schema', () => {
  it('parses valid environment configuration', () => {
    const valid = {
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
    const parsed = parseEnv(valid);
    expect(parsed.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(parsed.NODE_ENV).toBe('test');
  });

  it('fails validation when mandatory URL is invalid or missing', () => {
    const invalid = {
      DATABASE_URL: 'not-a-url',
      REDIS_URL: 'redis://localhost:6379',
      QDRANT_URL: 'http://localhost:6333',
      MINIO_ENDPOINT: 'http://localhost:9000',
      MINIO_ACCESS_KEY: 'minioadmin',
      MINIO_SECRET_KEY: 'minioadmin',
      LITELLM_URL: 'http://localhost:4000',
      JWT_SECRET: 'test-secret-key',
    };
    expect(() => parseEnv(invalid)).toThrow();
  });
});
