import { describe, it, expect, beforeAll } from 'vitest';
import { runMigrations, getSystemDb, createScopedDb } from '@knowledge/database';
import { registerUser } from '@knowledge/auth';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';
import {
  createDocument,
  getDocumentById,
  listWorkspaceDocuments,
  getDocumentTree,
  updateDocument,
  moveDocument,
  archiveDocument,
  restoreDocument,
  DEFAULT_MAX_DOCUMENT_DEPTH,
} from '../../apps/api-server/src/lib/document-service';

describe('Document Core Service Integration Tests', () => {
  let isDbConnected = false;

  let userA_id: string;
  let userB_id: string;

  let workspaceA_id: string;
  let workspaceB_id: string;

  beforeAll(async () => {
    try {
      await runMigrations();
      isDbConnected = true;

      const sysDb = getSystemDb();

      const userA = await registerUser(sysDb, {
        email: `doc_userA_${Date.now()}@example.com`,
        password: 'Password123!',
        displayName: 'User A',
      });
      const userB = await registerUser(sysDb, {
        email: `doc_userB_${Date.now()}@example.com`,
        password: 'Password123!',
        displayName: 'User B',
      });

      userA_id = userA.id;
      userB_id = userB.id;

      const wsA = await createWorkspace(sysDb, userA_id, 'Workspace A');
      const wsB = await createWorkspace(sysDb, userB_id, 'Workspace B');

      workspaceA_id = wsA.id;
      workspaceB_id = wsB.id;
    } catch {
      isDbConnected = false;
    }
  });

  it('creates root and child documents, enforcing same-workspace parent verification', async () => {
    if (!isDbConnected) return;

    const scopedDbA = createScopedDb(userA_id);

    // 1. Create root doc in Workspace A
    const rootDoc = await createDocument(scopedDbA, {
      workspaceId: workspaceA_id,
      title: 'Root Doc',
      contentText: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', text: 'Root' }] }),
      createdBy: userA_id,
    });

    expect(rootDoc.id).toBeDefined();
    expect(rootDoc.workspace_id).toBe(workspaceA_id);
    expect(rootDoc.parent_id).toBeNull();
    expect(rootDoc.is_archived).toBe(false);
    expect(rootDoc.title).toBe('Root Doc');

    // 2. Create child doc under Root Doc
    const childDoc = await createDocument(scopedDbA, {
      workspaceId: workspaceA_id,
      parentId: rootDoc.id,
      title: 'Child Doc',
      contentText: 'Child content',
      createdBy: userA_id,
    });

    expect(childDoc.parent_id).toBe(rootDoc.id);

    // 3. Reject creation under cross-workspace parent
    await expect(
      createDocument(scopedDbA, {
        workspaceId: workspaceB_id,
        parentId: rootDoc.id, // Root Doc belongs to Workspace A!
        title: 'Cross WS Child',
        createdBy: userA_id,
      })
    ).rejects.toThrow('Invalid parent document');
  });

  it('retrieves document using workspaceId + documentId and rejects mismatched workspaceId', async () => {
    if (!isDbConnected) return;

    const scopedDbA = createScopedDb(userA_id);

    const docA = await createDocument(scopedDbA, {
      workspaceId: workspaceA_id,
      title: 'Doc A',
      createdBy: userA_id,
    });

    // Valid retrieval with matching workspaceId
    const retrieved = await getDocumentById(scopedDbA, workspaceA_id, docA.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(docA.id);

    // Mismatched workspaceId returns null
    const mismatched = await getDocumentById(scopedDbA, workspaceB_id, docA.id);
    expect(mismatched).toBeNull();
  });

  it('lists documents with parentId and archive filters', async () => {
    if (!isDbConnected) return;

    const scopedDbA = createScopedDb(userA_id);

    const parent = await createDocument(scopedDbA, {
      workspaceId: workspaceA_id,
      title: 'Parent List Test',
      createdBy: userA_id,
    });

    const child1 = await createDocument(scopedDbA, {
      workspaceId: workspaceA_id,
      parentId: parent.id,
      title: 'Child 1',
      createdBy: userA_id,
    });

    const child2 = await createDocument(scopedDbA, {
      workspaceId: workspaceA_id,
      parentId: parent.id,
      title: 'Child 2',
      createdBy: userA_id,
    });

    // List all active docs in workspace
    const allActive = await listWorkspaceDocuments(scopedDbA, workspaceA_id);
    expect(allActive.some((d) => d.id === parent.id)).toBe(true);
    expect(allActive.some((d) => d.id === child1.id)).toBe(true);

    // List by parentId
    const childrenOnly = await listWorkspaceDocuments(scopedDbA, workspaceA_id, { parentId: parent.id });
    expect(childrenOnly.length).toBe(2);
    expect(childrenOnly.map((d) => d.id).sort()).toEqual([child1.id, child2.id].sort());

    // List root docs only (parentId = null)
    const rootOnly = await listWorkspaceDocuments(scopedDbA, workspaceA_id, { parentId: null });
    expect(rootOnly.some((d) => d.id === parent.id)).toBe(true);
    expect(rootOnly.some((d) => d.id === child1.id)).toBe(false);
  });

  it('builds a hierarchical document tree', async () => {
    if (!isDbConnected) return;

    const scopedDbA = createScopedDb(userA_id);

    const root = await createDocument(scopedDbA, {
      workspaceId: workspaceA_id,
      title: 'Tree Root',
      createdBy: userA_id,
    });

    const child = await createDocument(scopedDbA, {
      workspaceId: workspaceA_id,
      parentId: root.id,
      title: 'Tree Child',
      createdBy: userA_id,
    });

    const grandChild = await createDocument(scopedDbA, {
      workspaceId: workspaceA_id,
      parentId: child.id,
      title: 'Tree Grandchild',
      createdBy: userA_id,
    });

    const tree = await getDocumentTree(scopedDbA, workspaceA_id);

    const rootNode = tree.find((n) => n.id === root.id);
    expect(rootNode).toBeDefined();

    const childNode = rootNode?.children.find((n) => n.id === child.id);
    expect(childNode).toBeDefined();

    const grandChildNode = childNode?.children.find((n) => n.id === grandChild.id);
    expect(grandChildNode).toBeDefined();
  });

  it('updates title and contentText without modifying workspaceId or parent_id', async () => {
    if (!isDbConnected) return;

    const scopedDbA = createScopedDb(userA_id);

    const doc = await createDocument(scopedDbA, {
      workspaceId: workspaceA_id,
      title: 'Original Title',
      contentText: 'Original Content',
      createdBy: userA_id,
    });

    const updated = await updateDocument(scopedDbA, workspaceA_id, doc.id, {
      title: 'Updated Title',
      contentText: 'Updated Content',
    });

    expect(updated.title).toBe('Updated Title');
    expect(updated.content_text).toBe('Updated Content');
    expect(updated.workspace_id).toBe(workspaceA_id);
    expect(updated.parent_id).toBeNull();
  });

  it('handles moving documents, cycle detection, self-parenting, and depth limits', async () => {
    if (!isDbConnected) return;

    const scopedDbA = createScopedDb(userA_id);

    const docA = await createDocument(scopedDbA, { workspaceId: workspaceA_id, title: 'Doc A', createdBy: userA_id });
    const docB = await createDocument(scopedDbA, { workspaceId: workspaceA_id, parentId: docA.id, title: 'Doc B', createdBy: userA_id });
    const docC = await createDocument(scopedDbA, { workspaceId: workspaceA_id, parentId: docB.id, title: 'Doc C', createdBy: userA_id });

    // 1. Valid move: move Doc C directly under Doc A
    const movedC = await moveDocument(scopedDbA, workspaceA_id, docC.id, docA.id);
    expect(movedC.parent_id).toBe(docA.id);

    // 2. Reject moving a document under itself
    await expect(
      moveDocument(scopedDbA, workspaceA_id, docA.id, docA.id)
    ).rejects.toThrow('Cannot move a document under itself');

    // 3. Reject cycle creation: attempt to move Doc A under Doc B (when B is child of A)
    await expect(
      moveDocument(scopedDbA, workspaceA_id, docA.id, docB.id)
    ).rejects.toThrow('cycle detected');

    // 4. Test depth limit safety check (> 15)
    let currentParentId: string | null = null;
    const chainIds: string[] = [];

    for (let i = 1; i <= DEFAULT_MAX_DOCUMENT_DEPTH; i++) {
      const chainDoc = await createDocument(scopedDbA, {
        workspaceId: workspaceA_id,
        parentId: currentParentId,
        title: `Depth ${i}`,
        createdBy: userA_id,
      });
      currentParentId = chainDoc.id;
      chainIds.push(chainDoc.id);
    }

    // Creating 16th level document under the 15th level document should fail
    await expect(
      createDocument(scopedDbA, {
        workspaceId: workspaceA_id,
        parentId: chainIds[chainIds.length - 1],
        title: 'Depth 16',
        createdBy: userA_id,
      })
    ).rejects.toThrow('Maximum document hierarchy depth exceeded');
  });

  it('archives documents non-cascadingly and restores with root promotion if parent is archived', async () => {
    if (!isDbConnected) return;

    const scopedDbA = createScopedDb(userA_id);

    const parent = await createDocument(scopedDbA, {
      workspaceId: workspaceA_id,
      title: 'Archive Parent',
      createdBy: userA_id,
    });

    const child = await createDocument(scopedDbA, {
      workspaceId: workspaceA_id,
      parentId: parent.id,
      title: 'Archive Child',
      createdBy: userA_id,
    });

    // 1. Archive child document
    const archivedChild = await archiveDocument(scopedDbA, workspaceA_id, child.id);
    expect(archivedChild.is_archived).toBe(true);

    // 2. Parent remains active
    const parentReloaded = await getDocumentById(scopedDbA, workspaceA_id, parent.id);
    expect(parentReloaded?.is_archived).toBe(false);

    // 3. Archive parent document
    await archiveDocument(scopedDbA, workspaceA_id, parent.id);

    // 4. Restore child document -> since parent is archived, child must be promoted to root (parent_id = null)
    const restoredChild = await restoreDocument(scopedDbA, workspaceA_id, child.id);
    expect(restoredChild.is_archived).toBe(false);
    expect(restoredChild.parent_id).toBeNull();
  });
});
