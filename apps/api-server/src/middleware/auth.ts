import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getEnv } from '@knowledge/config';

export interface AuthenticatedUser {
  userId: string;
  email: string;
  workspaces: Array<{ id: string; role: string }>;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  try {
    const env = getEnv();
    const payload = jwt.verify(token, env.JWT_SECRET) as any;
    req.user = {
      userId: payload.sub,
      email: payload.email,
      workspaces: payload.workspaces || [],
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
