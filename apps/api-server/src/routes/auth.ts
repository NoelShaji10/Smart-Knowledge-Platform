import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getEnv } from '@knowledge/config';
import {
  registerUser,
  loginUser,
  rotateRefreshToken,
  revokeRefreshTokenByRaw,
  revokeAllUserTokens,
  verifyAccessToken,
  TokenReuseError,
  createEmailVerificationChallenge,
  requestEmailVerificationChallenge,
  verifyEmailToken,
  cleanupFailedVerificationChallenge,
  finalizeVerificationChallengeDelivery,
  InvalidVerificationTokenError,
  ExpiredVerificationTokenError,
  TokenAlreadyConsumedError,
} from '@knowledge/auth';
import { getEmailTransport, generateEmailVerificationEmail } from '@knowledge/email';
import { rateLimiter } from '../middleware/rate-limiter';
import { authMiddleware } from '../middleware/auth';
import { rlsMiddleware } from '../middleware/rls';
import { emitAuditEvent } from '../lib/audit';

export const authRouter: Router = Router();

const env = getEnv();

function setRefreshCookie(res: Response, rawToken: string, expiresAt: Date) {
  res.cookie('refreshToken', rawToken, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth',
    expires: expiresAt,
  });
}

function clearRefreshCookie(res: Response) {
  res.clearCookie('refreshToken', {
    path: '/api/v1/auth',
  });
}

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.get('/api/v1/auth/me', authMiddleware, rlsMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user || !req.db) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const userRow = await req.db.execute(async (db) => {
      return db
        .selectFrom('users')
        .where('id', '=', req.user!.userId)
        .select(['id', 'email', 'display_name', 'email_verified'])
        .executeTakeFirst();
    });

    if (!userRow) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      user: {
        id: userRow.id,
        email: userRow.email,
        displayName: userRow.display_name,
        emailVerified: Boolean(userRow.email_verified),
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post(
  '/api/v1/auth/register',
  rateLimiter({
    keyPrefix: 'register',
    windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: env.RATE_LIMIT_REGISTER,
    failClosed: true,
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, displayName } = registerSchema.parse(req.body);

      const user = await registerUser({ email, password, displayName });

      // Automatically log in newly registered user
      const loginRes = await loginUser({ email, password });

      setRefreshCookie(res, loginRes.rawRefreshToken, loginRes.refreshExpiresAt);

      await emitAuditEvent(null as any, {
        workspaceId: null,
        actorId: user.id,
        action: 'auth.register',
        resourceType: 'user',
        resourceId: user.id,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.status(201).json({
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
          emailVerified: false,
        },
        accessToken: loginRes.accessToken,
      });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post(
  '/api/v1/auth/login',
  rateLimiter({
    keyPrefix: 'login',
    windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: env.RATE_LIMIT_LOGIN,
    failClosed: true,
  }),
  async (req: Request, res: Response) => {
    try {
      const { email, password } = loginSchema.parse(req.body);

      const result = await loginUser({ email, password });

      setRefreshCookie(res, result.rawRefreshToken, result.refreshExpiresAt);

      await emitAuditEvent(null as any, {
        workspaceId: null,
        actorId: result.user.id,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: result.user.id,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.json({
        user: result.user,
        accessToken: result.accessToken,
      });
    } catch (err) {
      res.status(401).json({ error: (err as Error).message || 'Invalid email or password' });
    }
  },
);

authRouter.post(
  '/api/v1/auth/refresh',
  rateLimiter({
    keyPrefix: 'refresh',
    windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: env.RATE_LIMIT_REFRESH,
    failClosed: true,
  }),
  async (req: Request, res: Response) => {
    const rawToken = req.cookies?.refreshToken;
    if (!rawToken) {
      res.status(401).json({ error: 'Missing refresh token cookie' });
      return;
    }

    try {
      const result = await rotateRefreshToken(rawToken);

      setRefreshCookie(res, result.rawRefreshToken, result.expiresAt);

      await emitAuditEvent(null as any, {
        workspaceId: null,
        actorId: null,
        action: 'auth.token.refreshed',
        resourceType: 'session',
        resourceId: crypto.randomUUID(),
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.json({ accessToken: result.accessToken });
    } catch (err) {
      clearRefreshCookie(res);
      if (err instanceof TokenReuseError) {
        res.status(401).json({ error: 'token_reuse_detected' });
        return;
      }
      res.status(401).json({ error: (err as Error).message || 'Invalid refresh token' });
    }
  },
);

authRouter.post('/api/v1/auth/logout', async (req: Request, res: Response) => {
  const rawToken = req.cookies?.refreshToken;
  if (rawToken) {
    try {
      const info = await revokeRefreshTokenByRaw(rawToken);

      if (info) {
        await emitAuditEvent(null as any, {
          workspaceId: null,
          actorId: info.userId,
          action: 'auth.logout',
          resourceType: 'session',
          resourceId: info.familyId,
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
      }
    } catch {
      // Ignore cleanup error
    }
  }

  clearRefreshCookie(res);
  res.json({ ok: true });
});

authRouter.post('/api/v1/auth/logout-all', async (req: Request, res: Response) => {
  const rawToken = req.cookies?.refreshToken;
  if (!rawToken) {
    res.status(401).json({ error: 'Missing refresh token cookie' });
    return;
  }

  try {
    const info = await revokeRefreshTokenByRaw(rawToken);

    if (!info) {
      clearRefreshCookie(res);
      res.status(401).json({ error: 'Invalid refresh token' });
      return;
    }

    await revokeAllUserTokens(info.userId);
    clearRefreshCookie(res);

    await emitAuditEvent(null as any, {
      workspaceId: null,
      actorId: info.userId,
      action: 'auth.logout',
      resourceType: 'session',
      resourceId: info.userId,
      metadata: { scope: 'all' },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({ ok: true });
  } catch (err) {
    clearRefreshCookie(res);
    res.status(401).json({ error: (err as Error).message || 'Invalid refresh token' });
  }
});

const verifyEmailRequestSchema = z.object({
  email: z.string().email().optional(),
});

authRouter.post(
  '/api/v1/auth/verify-email/request',
  rateLimiter({
    keyPrefix: 'verify-email-req',
    windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: 5,
    failClosed: true,
    keyExtractor: (req) => {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const payload = verifyAccessToken(authHeader.substring(7));
          if (payload.sub) return payload.sub as string;
        } catch {}
      }
      return req.body?.email || req.ip || 'unknown';
    },
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = verifyEmailRequestSchema.parse(req.body || {});

      let targetUserId: string | null = null;
      let targetEmail: string | null = null;

      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const payload = verifyAccessToken(authHeader.substring(7));
          if (payload.sub && payload.email) {
            targetUserId = payload.sub as string;
            targetEmail = (payload.email as string).trim().toLowerCase();
          }
        } catch {}
      }

      if (!targetEmail && parsed.email) {
        targetEmail = parsed.email.trim().toLowerCase();
      }

      if (!targetEmail) {
        res.status(400).json({ error: 'Email address is required', code: 'VALIDATION_ERROR' });
        return;
      }

      const challengeRes = await requestEmailVerificationChallenge(
        {
          userId: targetUserId,
          email: targetEmail || undefined,
        },
        { deferInvalidation: true },
      );

      if (challengeRes.alreadyVerified) {
        res.json({ ok: true, message: 'Email is already verified.', alreadyVerified: true });
        return;
      }

      if (!challengeRes.challenge || !challengeRes.user) {
        // Prevent email enumeration by returning a generic response
        res.json({ ok: true, message: 'If an account exists, a verification email has been sent.' });
        return;
      }

      // Render email using template
      const emailMsg = generateEmailVerificationEmail({
        recipientEmail: challengeRes.user.email,
        displayName: challengeRes.user.displayName,
        rawToken: challengeRes.challenge.rawToken,
        expiresAt: challengeRes.challenge.expiresAt,
        webAppUrl: env.WEB_APP_URL,
        nodeEnv: env.NODE_ENV,
      });

      // Deliver via EmailTransport abstraction with identity-specific failure cleanup
      const transport = getEmailTransport();
      try {
        await transport.send(emailMsg);
      } catch (sendErr) {
        // Safe, identity-specific cleanup: remove the undelivered challenge so it does not
        // linger or block user recovery. Prior challenges are preserved so the user is not stranded.
        try {
          await cleanupFailedVerificationChallenge(challengeRes.challenge.tokenHash);
        } catch {
          // Prevent cleanup DB errors from masking original delivery failure
        }
        throw sendErr;
      }

      // Finalize delivery: invalidate any older unconsumed challenges for this user
      await finalizeVerificationChallengeDelivery(challengeRes.user.id, challengeRes.challenge.tokenHash);

      await emitAuditEvent(null as any, {
        workspaceId: null,
        actorId: challengeRes.user.id,
        action: 'auth.email.verification_requested',
        resourceType: 'user',
        resourceId: challengeRes.user.id,
        metadata: { email: challengeRes.user.email },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.json({ ok: true, message: 'If an account exists, a verification email has been sent.' });
    } catch (err) {
      next(err);
    }
  },
);

const verifyEmailSchema = z.object({
  token: z.string().min(1),
});

authRouter.post(
  '/api/v1/auth/verify-email',
  rateLimiter({
    keyPrefix: 'verify-email-consume',
    windowSeconds: env.RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: 10,
    failClosed: true,
  }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = verifyEmailSchema.parse(req.body);

      const result = await verifyEmailToken(token);

      await emitAuditEvent(null as any, {
        workspaceId: null,
        actorId: result.userId,
        action: 'auth.email.verified',
        resourceType: 'user',
        resourceId: result.userId,
        metadata: { email: result.email },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.json({
        ok: true,
        message: 'Email verified successfully',
        emailVerified: true,
      });
    } catch (err) {
      if (
        err instanceof InvalidVerificationTokenError ||
        err instanceof ExpiredVerificationTokenError ||
        err instanceof TokenAlreadyConsumedError
      ) {
        res.status(err.status).json({
          error: err.message,
          code: err.code,
        });
        return;
      }
      next(err);
    }
  },
);
