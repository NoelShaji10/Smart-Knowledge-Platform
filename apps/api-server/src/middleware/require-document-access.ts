import { Request, Response, NextFunction } from 'express';
import { WorkspaceRole, DocumentRole } from '@knowledge/types';
import {
  getEffectiveDocumentRole,
  DocumentCapabilities,
} from '../lib/document-permission-service';

export type DocumentCapability = 'read' | 'edit' | 'move' | 'archive' | 'manage_permissions';

declare global {
  namespace Express {
    interface Request {
      documentRole?: WorkspaceRole | DocumentRole;
      documentCapabilities?: DocumentCapabilities;
      documentId?: string;
    }
  }
}

export function requireDocumentAccess(capability: DocumentCapability) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !req.db) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const workspaceId =
      req.params.workspaceId ||
      (req.body && req.body.workspaceId) ||
      (req.query && (req.query.workspaceId as string));

    const documentId =
      req.params.documentId ||
      (req.body && req.body.documentId) ||
      (req.query && (req.query.documentId as string));

    if (!workspaceId || !documentId) {
      res.status(400).json({ error: 'Workspace ID and Document ID are required' });
      return;
    }

    try {
      const result = await getEffectiveDocumentRole(req.db, workspaceId, documentId, req.user.userId);

      if (!result) {
        // Document not found in this workspace or user is not a workspace member
        res.status(404).json({ error: 'Document not found' });
        return;
      }

      if (result.isDenied) {
        res.status(403).json({ error: 'Access denied to document' });
        return;
      }

      let hasCapability = false;
      switch (capability) {
        case 'read':
          hasCapability = result.capabilities.canRead;
          break;
        case 'edit':
          hasCapability = result.capabilities.canEdit;
          break;
        case 'move':
          hasCapability = result.capabilities.canMove;
          break;
        case 'archive':
          hasCapability = result.capabilities.canArchive;
          break;
        case 'manage_permissions':
          hasCapability = result.capabilities.canManagePermissions;
          break;
      }

      if (!hasCapability) {
        res.status(403).json({ error: 'Insufficient permissions for this document operation' });
        return;
      }

      req.documentRole = result.effectiveRole;
      req.documentCapabilities = result.capabilities;
      req.documentId = documentId;
      next();
    } catch (err) {
      next(err);
    }
  };
}
