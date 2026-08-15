import { Request, Response, NextFunction } from 'express';
import { WorkspaceRole } from '@knowledge/types';

export function requireRole(...allowedRoles: WorkspaceRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.workspaceRole || !allowedRoles.includes(req.workspaceRole)) {
      res.status(403).json({ error: 'Insufficient role permissions for action' });
      return;
    }
    next();
  };
}
