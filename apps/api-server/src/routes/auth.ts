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
  TokenReuseError,
} from '@knowledge/auth';
import { rateLimiter } from '../middleware/rate-limiter';
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
  async (req: Request, res: Response, next: NextFunction) => {
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
