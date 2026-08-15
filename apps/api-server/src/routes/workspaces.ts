import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { WorkspaceRole } from '@knowledge/types';
import { authMiddleware } from '../middleware/auth';
import { rlsMiddleware } from '../middleware/rls';
import { requireWorkspace } from '../middleware/require-workspace';
import { emitAuditEvent } from '../lib/audit';
import {
  createWorkspace,
  getUserWorkspaces,
  getWorkspaceById,
  updateWorkspace,
  deleteWorkspace,
  getWorkspaceMembers,
  addWorkspaceMember,
  changeWorkspaceMemberRole,
  removeWorkspaceMember,
} from '../lib/workspace-service';

export const workspaceRouter: Router = Router();

// Apply auth + rls middleware to all workspace endpoints
workspaceRouter.use('/api/v1/workspaces', authMiddleware, rlsMiddleware);

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
});

const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  settings: z.record(z.unknown()).optional(),
});

const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'editor', 'viewer']),
});

const changeRoleSchema = z.object({
  role: z.enum(['admin', 'editor', 'viewer']),
});

// Create workspace (any authed user)
workspaceRouter.post('/api/v1/workspaces', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = createWorkspaceSchema.parse(req.body);
    const userId = req.user!.userId;

    const workspace = await createWorkspace(req.db!, userId, name);

    await req.db!.execute(async (trx) => {
      await emitAuditEvent(trx, {
        workspaceId: workspace.id,
        actorId: userId,
        action: 'workspace.created',
        resourceType: 'workspace',
        resourceId: workspace.id,
        metadata: { name: workspace.name, slug: workspace.slug },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
    });

    res.status(201).json({ workspace });
  } catch (err) {
    next(err);
  }
});

// List workspaces for user
workspaceRouter.get('/api/v1/workspaces', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const workspaces = await getUserWorkspaces(req.db!);
    res.json({ workspaces });
  } catch (err) {
    next(err);
  }
});

// Get workspace details
workspaceRouter.get(
  '/api/v1/workspaces/:workspaceId',
  requireWorkspace('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspace = await getWorkspaceById(req.db!, req.params.workspaceId);
      if (!workspace) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }
      res.json({ workspace, userRole: req.workspaceRole });
    } catch (err) {
      next(err);
    }
  },
);

// Update workspace (admin+)
workspaceRouter.patch(
  '/api/v1/workspaces/:workspaceId',
  requireWorkspace('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updates = updateWorkspaceSchema.parse(req.body);
      const workspace = await updateWorkspace(req.db!, req.params.workspaceId, updates);

      if (req.db) {
        await req.db.execute(async (trx) => {
          await emitAuditEvent(trx, {
            workspaceId: req.params.workspaceId,
            actorId: req.user!.userId,
            action: 'workspace.settings.updated',
            resourceType: 'workspace',
            resourceId: req.params.workspaceId,
            metadata: updates,
            ipAddress: req.ip,
            userAgent: req.get('user-agent'),
          });
        });
      }

      res.json({ workspace });
    } catch (err) {
      next(err);
    }
  },
);

// Delete workspace (owner only)
workspaceRouter.delete(
  '/api/v1/workspaces/:workspaceId',
  requireWorkspace('owner'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      await req.db!.execute(async (trx) => {
        await emitAuditEvent(trx, {
          workspaceId,
          actorId: req.user!.userId,
          action: 'workspace.deleted',
          resourceType: 'workspace',
          resourceId: workspaceId,
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
      });

      await deleteWorkspace(req.db!, workspaceId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// List workspace members (viewer+)
workspaceRouter.get(
  '/api/v1/workspaces/:workspaceId/members',
  requireWorkspace('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const members = await getWorkspaceMembers(req.db!, req.params.workspaceId);
      res.json({ members });
    } catch (err) {
      next(err);
    }
  },
);

// Add member to workspace (admin+)
workspaceRouter.post(
  '/api/v1/workspaces/:workspaceId/members',
  requireWorkspace('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, role } = addMemberSchema.parse(req.body);

      if (req.workspaceRole === 'admin' && role === 'admin') {
        res.status(403).json({ error: 'Only workspace owners can add admin members' });
        return;
      }

      const result = await addWorkspaceMember(req.db!, req.params.workspaceId, email, role as WorkspaceRole);

      await req.db!.execute(async (trx) => {
        await emitAuditEvent(trx, {
          workspaceId: req.params.workspaceId,
          actorId: req.user!.userId,
          action: 'workspace.member.added',
          resourceType: 'user',
          resourceId: result.user.id,
          metadata: { email: result.user.email, role },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
      });

      res.status(201).json({ member: result });
    } catch (err) {
      next(err);
    }
  },
);

// Change member role (admin+)
workspaceRouter.patch(
  '/api/v1/workspaces/:workspaceId/members/:userId',
  requireWorkspace('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { role } = changeRoleSchema.parse(req.body);
      const targetUserId = req.params.userId;

      const result = await changeWorkspaceMemberRole(
        req.db!,
        req.params.workspaceId,
        targetUserId,
        role as WorkspaceRole,
        req.workspaceRole!,
      );

      await req.db!.execute(async (trx) => {
        await emitAuditEvent(trx, {
          workspaceId: req.params.workspaceId,
          actorId: req.user!.userId,
          action: 'workspace.member.role_changed',
          resourceType: 'user',
          resourceId: targetUserId,
          metadata: { newRole: role },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
      });

      res.json({ member: result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

// Remove member (admin+)
workspaceRouter.delete(
  '/api/v1/workspaces/:workspaceId/members/:userId',
  requireWorkspace('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const targetUserId = req.params.userId;

      await removeWorkspaceMember(
        req.db!,
        req.params.workspaceId,
        targetUserId,
        req.user!.userId,
      );

      await req.db!.execute(async (trx) => {
        await emitAuditEvent(trx, {
          workspaceId: req.params.workspaceId,
          actorId: req.user!.userId,
          action: 'workspace.member.removed',
          resourceType: 'user',
          resourceId: targetUserId,
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
      });

      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);
