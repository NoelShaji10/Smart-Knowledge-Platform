import { Router } from 'express';
import { checkDatabaseHealth } from '@knowledge/database';
import { checkRedisHealth } from '@knowledge/redis';
import { checkStorageHealth } from '@knowledge/storage';
import { checkQdrantHealth } from '@knowledge/vector-store';
import { checkAIGatewayHealth } from '@knowledge/ai-gateway';

export const healthRouter: Router = Router();

healthRouter.get('/health', async (req, res) => {
  const [db, redis, storage, qdrant, aiGateway] = await Promise.all([
    checkDatabaseHealth(),
    checkRedisHealth(),
    checkStorageHealth(),
    checkQdrantHealth(),
    checkAIGatewayHealth(),
  ]);

  const healthy = db.healthy && redis.healthy && storage.healthy && qdrant.healthy && aiGateway.healthy;

  res.status(healthy ? 200 : 503).json({
    healthy,
    components: {
      db,
      redis,
      storage,
      qdrant,
      aiGateway,
    },
  });
});
