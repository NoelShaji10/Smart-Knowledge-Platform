import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '@knowledge/auth';

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
    const payload = verifyAccessToken(token);
    req.user = {
      userId: payload.sub as string,
      email: payload.email as string,
      workspaces: (payload.workspaces as Array<{ id: string; role: string }>) || [],
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
