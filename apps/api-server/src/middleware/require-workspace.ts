import { Request, Response, NextFunction } from 'express';
import { WorkspaceRole } from '@knowledge/types';

const ROLE_RANK: Record<WorkspaceRole, number> = {
  owner: 4,
  admin: 3,
  editor: 2,
  viewer: 1,
};

export function isRoleAtLeast(userRole: WorkspaceRole, requiredRole: WorkspaceRole): boolean {
  return (ROLE_RANK[userRole] || 0) >= (ROLE_RANK[requiredRole] || 0);
}

declare global {
  namespace Express {
    interface Request {
      workspaceRole?: WorkspaceRole;
      workspaceId?: string;
    }
  }
}

export function requireWorkspace(minRole?: WorkspaceRole) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !req.db) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const workspaceId =
      req.params.workspaceId ||
      (req.body && req.body.workspaceId) ||
      (req.query && (req.query.workspaceId as string));

    if (!workspaceId) {
      res.status(400).json({ error: 'Workspace ID is required' });
      return;
    }

    try {
      // ALWAYS query PostgreSQL DB via req.db (ScopedDb) — JWT claims are never authoritative
      const membership = await req.db.execute(async (db) => {
        return db
          .selectFrom('workspace_members')
          .where('workspace_id', '=', workspaceId)
          .where('user_id', '=', req.user!.userId)
          .select(['role'])
          .executeTakeFirst();
      });

      if (!membership) {
        res.status(403).json({ error: 'Access denied to workspace' });
        return;
      }

      const role = membership.role as WorkspaceRole;

      if (minRole && !isRoleAtLeast(role, minRole)) {
        res.status(403).json({ error: 'Insufficient workspace permissions' });
        return;
      }

      req.workspaceRole = role;
      req.workspaceId = workspaceId;
      next();
    } catch (err) {
      next(err);
    }
  };
}
