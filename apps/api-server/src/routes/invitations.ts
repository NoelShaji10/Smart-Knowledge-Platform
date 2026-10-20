import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getEnv } from '@knowledge/config';
import { InvitationRole } from '@knowledge/types';
import { authMiddleware } from '../middleware/auth';
import { rlsMiddleware } from '../middleware/rls';
import { requireWorkspace } from '../middleware/require-workspace';
import { rateLimiter } from '../middleware/rate-limiter';
import * as invitationService from '../lib/invitation-service';

export const invitationRouter: Router = Router();

const env = getEnv();

const uuidParamSchema = z.string().uuid();

const createInvitationSchema = z.object({
  role: z.string({ required_error: 'Role is required' }),
  email: z.string().optional().nullable(),
  expiresInDays: z.number().int().positive().max(30).optional(),
});

function validateWorkspaceId(req: Request, _res: Response, next: NextFunction) {
  try {
    uuidParamSchema.parse(req.params.workspaceId);
    next();
  } catch (err) {
    next(err);
  }
}

function validateInvitationId(req: Request, _res: Response, next: NextFunction) {
  try {
    uuidParamSchema.parse(req.params.invitationId);
    next();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// 1. Workspace-scoped endpoints
// ---------------------------------------------------------------------------

/**
 * POST /api/v1/workspaces/:workspaceId/invitations
 * Creates an email-bound or shareable invitation for a workspace.
 * Requires admin or owner role in the workspace.
 * Authenticated rate limiter runs before requireWorkspace to protect DB from burst load.
 */
invitationRouter.post(
  '/api/v1/workspaces/:workspaceId/invitations',
  authMiddleware,
  rlsMiddleware,
  validateWorkspaceId,
  rateLimiter({
    keyPrefix: 'invitation-create',
    windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: 30,
    failClosed: true,
    keyExtractor: (req) => req.user?.userId || req.ip || 'unknown',
  }),
  requireWorkspace('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      const { role, email, expiresInDays } = createInvitationSchema.parse(req.body);

      const result = await invitationService.createInvitation(req.db!, {
        workspaceId,
        inviterId: req.user!.userId,
        role: role as InvitationRole,
        email: email ?? null,
        expiresInDays,
        auditContext: {
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        },
      });

      res.status(201).json({
        invitation: result.invitation,
        rawToken: result.rawToken,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/v1/workspaces/:workspaceId/invitations
 * Lists all invitations for a workspace. Never exposes raw tokens or token hashes.
 * Requires admin or owner role in the workspace.
 */
invitationRouter.get(
  '/api/v1/workspaces/:workspaceId/invitations',
  authMiddleware,
  rlsMiddleware,
  validateWorkspaceId,
  requireWorkspace('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;

      const invitations = await invitationService.listWorkspaceInvitations(
        req.db!,
        workspaceId,
        req.user!.userId,
      );

      res.json({ invitations });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * DELETE /api/v1/workspaces/:workspaceId/invitations/:invitationId
 * Revokes a pending workspace invitation.
 * Requires admin or owner role in the workspace (Owners only for Admin invitations).
 */
invitationRouter.delete(
  '/api/v1/workspaces/:workspaceId/invitations/:invitationId',
  authMiddleware,
  rlsMiddleware,
  validateWorkspaceId,
  validateInvitationId,
  requireWorkspace('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      const invitationId = req.params.invitationId;

      const result = await invitationService.revokeWorkspaceInvitation(
        req.db!,
        workspaceId,
        invitationId,
        req.user!.userId,
        {
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        },
      );

      res.json({
        ok: result.ok,
        message: 'Invitation revoked successfully',
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/v1/workspaces/:workspaceId/invitations/:invitationId/resend
 * Replaces and resends an invitation with a fresh secret and expiration.
 * Requires admin or owner role in the workspace (Owners only for Admin invitations).
 * Authenticated rate limiter runs before requireWorkspace to protect DB from burst load.
 */
invitationRouter.post(
  '/api/v1/workspaces/:workspaceId/invitations/:invitationId/resend',
  authMiddleware,
  rlsMiddleware,
  validateWorkspaceId,
  validateInvitationId,
  rateLimiter({
    keyPrefix: 'invitation-resend',
    windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: 30,
    failClosed: true,
    keyExtractor: (req) => req.user?.userId || req.ip || 'unknown',
  }),
  requireWorkspace('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      const invitationId = req.params.invitationId;

      const result = await invitationService.resendWorkspaceInvitation(
        req.db!,
        workspaceId,
        invitationId,
        req.user!.userId,
        {
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        },
      );

      res.json({
        invitation: result.invitation,
        rawToken: result.rawToken,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// 2. Public invitation resolution & acceptance
// ---------------------------------------------------------------------------

/**
 * GET /api/v1/invitations/:token
 * Public endpoint to resolve an invitation token into sanitized metadata.
 * Does not require authentication and does not mutate or consume the invitation.
 * Uses native req.ip directly to prevent untrusted X-Forwarded-For spoofing.
 * Does NOT place raw tokens in the rate-limit key.
 */
invitationRouter.get(
  '/api/v1/invitations/:token',
  rateLimiter({
    keyPrefix: 'invitation-resolve',
    windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: 60,
    failClosed: true,
    keyExtractor: (req) => req.ip || 'unknown',
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.params.token;
      if (!token || typeof token !== 'string' || token.trim().length === 0) {
        res.status(400).json({ error: 'Invitation token is required', code: 'VALIDATION_ERROR' });
        return;
      }

      const invitation = await invitationService.resolveInvitationToken(token);

      res.json({ invitation });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/v1/invitations/:token/accept
 * Authenticated endpoint to accept an invitation.
 * Derives user identity strictly from req.user (never from client request body).
 * Fails closed on unverified emails for email-bound invitations.
 */
invitationRouter.post(
  '/api/v1/invitations/:token/accept',
  authMiddleware,
  rateLimiter({
    keyPrefix: 'invitation-accept',
    windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: 30,
    failClosed: true,
    keyExtractor: (req) => req.user?.userId || req.ip || 'unknown',
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.params.token;
      if (!token || typeof token !== 'string' || token.trim().length === 0) {
        res.status(400).json({ error: 'Invitation token is required', code: 'VALIDATION_ERROR' });
        return;
      }

      // Security invariant: identity and verification claim are derived strictly
      // from the server-validated session context, NEVER trusted from request body.
      const sessionUser = {
        userId: req.user!.userId,
        email: req.user!.email,
        emailVerified: (req.user as any).emailVerified,
      };

      const result = await invitationService.acceptInvitation(token, sessionUser, {
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.json({
        status: result.status,
        workspaceId: result.workspaceId,
        role: result.role,
      });
    } catch (err) {
      next(err);
    }
  },
);
