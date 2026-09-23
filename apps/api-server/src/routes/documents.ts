import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { DocumentRole } from '@knowledge/types';
import { authMiddleware } from '../middleware/auth';
import { rlsMiddleware } from '../middleware/rls';
import { requireWorkspace } from '../middleware/require-workspace';
import { requireDocumentAccess } from '../middleware/require-document-access';
import { emitAuditEvent } from '../lib/audit';
import {
  createDocument,
  getDocumentById,
  listWorkspaceDocuments,
  updateDocument,
  moveDocument,
  archiveDocument,
  restoreDocument,
} from '../lib/document-service';
import {
  setDocumentPermission,
  removeDocumentPermission,
  getDocumentPermissions,
} from '../lib/document-permission-service';
import {
  createVersionCheckpoint,
  listDocumentVersions,
  getDocumentVersion,
  restoreVersion,
} from '../lib/document-version-service';

export const documentRouter: Router = Router();

// Apply auth + rls middleware to all document endpoints
documentRouter.use('/api/v1/workspaces/:workspaceId/documents', authMiddleware, rlsMiddleware);

const createDocumentSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  parentId: z.string().uuid().nullable().optional(),
  contentText: z.string().optional(),
});

const updateDocumentSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  contentText: z.string().optional(),
});

const moveDocumentSchema = z.object({
  parentId: z.string().uuid().nullable(),
});

const setPermissionSchema = z.object({
  role: z.enum(['editor', 'viewer', 'none']),
});

const uuidParamSchema = z.string().uuid();
const versionNumberSchema = z.coerce.number().int().positive();

// 1. List documents in a workspace
documentRouter.get(
  '/api/v1/workspaces/:workspaceId/documents',
  requireWorkspace('viewer'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;

      let parentId: string | null | undefined = undefined;
      if (req.query.parentId === 'null') {
        parentId = null;
      } else if (typeof req.query.parentId === 'string' && req.query.parentId.trim() !== '') {
        parentId = uuidParamSchema.parse(req.query.parentId);
      }

      const includeArchived = req.query.includeArchived === 'true';

      const documents = await listWorkspaceDocuments(req.db!, workspaceId, {
        parentId,
        includeArchived,
      });

      res.json({ documents });
    } catch (err) {
      next(err);
    }
  },
);

// 2. Create a document
documentRouter.post(
  '/api/v1/workspaces/:workspaceId/documents',
  requireWorkspace('editor'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      const { title, parentId, contentText } = createDocumentSchema.parse(req.body);

      const document = await createDocument(req.db!, {
        workspaceId,
        title: title || 'Untitled',
        parentId,
        contentText,
        createdBy: req.user!.userId,
      });

      await req.db!.execute(async (trx) => {
        await emitAuditEvent(trx, {
          workspaceId,
          actorId: req.user!.userId,
          action: 'document.created',
          resourceType: 'document',
          resourceId: document.id,
          metadata: { title: document.title, parentId: document.parent_id },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
      });

      res.status(201).json({ document });
    } catch (err) {
      next(err);
    }
  },
);

// 3. Get single document
documentRouter.get(
  '/api/v1/workspaces/:workspaceId/documents/:documentId',
  requireWorkspace('viewer'),
  requireDocumentAccess('read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      const documentId = req.params.documentId;

      const document = await getDocumentById(req.db!, workspaceId, documentId);

      if (!document) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      res.json({
        document,
        effectiveRole: req.documentRole,
        capabilities: req.documentCapabilities,
      });
    } catch (err) {
      next(err);
    }
  },
);

