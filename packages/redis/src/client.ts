import Redis from 'ioredis';
import { getEnv } from '@knowledge/config';

let dataRedisInstance: Redis | null = null;
let subRedisInstance: Redis | null = null;

export function getRedisClient(): Redis {
  if (!dataRedisInstance) {
    const env = getEnv();
    dataRedisInstance = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true,
      lazyConnect: false,
    });
    dataRedisInstance.on('error', () => {
      // suppress unhandled error listener crash in offline test environments
    });
  }
  return dataRedisInstance;
}

export function getRedisSubscriber(): Redis {
  if (!subRedisInstance) {
    const env = getEnv();
    subRedisInstance = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    subRedisInstance.on('error', () => {
      // suppress unhandled error listener crash in offline test environments
    });
  }
  return subRedisInstance;
}
