import crypto from 'crypto';
import { Kysely, Transaction, sql } from 'kysely';
import { Database, ScopedDb } from '@knowledge/database';

export const DEFAULT_MAX_DOCUMENT_DEPTH = 15;

export interface CreateDocumentInput {
  workspaceId: string;
  title: string;
  parentId?: string | null;
  contentText?: string;
  createdBy: string;
}

export interface ListDocumentsOptions {
  parentId?: string | null;
  includeArchived?: boolean;
}

export interface UpdateDocumentInput {
  title?: string;
  contentText?: string;
}

export interface DocumentTreeNode {
  id: string;
  workspaceId: string;
  title: string;
  parentId: string | null;
  isArchived: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  children: DocumentTreeNode[];
}

/**
  * Calculate depth of ancestry from root to parentId (inclusive).
  * Root document (parentId = null) has depth 0.
  */
async function getAncestryDepth(
  db: Kysely<Database> | Transaction<Database>,
  workspaceId: string,
  parentId: string | null,
): Promise<number> {
  if (!parentId) return 0;

  let depth = 0;
  let currentId: string | null = parentId;
  const visited = new Set<string>();

  while (currentId) {
    if (visited.has(currentId)) {
      throw new Error('Cycle detected in document hierarchy');
    }
    visited.add(currentId);
    depth++;

    const parentDoc = await db
      .selectFrom('documents')
      .where('id', '=', currentId)
      .where('workspace_id', '=', workspaceId)
      .select(['parent_id'])
      .executeTakeFirst();

    if (!parentDoc) break;
    currentId = parentDoc.parent_id;
  }

  return depth;
}

/**
  * Calculate maximum subtree depth starting from documentId (inclusive).
  * A leaf document with no children has subtree depth 1.
  */
async function getSubtreeDepth(
  db: Kysely<Database> | Transaction<Database>,
  workspaceId: string,
  documentId: string,
): Promise<number> {
  const children = await db
    .selectFrom('documents')
    .where('parent_id', '=', documentId)
    .where('workspace_id', '=', workspaceId)
    .select(['id'])
    .execute();

  if (children.length === 0) return 1;

  let maxChildDepth = 0;
  for (const child of children) {
    const childDepth = await getSubtreeDepth(db, workspaceId, child.id);
    if (childDepth > maxChildDepth) {
      maxChildDepth = childDepth;
    }
  }

  return 1 + maxChildDepth;
}

/**
  * Create a new document in a workspace.
  */
export async function createDocument(scopedDb: ScopedDb, input: CreateDocumentInput) {
  return scopedDb.execute(async (db) => {
    const { workspaceId, title, parentId, contentText, createdBy } = input;
    // Serialize hierarchy changes within one workspace for the transaction.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`document-hierarchy:${workspaceId}`}))`.execute(db);

    const cleanParentId = parentId || null;

    if (cleanParentId) {
      const parentDoc = await db
        .selectFrom('documents')
        .where('id', '=', cleanParentId)
        .where('workspace_id', '=', workspaceId)
        .select(['id', 'is_archived'])
        .executeTakeFirst();

      if (!parentDoc) {
        throw new Error('Invalid parent document: Parent does not exist or belongs to another workspace');
      }

      if (parentDoc.is_archived) {
        throw new Error('Cannot create document under an archived parent');
      }

      const parentAncestryDepth = await getAncestryDepth(db, workspaceId, cleanParentId);
      if (parentAncestryDepth + 1 > DEFAULT_MAX_DOCUMENT_DEPTH) {
        throw new Error('Maximum document hierarchy depth exceeded');
      }
    }

    const docId = crypto.randomUUID();

    return db
      .insertInto('documents')
      .values({
        id: docId,
        workspace_id: workspaceId,
        parent_id: cleanParentId,
        is_archived: false,
        title: title.trim() || 'Untitled',
        content_text: contentText ?? '',
        created_by: createdBy,
      })
      .returning([
        'id',
        'workspace_id',
        'parent_id',
        'is_archived',
        'title',
        'content_text',
        'snapshot_key',
        'snapshot_version',
        'created_by',
        'created_at',
        'updated_at',
      ])
      .executeTakeFirstOrThrow();
  });
}

