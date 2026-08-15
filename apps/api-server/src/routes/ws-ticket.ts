import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { getEnv } from '@knowledge/config';
import { getRedisClient } from '@knowledge/redis';
import { authMiddleware } from '../middleware/auth';
import { rlsMiddleware } from '../middleware/rls';
import { rateLimiter } from '../middleware/rate-limiter';
import { emitAuditEvent } from '../lib/audit';

export const wsTicketRouter: Router = Router();

const env = getEnv();

const ticketRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  documentId: z.string().uuid(),
});

wsTicketRouter.post(
  '/api/v1/ws/ticket',
  authMiddleware,
  rlsMiddleware,
  rateLimiter({
    keyPrefix: 'ws_ticket',
    windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: env.RATE_LIMIT_WS_TICKET,
    failClosed: true, // Safeguard: fail closed if Redis is unavailable for ticket issuance
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { workspaceId, documentId } = ticketRequestSchema.parse(req.body);
      const userId = req.user!.userId;

      // DB-authoritative permission checks
      const authz = await req.db!.execute(async (db) => {
        // 1. Verify workspace membership
        const member = await db
          .selectFrom('workspace_members')
          .where('workspace_id', '=', workspaceId)
          .where('user_id', '=', userId)
          .select(['role'])
          .executeTakeFirst();

        if (!member) {
          return { allowed: false, reason: 'Not a workspace member' };
        }

        // 2. Verify document belongs to workspace
        const doc = await db
          .selectFrom('documents')
          .where('id', '=', documentId)
          .select(['workspace_id'])
          .executeTakeFirst();

        if (!doc) {
          return { allowed: false, reason: 'Document not found' };
        }

        if (doc.workspace_id !== workspaceId) {
          return { allowed: false, reason: 'Document does not belong to workspace' };
        }

        // 3. Verify user does not have explicit 'none' permission on document
        const docPerm = await db
          .selectFrom('document_permissions')
          .where('document_id', '=', documentId)
          .where('user_id', '=', userId)
          .select(['role'])
          .executeTakeFirst();

        if (docPerm && docPerm.role === 'none') {
          return { allowed: false, reason: 'Explicit document access denied' };
        }

        return { allowed: true };
      });

      if (!authz.allowed) {
        res.status(403).json({ error: authz.reason });
        return;
      }

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

      await req.db!.execute(async (trx) => {
        await emitAuditEvent(trx, {
          workspaceId,
          actorId: userId,
          action: 'ws.ticket.issued',
          resourceType: 'document',
          resourceId: documentId,
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
      });

      res.json({ ticket });
    } catch (err) {
      next(err);
    }
  },
);
