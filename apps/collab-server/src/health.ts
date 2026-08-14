import { checkRedisHealth } from '@knowledge/redis';
import { checkDatabaseHealth } from '@knowledge/database';
import { checkStorageHealth } from '@knowledge/storage';

export async function checkCollabServerHealth() {
  const [redis, db, storage] = await Promise.all([
    checkRedisHealth(),
    checkDatabaseHealth(),
    checkStorageHealth(),
  ]);

  const healthy = redis.healthy && db.healthy && storage.healthy;
  return {
    healthy,
    components: { redis, db, storage },
  };
}