/**
  * Fetch a document by workspaceId AND documentId.
  * Always validates workspace_id match to prevent cross-workspace parameter pollution.
  */
export async function getDocumentById(scopedDb: ScopedDb, workspaceId: string, documentId: string) {
  return scopedDb.execute(async (db) => {
    const doc = await db
      .selectFrom('documents')
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .selectAll()
      .executeTakeFirst();

    return doc || null;
  });
}

/**
  * List documents in a workspace with optional parentId and archive filtering.
  */
export async function listWorkspaceDocuments(
  scopedDb: ScopedDb,
  workspaceId: string,
  options: ListDocumentsOptions = {},
) {
  return scopedDb.execute(async (db) => {
    let query = db
      .selectFrom('documents')
      .where('workspace_id', '=', workspaceId);

    if (!options.includeArchived) {
      query = query.where('is_archived', '=', false);
    }

    if (options.parentId !== undefined) {
      if (options.parentId === null) {
        query = query.where('parent_id', 'is', null);
      } else {
        query = query.where('parent_id', '=', options.parentId);
      }
    }

    return query
      .selectAll()
      .orderBy('title', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
  });
}

/**
  * Build hierarchical document tree for active documents in a workspace.
  */
export async function getDocumentTree(scopedDb: ScopedDb, workspaceId: string): Promise<DocumentTreeNode[]> {
  return scopedDb.execute(async (db) => {
    const docs = await db
      .selectFrom('documents')
      .where('workspace_id', '=', workspaceId)
      .where('is_archived', '=', false)
      .selectAll()
      .orderBy('title', 'asc')
      .execute();

    const nodeMap = new Map<string, DocumentTreeNode>();
    const rootNodes: DocumentTreeNode[] = [];

    for (const doc of docs) {
      nodeMap.set(doc.id, {
        id: doc.id,
        workspaceId: doc.workspace_id,
        title: doc.title,
        parentId: doc.parent_id,
        isArchived: doc.is_archived,
        createdBy: doc.created_by,
        createdAt: doc.created_at,
        updatedAt: doc.updated_at,
        children: [],
      });
    }

    for (const doc of docs) {
      const node = nodeMap.get(doc.id)!;
      if (doc.parent_id && nodeMap.has(doc.parent_id)) {
        nodeMap.get(doc.parent_id)!.children.push(node);
      } else {
        rootNodes.push(node);
      }
    }

    return rootNodes;
  });
}

/**
  * Update document title and contentText.
  * Does NOT modify workspace_id or parent_id.
  */
export async function updateDocument(
  scopedDb: ScopedDb,
  workspaceId: string,
  documentId: string,
  updates: UpdateDocumentInput,
) {
  return scopedDb.execute(async (db) => {
    const existing = await db
      .selectFrom('documents')
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .select(['id'])
      .executeTakeFirst();

    if (!existing) {
      throw new Error('Document not found');
    }

    const setValues: Record<string, unknown> = {
      updated_at: new Date(),
    };

    if (updates.title !== undefined) {
      setValues.title = updates.title.trim() || 'Untitled';
    }

    if (updates.contentText !== undefined) {
      setValues.content_text = updates.contentText;
    }

    return db
      .updateTable('documents')
      .set(setValues)
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

/**
  * Move a document to a new parent in the same workspace.
  * Performs self-parenting check, cycle detection, and hierarchy depth safety check.
  */
export async function moveDocument(
  scopedDb: ScopedDb,
  workspaceId: string,
  documentId: string,
  newParentId: string | null,
) {
  return scopedDb.execute(async (db) => {
    // Prevent reciprocal concurrent moves from passing independent cycle checks.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`document-hierarchy:${workspaceId}`}))`.execute(db);

    const doc = await db
      .selectFrom('documents')
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .select(['id', 'parent_id'])
      .executeTakeFirst();

    if (!doc) {
      throw new Error('Document not found');
    }

    const cleanNewParentId = newParentId || null;

    if (cleanNewParentId === documentId) {
      throw new Error('Cannot move a document under itself');
    }

    if (cleanNewParentId === doc.parent_id) {
      // No change needed
      return db
        .selectFrom('documents')
        .where('id', '=', documentId)
        .where('workspace_id', '=', workspaceId)
        .selectAll()
        .executeTakeFirstOrThrow();
    }

    if (cleanNewParentId) {
      const targetParent = await db
        .selectFrom('documents')
        .where('id', '=', cleanNewParentId)
        .where('workspace_id', '=', workspaceId)
        .select(['id', 'is_archived'])
        .executeTakeFirst();

      if (!targetParent) {
        throw new Error('Invalid parent document: Parent does not exist or belongs to another workspace');
      }

      if (targetParent.is_archived) {
        throw new Error('Cannot move document under an archived parent');
      }

      // Cycle detection: walk up ancestry chain of cleanNewParentId
      let currentId: string | null = cleanNewParentId;
      while (currentId) {
        if (currentId === documentId) {
          throw new Error('Cannot move a document under one of its descendants (cycle detected)');
        }

        const ancestor = await db
          .selectFrom('documents')
          .where('id', '=', currentId)
          .where('workspace_id', '=', workspaceId)
          .select(['parent_id'])
          .executeTakeFirst();

        if (!ancestor) break;
        currentId = ancestor.parent_id;
      }

      // Depth safety check
      const targetParentAncestryDepth = await getAncestryDepth(db, workspaceId, cleanNewParentId);
      const movingSubtreeDepth = await getSubtreeDepth(db, workspaceId, documentId);

      if (targetParentAncestryDepth + movingSubtreeDepth > DEFAULT_MAX_DOCUMENT_DEPTH) {
        throw new Error('Maximum document hierarchy depth exceeded');
      }
    }

    return db
      .updateTable('documents')
      .set({
        parent_id: cleanNewParentId,
        updated_at: new Date(),
      })
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

/**
  * Archive a document (is_archived = true).
  * Non-cascading: child documents preserve their parent_id and active status.
  */
export async function archiveDocument(scopedDb: ScopedDb, workspaceId: string, documentId: string) {
  return scopedDb.execute(async (db) => {
    const doc = await db
      .selectFrom('documents')
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .select(['id'])
      .executeTakeFirst();

    if (!doc) {
      throw new Error('Document not found');
    }

    return db
      .updateTable('documents')
      .set({
        is_archived: true,
        updated_at: new Date(),
      })
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

/**
  * Restore an archived document (is_archived = false).
  * If the document's parent is missing or archived, promotes restored document to root (parent_id = null).
  */
export async function restoreDocument(scopedDb: ScopedDb, workspaceId: string, documentId: string) {
  return scopedDb.execute(async (db) => {
    const doc = await db
      .selectFrom('documents')
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .select(['id', 'parent_id', 'is_archived'])
      .executeTakeFirst();

    if (!doc) {
      throw new Error('Document not found');
    }

    let targetParentId = doc.parent_id;

    if (targetParentId) {
      const parent = await db
        .selectFrom('documents')
        .where('id', '=', targetParentId)
        .where('workspace_id', '=', workspaceId)
        .select(['id', 'is_archived'])
        .executeTakeFirst();

      if (!parent || parent.is_archived) {
        // Parent is missing or archived -> promote to root
        targetParentId = null;
      }
    }

    return db
      .updateTable('documents')
      .set({
        is_archived: false,
        parent_id: targetParentId,
        updated_at: new Date(),
      })
      .where('id', '=', documentId)
      .where('workspace_id', '=', workspaceId)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}