// 4. Update title/content
documentRouter.patch(
  '/api/v1/workspaces/:workspaceId/documents/:documentId',
  requireWorkspace('viewer'),
  requireDocumentAccess('edit'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      const documentId = req.params.documentId;
      const updates = updateDocumentSchema.parse(req.body);

      const document = await updateDocument(req.db!, workspaceId, documentId, updates);

      await req.db!.execute(async (trx) => {
        await emitAuditEvent(trx, {
          workspaceId,
          actorId: req.user!.userId,
          action: 'document.updated',
          resourceType: 'document',
          resourceId: document.id,
          metadata: {
            titleUpdated: updates.title !== undefined,
            contentUpdated: updates.contentText !== undefined,
          },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
      });

      res.json({ document });
    } catch (err) {
      next(err);
    }
  },
);

// 5. Move document parent
documentRouter.post(
  '/api/v1/workspaces/:workspaceId/documents/:documentId/move',
  requireWorkspace('viewer'),
  requireDocumentAccess('move'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      const documentId = req.params.documentId;
      const { parentId } = moveDocumentSchema.parse(req.body);

      const document = await moveDocument(req.db!, workspaceId, documentId, parentId);

      await req.db!.execute(async (trx) => {
        await emitAuditEvent(trx, {
          workspaceId,
          actorId: req.user!.userId,
          action: 'document.moved',
          resourceType: 'document',
          resourceId: document.id,
          metadata: { newParentId: parentId },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
      });

      res.json({ document });
    } catch (err) {
      next(err);
    }
  },
);

// 6. Archive document
documentRouter.post(
  '/api/v1/workspaces/:workspaceId/documents/:documentId/archive',
  requireWorkspace('viewer'),
  requireDocumentAccess('archive'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      const documentId = req.params.documentId;

      const document = await archiveDocument(req.db!, workspaceId, documentId);

      await req.db!.execute(async (trx) => {
        await emitAuditEvent(trx, {
          workspaceId,
          actorId: req.user!.userId,
          action: 'document.archived',
          resourceType: 'document',
          resourceId: document.id,
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
      });

      res.json({ document });
    } catch (err) {
      next(err);
    }
  },
);

// 7. Restore document
documentRouter.post(
  '/api/v1/workspaces/:workspaceId/documents/:documentId/restore',
  requireWorkspace('viewer'),
  requireDocumentAccess('archive'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      const documentId = req.params.documentId;

      const document = await restoreDocument(req.db!, workspaceId, documentId);

      await req.db!.execute(async (trx) => {
        await emitAuditEvent(trx, {
          workspaceId,
          actorId: req.user!.userId,
          action: 'document.restored',
          resourceType: 'document',
          resourceId: document.id,
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
      });

      res.json({ document });
    } catch (err) {
      next(err);
    }
  },
);

// 8. Get document permission overrides
documentRouter.get(
  '/api/v1/workspaces/:workspaceId/documents/:documentId/permissions',
  requireWorkspace('viewer'),
  requireDocumentAccess('read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      const documentId = req.params.documentId;

      const permissions = await getDocumentPermissions(
        req.db!,
        workspaceId,
        documentId,
        req.user!.userId,
      );

      res.json({ permissions });
    } catch (err) {
      next(err);
    }
  },
);

// 9. Set document permission override
documentRouter.put(
  '/api/v1/workspaces/:workspaceId/documents/:documentId/permissions/:targetUserId',
  requireWorkspace('viewer'),
  requireDocumentAccess('manage_permissions'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      const documentId = req.params.documentId;
      const targetUserId = uuidParamSchema.parse(req.params.targetUserId);
      const { role } = setPermissionSchema.parse(req.body);

      const permission = await setDocumentPermission(
        req.db!,
        workspaceId,
        documentId,
        targetUserId,
        role as DocumentRole,
        req.user!.userId,
      );

      await req.db!.execute(async (trx) => {
        await emitAuditEvent(trx, {
          workspaceId,
          actorId: req.user!.userId,
          action: 'permission.granted',
          resourceType: 'document',
          resourceId: documentId,
          metadata: { targetUserId, role },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
      });

      res.json({ permission });
    } catch (err) {
      next(err);
    }
  },
);

// 10. Remove document permission override
documentRouter.delete(
  '/api/v1/workspaces/:workspaceId/documents/:documentId/permissions/:targetUserId',
  requireWorkspace('viewer'),
  requireDocumentAccess('manage_permissions'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      const documentId = req.params.documentId;
      const targetUserId = uuidParamSchema.parse(req.params.targetUserId);

      await removeDocumentPermission(
        req.db!,
        workspaceId,
        documentId,
        targetUserId,
        req.user!.userId,
      );

      await req.db!.execute(async (trx) => {
        await emitAuditEvent(trx, {
          workspaceId,
          actorId: req.user!.userId,
          action: 'permission.revoked',
          resourceType: 'document',
          resourceId: documentId,
          metadata: { targetUserId },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
      });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// 11. Create manual version checkpoint
documentRouter.post(
  '/api/v1/workspaces/:workspaceId/documents/:documentId/versions',
  requireWorkspace('viewer'),
  requireDocumentAccess('edit'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      const documentId = req.params.documentId;

      const version = await createVersionCheckpoint(
        req.db!,
        workspaceId,
        documentId,
        req.user!.userId,
        'manual',
      );

      await req.db!.execute(async (trx) => {
        await emitAuditEvent(trx, {
          workspaceId,
          actorId: req.user!.userId,
          action: 'document.version.created',
          resourceType: 'document',
          resourceId: documentId,
          metadata: { versionNumber: version.version_number, trigger: 'manual' },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
      });

      res.status(201).json({ version });
    } catch (err) {
      next(err);
    }
  },
);

// 12. List document versions
documentRouter.get(
  '/api/v1/workspaces/:workspaceId/documents/:documentId/versions',
  requireWorkspace('viewer'),
  requireDocumentAccess('read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      const documentId = req.params.documentId;

      const versions = await listDocumentVersions(req.db!, workspaceId, documentId);

      res.json({ versions });
    } catch (err) {
      next(err);
    }
  },
);

// 13. Get specific document version
documentRouter.get(
  '/api/v1/workspaces/:workspaceId/documents/:documentId/versions/:versionNumber',
  requireWorkspace('viewer'),
  requireDocumentAccess('read'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      const documentId = req.params.documentId;
      const versionNumber = versionNumberSchema.parse(req.params.versionNumber);

      const version = await getDocumentVersion(req.db!, workspaceId, documentId, versionNumber);

      if (!version) {
        res.status(404).json({ error: 'Version not found' });
        return;
      }

      res.json({ version });
    } catch (err) {
      next(err);
    }
  },
);

// 14. Restore historical document version
documentRouter.post(
  '/api/v1/workspaces/:workspaceId/documents/:documentId/versions/:versionNumber/restore',
  requireWorkspace('viewer'),
  requireDocumentAccess('edit'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspaceId = req.params.workspaceId;
      const documentId = req.params.documentId;
      const versionNumber = versionNumberSchema.parse(req.params.versionNumber);

      const result = await restoreVersion(
        req.db!,
        workspaceId,
        documentId,
        versionNumber,
        req.user!.userId,
      );

      await req.db!.execute(async (trx) => {
        await emitAuditEvent(trx, {
          workspaceId,
          actorId: req.user!.userId,
          action: 'document.version.restored',
          resourceType: 'document',
          resourceId: documentId,
          metadata: {
            restoredVersionNumber: versionNumber,
            newVersionNumber: result.newVersion.version_number,
          },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });
      });

      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);
