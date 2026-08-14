import { Request, Response, NextFunction } from 'express';
import { withUserContext, getDb } from '@knowledge/database';

export async function rlsMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    next();
    return;
  }

  // Inject app.current_user_id for downstream transactional execution
  try {
    await withUserContext(req.user.userId, async () => {
      next();
    });
  } catch (err) {
    next(err);
  }
}
