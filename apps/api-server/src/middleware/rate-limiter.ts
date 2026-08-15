import { Request, Response, NextFunction } from 'express';
import { getRedisClient } from '@knowledge/redis';

export interface RateLimiterOptions {
  keyPrefix: string;
  windowSeconds: number;
  maxRequests: number;
  failClosed?: boolean;
  keyExtractor?: (req: Request) => string;
}

export function rateLimiter(opts: RateLimiterOptions) {
  const failClosed = opts.failClosed ?? true;

  return async (req: Request, res: Response, next: NextFunction) => {
    const identifier = opts.keyExtractor?.(req) || req.ip || 'unknown';
    const key = `rate:${opts.keyPrefix}:${identifier}`;

    try {
      const redis = getRedisClient();
      const count = await redis.incr(key);

      if (count === 1) {
        await redis.expire(key, opts.windowSeconds);
      }

      if (count > opts.maxRequests) {
        const ttl = await redis.ttl(key);
        res.status(429).json({
          error: 'Too many requests',
          retryAfter: ttl > 0 ? ttl : opts.windowSeconds,
        });
        return;
      }

      next();
    } catch (err) {
      if (failClosed) {
        res.status(503).json({ error: 'Rate limiter unavailable' });
        return;
      }
      next();
    }
  };
}
