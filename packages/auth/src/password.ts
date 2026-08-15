import argon2 from 'argon2';
import { getEnv } from '@knowledge/config';

// Pre-computed dummy Argon2id hash for constant-time rejection of non-existent users
export const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$c29tZXNhbHQ$R3B2h3X9J1+qK8+7Y6G+8Z9A0B1C2D3E4F5G6H7I8J9';

export async function hashPassword(plain: string): Promise<string> {
  const env = getEnv();
  return argon2.hash(plain, {
    type: argon2.argon2id,
    timeCost: env.ARGON2_TIME_COST,
    memoryCost: env.ARGON2_MEMORY_COST,
    parallelism: env.ARGON2_PARALLELISM,
  });
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
