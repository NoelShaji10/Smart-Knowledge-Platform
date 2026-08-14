import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { getRedisClient } from '@knowledge/redis';
import { authMiddleware } from '../middleware/auth';

export const wsTicketRouter: Router = Router();

const ticketRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  documentId: z.string().uuid(),
});

wsTicketRouter.post('/api/v1/ws/ticket', authMiddleware, async (req, res, next) => {
  try {
    const { workspaceId, documentId } = ticketRequestSchema.parse(req.body);
    const userId = req.user!.userId;

    // Generate 32-byte opaque random ticket
    const ticket = crypto.randomBytes(32).toString('hex');
    const redis = getRedisClient();

    const ticketData = {
      userId,
      workspaceId,
      documentId,
    };

    // Store in Redis with 30-second TTL
    await redis.setex(`ws_ticket:${ticket}`, 30, JSON.stringify(ticketData));

    res.json({ ticket });
  } catch (err) {
    next(err);
  }
});
