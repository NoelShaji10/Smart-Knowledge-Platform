import { Request, Response, NextFunction } from 'express';
import { createScopedDb, ScopedDb } from '@knowledge/database';

declare global {
  namespace Express {
    interface Request {
      db?: ScopedDb;
    }
  }
}

export function rlsMiddleware(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    next();
    return;
  }

  req.db = createScopedDb(req.user.userId);
  next();
}
