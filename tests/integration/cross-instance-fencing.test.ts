import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { runMigrations, getSystemDb, withSystemContext } from '@knowledge/database';
import { registerUser } from '@knowledge/auth';
import {
  ensureBucketsExist,
  getS3Client,
  BUCKET_SNAPSHOTS,
  PutObjectCommand,
  saveRecoverySnapshot,
  loadRecoverySnapshot,
  saveVersionSnapshot,
  loadVersionSnapshot,
} from '@knowledge/storage';
import {
  getRedisClient,
  acquireRedisLock,
  renewRedisLock,
  releaseRedisLock,
  withDistributedLock,
  LockLostError,
  StaleFencingTokenError,
  validateFencingToken,
} from '@knowledge/redis';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';
import {
  getOrCreateRoom,
  getRoom,
  removeRoomIfEmpty,
  restoreDocument,
  clearAllRooms,
  flushRoomPersistence,
  syncDocumentFencingToken,
  Y,
  ClientConnection,
} from '../../apps/collab-server/src/room-manager';
import {
  loadRoomSnapshot,
  createVersionCheckpointOnSessionEnd,
  persistRecoverySnapshot,
} from '../../apps/collab-server/src/snapshot-service';

describe('Real Cross-Instance Distributed Fencing Integration Tests', () => {
  const redis = getRedisClient();
  let userId: string;
  let workspaceId: string;

  async function createTestDoc(title: string) {
    return await withSystemContext(async (db) => {
      return await db
        .insertInto('documents')
        .values({
          workspace_id: workspaceId,
          title,
          content_text: '',
          created_by: userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  beforeAll(async () => {
    await runMigrations();
    await ensureBucketsExist();

    const sysDb = getSystemDb();
    const user = await registerUser(sysDb, {
      email: `fence_test_${Date.now()}@example.com`,
      password: 'Password123!',
      displayName: 'Fence Test User',
    });
    userId = user.id;

    const ws = await createWorkspace(sysDb, userId, 'Fence Test Workspace');
    workspaceId = ws.id;
  });

  beforeEach(() => {
    clearAllRooms();
  });

  afterAll(async () => {
    clearAllRooms();
  });

  it('1. normal long-running lease renewal with real Redis', async () => {
    const key = `long-renew-${Date.now()}`;
    const ttlMs = 300;
    const renewalIntervalMs = 80;

    // Run critical section for 700ms (more than 2x TTL)
    const result = await withDistributedLock(
      key,
      async (ctx) => {
        expect(ctx.isLockValid()).toBe(true);
        expect(ctx.fencingToken).toBeGreaterThanOrEqual(1);

        await new Promise((r) => setTimeout(r, 600));

        // Key must still exist in real Redis and match lockId
        const currentVal = await redis.get(`lock:${key}`);
        expect(currentVal).toBe(ctx.lockId);

        ctx.assertLockValid();
        await ctx.verifyOwnership();
        return 'success';
      },
      { ttlMs, renewalIntervalMs }
    );

    expect(result).toBe('success');
    const finalVal = await redis.get(`lock:${key}`);
    expect(finalVal).toBeNull();
    await redis.del(`fence:${key}`);
  });

  it('2. concurrent acquisition by two independent instances enforces mutual exclusion', async () => {
    const key = `concurrent-instances-${Date.now()}`;
    const activeInstances: number[] = [];
    let overlapDetected = false;

    // Simulate two separate processes acquiring lock via independent handles
    const runInstance = async (id: number) => {
      const handle = await acquireRedisLock(key, {
        ttlMs: 800,
        maxRetries: 50,
        retryDelayMs: 30,
      });

      try {
        activeInstances.push(id);
        if (activeInstances.length > 1) {
          overlapDetected = true;
        }
        await new Promise((r) => setTimeout(r, 70));
        activeInstances.splice(activeInstances.indexOf(id), 1);
      } finally {
        await releaseRedisLock(handle);
      }
    };

    await Promise.all([runInstance(1), runInstance(2)]);
    expect(overlapDetected).toBe(false);
    expect(activeInstances.length).toBe(0);
    await redis.del(`fence:${key}`);
  });

  it('3. ownership loss detection when Redis key is deleted externally', async () => {
    const key = `loss-detection-${Date.now()}`;
    let reachedPostMutation = false;

    const promise = withDistributedLock(
      key,
      async (ctx) => {
        await new Promise((r) => setTimeout(r, 60));
        // Force delete lock key in Redis
        await redis.del(`lock:${key}`);

        // Wait for renewal loop to detect loss
        await new Promise((r) => setTimeout(r, 120));
        ctx.assertLockValid();
        reachedPostMutation = true;
      },
      { ttlMs: 400, renewalIntervalMs: 40 }
    );

    await expect(promise).rejects.toThrow(LockLostError);
    expect(reachedPostMutation).toBe(false);
    await redis.del(`fence:${key}`);
  });

  it('4. lock expiry followed by new owner acquisition generates strictly higher fencing token', async () => {
    const key = `expiry-new-token-${Date.now()}`;

    // Instance A acquires token N
    const handleA = await acquireRedisLock(key, { ttlMs: 150 });
    const tokenA = handleA.fencingToken;
    expect(tokenA).toBeGreaterThanOrEqual(1);

    // Let Instance A's lease expire without renewal
    await new Promise((r) => setTimeout(r, 220));

    // Instance B acquires lock after expiry
    const handleB = await acquireRedisLock(key, { ttlMs: 500 });
    const tokenB = handleB.fencingToken;

    expect(tokenB).toBe(tokenA + 1);

    // Instance A renewal must fail
    const renewedA = await renewRedisLock(handleA, 500);
    expect(renewedA).toBe(false);

    await releaseRedisLock(handleB);
    await redis.del(`fence:${key}`);
  });

  it('5. Test A — End-to-end stale restore rejection across independent instances via real restoreDocument()', async () => {
    const doc = await createTestDoc('End-to-End Real Restore Fencing Doc');
    const docId = doc.id;

    // Seed Version 1 and Version 2 in database and MinIO
    const ydoc1 = new Y.Doc();
    ydoc1.getText('default').insert(0, 'Historical Version 1 Content');
    const v1Bytes = Y.encodeStateAsUpdate(ydoc1);
    await saveVersionSnapshot(docId, 1, v1Bytes);

    const ydoc2 = new Y.Doc();
    ydoc2.getText('default').insert(0, 'Historical Version 2 Content');
    const v2Bytes = Y.encodeStateAsUpdate(ydoc2);
    await saveVersionSnapshot(docId, 2, v2Bytes);

    await withSystemContext(async (db) => {
      await db
        .insertInto('document_versions')
        .values([
          {
            document_id: docId,
            version_number: 1,
            snapshot_key: `${docId}/1.yjs`,
            title: 'Doc V1',
            content_text: 'Historical Version 1 Content',
            created_by: userId,
            trigger: 'manual',
            fencing_token: 1,
          },
          {
            document_id: docId,
            version_number: 2,
            snapshot_key: `${docId}/2.yjs`,
            title: 'Doc V2',
            content_text: 'Historical Version 2 Content',
            created_by: userId,
            trigger: 'manual',
            fencing_token: 2,
          },
        ])
        .execute();

      await db
        .updateTable('documents')
        .set({
          fencing_token: 2,
          snapshot_version: 2,
          title: 'Doc V2 Initial',
          content_text: 'Historical Version 2 Content',
        })
        .where('id', '=', docId)
        .execute();
    });

    const resourceKey = `document:${docId}`;

    // Establish active room in Instance A's memory
    const roomA = await getOrCreateRoom(docId);
    let wsCloseCode = 0;
    let wsCloseReason = '';
    const mockWs: any = {
      readyState: 1,
      send: () => {},
      close: (code: number, reason: string) => {
        wsCloseCode = code;
        wsCloseReason = reason;
      },
    };
    roomA.connections.add({
      id: 'conn-instance-a',
      ws: mockWs,
      userId,
      workspaceId,
      documentId: docId,
      canEdit: true,
      effectiveRole: 'editor',
    });

    let tokenA = 0;
    let tokenB = 0;
    let bRestoreResult: any;

    // Instance A begins the REAL production restoreDocument() to restore Version 1
    const promiseA = restoreDocument(docId, 1, userId, {
      skipLocalMutex: true,
      beforeMutationHook: async (lockContextA) => {
        tokenA = lockContextA?.fencingToken ?? 0;
        expect(tokenA).toBeGreaterThanOrEqual(1);

        // Instance A loses Redis ownership (simulating partition / expiry)
        await redis.del(`lock:${resourceKey}`);

        // Instance B acquires token N+1 and executes the REAL production restoreDocument() to restore Version 2
        bRestoreResult = await restoreDocument(docId, 2, userId, { skipLocalMutex: true });
        tokenB = Number(bRestoreResult.document.fencing_token);
        expect(tokenB).toBe(tokenA + 1);

        // B has completed its restore and committed authoritative state!
        // Now beforeMutationHook returns, allowing Instance A's in-flight restore
        // operation to proceed and attempt its protected mutation.
      },
    });

    // Step 5: Instance A reaches the protected mutation boundary and must be rejected!
    let aRejectedError: any;
    try {
      await promiseA;
    } catch (err: any) {
      aRejectedError = err;
    }

    expect(aRejectedError).toBeDefined();
    expect(
      aRejectedError instanceof StaleFencingTokenError ||
      aRejectedError?.name === 'StaleFencingTokenError' ||
      aRejectedError?.name === 'LockLostError' ||
      aRejectedError?.message?.includes('Stale') ||
      aRejectedError?.message?.includes('superseded')
    ).toBe(true);

    // Active room eviction verified:
    // Sockets closed with WebSocket code 4009 and reason 'Document superseded'
    expect(wsCloseCode).toBe(4009);
    expect(wsCloseReason).toBe('Document superseded');
    expect(getRoom(docId)).toBeUndefined();
    expect(roomA.isClosing).toBe(true);

    // Step 6: Verify final authoritative state in PostgreSQL and MinIO:
    // Instance B's state remains 100% authoritative and untouched by Instance A!
    const finalDoc = await withSystemContext(async (db) => {
      return await db
        .selectFrom('documents')
        .where('id', '=', docId)
        .selectAll()
        .executeTakeFirstOrThrow();
    });

    expect(finalDoc.title).toBe('Doc V2');
    expect(finalDoc.content_text).toBe('Historical Version 2 Content');
    expect(Number(finalDoc.fencing_token)).toBe(tokenB);
    expect(Number(finalDoc.snapshot_version)).toBe(3);

    // Exactly 3 versions exist in document_versions (v1, v2, v3 from B). A did not create v4!
    const allVersions = await withSystemContext(async (db) => {
      return await db
        .selectFrom('document_versions')
        .where('document_id', '=', docId)
        .orderBy('version_number', 'asc')
        .selectAll()
        .execute();
    });
    expect(allVersions).toHaveLength(3);
    expect(Number(allVersions[2].version_number)).toBe(3);
    expect(allVersions[2].title).toBe('Doc V2');
    expect(Number(allVersions[2].fencing_token)).toBe(tokenB);

    // MinIO recovery snapshot remains Instance B's bytes!
    const loadedRecovery = await loadRecoverySnapshot(docId);
    expect(loadedRecovery).toBeTruthy();
    const testDoc = new Y.Doc();
    Y.applyUpdate(testDoc, loadedRecovery!);
    expect(testDoc.getText('default').toString()).toBe('Historical Version 2 Content');

    await redis.del(`fence:${resourceKey}`);
  });

  it('6. Test B — Stale MinIO snapshot cannot win hydration over authoritative DB version', async () => {
    const doc = await createTestDoc('Hydration Fencing Doc');
    const docId = doc.id;

    // 1. PostgreSQL contains fencing token 10 and authoritative snapshot version 2
    const ydocAuth = new Y.Doc();
    ydocAuth.getText('default').insert(0, 'Authoritative Version 2 Content From DB');
    const authVersionBytes = Y.encodeStateAsUpdate(ydocAuth);
    await saveVersionSnapshot(docId, 2, authVersionBytes);

    await withSystemContext(async (db) => {
      await db
        .updateTable('documents')
        .set({
          fencing_token: 10,
          snapshot_version: 2,
          snapshot_key: `versions/${docId}/2.yjs`,
          title: 'Authoritative V2 Doc',
        })
        .where('id', '=', docId)
        .execute();
    });

    // 2. Put stale recovery snapshot in MinIO with older fencing token 9
    const ydocStale = new Y.Doc();
    ydocStale.getText('default').insert(0, 'Stale Uncommitted Bytes from Expired Owner');
    const staleBytes = Y.encodeStateAsUpdate(ydocStale);

    const s3 = getS3Client();
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_SNAPSHOTS,
        Key: `${docId}/latest.yjs`,
        Body: Buffer.from(staleBytes),
        ContentType: 'application/octet-stream',
        Metadata: {
          'fencing-token': '9', // Older than DB fencing token 10
        },
      })
    );

    // 3. Call loadRoomSnapshot()
    const testDoc1 = new Y.Doc();
    const loaded1 = await loadRoomSnapshot(docId, testDoc1);

    // VERIFICATION:
    // Stale latest.yjs is rejected! The DB-authoritative version snapshot is loaded instead!
    expect(loaded1).toBe(true);
    expect(testDoc1.getText('default').toString()).toBe('Authoritative Version 2 Content From DB');
    expect(testDoc1.getText('default').toString()).not.toContain('Stale Uncommitted Bytes');

    // 4. Test missing fencing-token metadata in MinIO:
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_SNAPSHOTS,
        Key: `${docId}/latest.yjs`,
        Body: Buffer.from(staleBytes),
        ContentType: 'application/octet-stream',
        // No fencing-token metadata at all
      })
    );

    const testDoc2 = new Y.Doc();
    const loaded2 = await loadRoomSnapshot(docId, testDoc2);

    // Must still reject latest.yjs and fall back to authoritative version snapshot!
    expect(loaded2).toBe(true);
    expect(testDoc2.getText('default').toString()).toBe('Authoritative Version 2 Content From DB');
    expect(testDoc2.getText('default').toString()).not.toContain('Stale Uncommitted Bytes');

    // 5. BLK-2 Regression: Test uncommitted/aborted recovery snapshot with fencing token > DB token:
    // MinIO contains token 11 while PostgreSQL remains at token 10!
    const ydocUncommitted = new Y.Doc();
    ydocUncommitted.getText('default').insert(0, 'Uncommitted Aborted Bytes from Rollback');
    const uncommittedBytes = Y.encodeStateAsUpdate(ydocUncommitted);

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_SNAPSHOTS,
        Key: `${docId}/latest.yjs`,
        Body: Buffer.from(uncommittedBytes),
        ContentType: 'application/octet-stream',
        Metadata: {
          'fencing-token': '11', // Greater than DB fencing token 10 (uncommitted/aborted state!)
        },
      })
    );

    const testDoc3 = new Y.Doc();
    const loaded3 = await loadRoomSnapshot(docId, testDoc3);

    // INVARIANT: The uncommitted snapshot (token 11) MUST be rejected, falling back to authoritative DB version!
    expect(loaded3).toBe(true);
    expect(testDoc3.getText('default').toString()).toBe('Authoritative Version 2 Content From DB');
    expect(testDoc3.getText('default').toString()).not.toContain('Uncommitted Aborted Bytes');

    await redis.del(`fence:document:${docId}`);
  });

  it('7. Test C — Background persistence rejects stale room and triggers WebSocket eviction (code 4009)', async () => {
    const doc = await createTestDoc('Background Persistence Fencing Doc');
    const docId = doc.id;

    // 1. Create active room with fencing token N
    const room = await getOrCreateRoom(docId);
    const initialToken = room.fencingToken ?? 1;
    expect(initialToken).toBeGreaterThanOrEqual(1);

    // 2. Attach mock client connection to room
    let closeCode = 0;
    let closeReason = '';
    const mockWs: any = {
      readyState: 1, // WebSocket.OPEN
      send: () => {},
      close: (code: number, reason: string) => {
        closeCode = code;
        closeReason = reason;
      },
    };

    const clientConn: ClientConnection = {
      id: 'conn-test-1',
      ws: mockWs,
      userId,
      workspaceId,
      documentId: docId,
      canEdit: true,
      effectiveRole: 'editor',
    };
    room.connections.add(clientConn);

    // 3. Make a newer token N+10 authoritative in PostgreSQL
    const newerToken = initialToken + 10;
    await withSystemContext(async (db) => {
      await db
        .updateTable('documents')
        .set({
          fencing_token: newerToken,
          title: 'Authoritative State from Newer Owner',
        })
        .where('id', '=', docId)
        .execute();
    });

    // 4. Client edits the stale room
    room.doc.getText('default').insert(0, 'Stale Edits In Stale Room');
    room.docSeq = 1;

    // 5. Trigger persistence from old room
    let persistenceRejected = false;
    try {
      await flushRoomPersistence(room);
    } catch (err: any) {
      if (
        err instanceof StaleFencingTokenError ||
        err?.name === 'StaleFencingTokenError' ||
        err?.message?.includes('Stale recovery snapshot persistence')
      ) {
        persistenceRejected = true;
      }
    }

    // VERIFICATION:
    // Stale persistence must be rejected!
    expect(persistenceRejected).toBe(true);

    // Client connection must receive WebSocket close code 4009 with reason 'Document superseded'
    expect(closeCode).toBe(4009);
    expect(closeReason).toBe('Document superseded');

    // Stale room must be completely evicted and removed from rooms map
    expect(getRoom(docId)).toBeUndefined();
    expect(room.isClosing).toBe(true);

    // DB state must remain untouched by stale room
    const checkDoc = await withSystemContext(async (db) => {
      return await db
        .selectFrom('documents')
        .where('id', '=', docId)
        .selectAll()
        .executeTakeFirstOrThrow();
    });
    expect(checkDoc.title).toBe('Authoritative State from Newer Owner');
    expect(Number(checkDoc.fencing_token)).toBe(newerToken);

    await redis.del(`fence:document:${docId}`);
  });

  it('8. concurrent restore requests across independent instances serialize cleanly', async () => {
    const doc = await createTestDoc('Concurrent Restore Doc');
    const docId = doc.id;

    // Seed Version 1 and Version 2
    const ydoc1 = new Y.Doc();
    ydoc1.getText('default').insert(0, 'Concurrent V1');
    await saveVersionSnapshot(docId, 1, Y.encodeStateAsUpdate(ydoc1));

    const ydoc2 = new Y.Doc();
    ydoc2.getText('default').insert(0, 'Concurrent V2');
    await saveVersionSnapshot(docId, 2, Y.encodeStateAsUpdate(ydoc2));

    await withSystemContext(async (db) => {
      await db
        .insertInto('document_versions')
        .values([
          {
            document_id: docId,
            version_number: 1,
            snapshot_key: `versions/${docId}/1.yjs`,
            title: 'V1',
            content_text: 'Concurrent V1',
            created_by: userId,
            trigger: 'manual',
          },
          {
            document_id: docId,
            version_number: 2,
            snapshot_key: `versions/${docId}/2.yjs`,
            title: 'V2',
            content_text: 'Concurrent V2',
            created_by: userId,
            trigger: 'manual',
          },
        ])
        .execute();

      await db
        .updateTable('documents')
        .set({ snapshot_version: 2, title: 'V2' })
        .where('id', '=', docId)
        .execute();
    });

    // Execute two restores concurrently simulating two separate server instances
    const p1 = restoreDocument(docId, 1, userId, { skipLocalMutex: true });
    const p2 = restoreDocument(docId, 2, userId, { skipLocalMutex: true });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.newVersion).toBeDefined();
    expect(r2.newVersion).toBeDefined();
    // They must produce distinct version numbers (e.g. 3 and 4)
    expect(r1.newVersion.version_number).not.toBe(r2.newVersion.version_number);

    // The document table in DB must reflect the latest restore
    const docAfter = await withSystemContext(async (db) => {
      return await db
        .selectFrom('documents')
        .where('id', '=', docId)
        .selectAll()
        .executeTakeFirstOrThrow();
    });
    expect(Number(docAfter.snapshot_version)).toBe(4);
    expect(Number(docAfter.fencing_token)).toBeGreaterThanOrEqual(1);

    await redis.del(`fence:document:${docId}`);
  });

  it('9. room creation vs restore across independent instances serializes safely', async () => {
    const doc = await createTestDoc('Room vs Restore Doc');
    const docId = doc.id;

    // Version 1 has initial content
    const ydoc1 = new Y.Doc();
    ydoc1.getText('default').insert(0, 'Historical Version 1 Restored Text');
    await saveVersionSnapshot(docId, 1, Y.encodeStateAsUpdate(ydoc1));

    await withSystemContext(async (db) => {
      await db
        .insertInto('document_versions')
        .values({
          document_id: docId,
          version_number: 1,
          snapshot_key: `versions/${docId}/1.yjs`,
          title: 'V1',
          content_text: 'Historical Version 1 Restored Text',
          created_by: userId,
          trigger: 'manual',
        })
        .execute();
    });

    // Start restore (Instance 1) and room creation (Instance 2) concurrently across independent instances
    const restorePromise = restoreDocument(docId, 1, userId, { skipLocalMutex: true });
    const roomPromise = getOrCreateRoom(docId);

    const [restoreRes, room] = await Promise.all([restorePromise, roomPromise]);

    expect(restoreRes.newVersion).toBeDefined();
    expect(room).toBeDefined();
    // Room doc must contain restored text
    expect(room.doc.getText('default').toString()).toBe('Historical Version 1 Restored Text');
    expect(room.fencingToken).toBeGreaterThanOrEqual(1);

    await redis.del(`fence:document:${docId}`);
  });

  it('10. ownership-checked release prevents releasing another instance lock', async () => {
    const key = `ownership-release-${Date.now()}`;
    const handleA = await acquireRedisLock(key, { ttlMs: 2000 });

    // Simulate takeover by Instance B
    await redis.set(`lock:${key}`, 'instance-b-lock-id', 'PX', 5000);

    // Instance A attempts release
    const released = await releaseRedisLock(handleA);
    expect(released).toBe(false);

    // Key still belongs to Instance B
    const val = await redis.get(`lock:${key}`);
    expect(val).toBe('instance-b-lock-id');

    await redis.del(`lock:${key}`, `fence:${key}`);
  });

  it('11. validateFencingToken helper rejects stale tokens', async () => {
    const key = `token-helpers-${Date.now()}`;
    const handle = await acquireRedisLock(key, { ttlMs: 1000 });
    const token = handle.fencingToken;

    // Valid initially
    expect(await validateFencingToken(key, token)).toBe(true);

    // Supersede token in Redis
    await redis.incr(`fence:${key}`);

    // Now stale
    expect(await validateFencingToken(key, token)).toBe(false);

    await releaseRedisLock(handle);
    await redis.del(`fence:${key}`);
  });

  it('12. T3 persistence sequencing and debounced snapshots remain intact under fencing', async () => {
    const doc = await createTestDoc('T3 Sequencing Doc');
    const docId = doc.id;

    const room = await getOrCreateRoom(docId);
    expect(room.fencingToken).toBeGreaterThanOrEqual(1);

    // Simulate edits
    room.doc.getText('default').insert(0, 'Collaborative Edit 1');
    room.docSeq = 1;

    await flushRoomPersistence(room);
    expect(room.lastPersistedSeq).toBe(1);

    // Room shutdown persistence
    await removeRoomIfEmpty(docId, userId);

    // Verify recovery snapshot in MinIO
    const recoveryBytes = await loadRecoverySnapshot(docId);
    expect(recoveryBytes).toBeTruthy();
    const testDoc = new Y.Doc();
    Y.applyUpdate(testDoc, recoveryBytes!);
    expect(testDoc.getText('default').toString()).toBe('Collaborative Edit 1');

    await redis.del(`fence:document:${docId}`);
  });

  it('13. deterministic Redis → PostgreSQL fencing boundary: stale token N rejected across all mutation vectors after B commits N+1', async () => {
    const doc = await createTestDoc('Redis-Postgres Fencing Boundary Doc');
    const docId = doc.id;
    const resourceKey = `document:${docId}`;

    // 1. Instance A gets active room with Redis token N
    const roomA = await getOrCreateRoom(docId);
    const tokenA = roomA.fencingToken ?? 1;
    expect(tokenA).toBeGreaterThanOrEqual(1);

    // Initial DB state reflects tokenA
    const initialDoc = await withSystemContext(async (db) => {
      return await db
        .selectFrom('documents')
        .where('id', '=', docId)
        .selectAll()
        .executeTakeFirstOrThrow();
    });
    expect(Number(initialDoc.fencing_token)).toBe(tokenA);

    // Instance A attaches client connection
    let wsCloseCode = 0;
    let wsCloseReason = '';
    const mockWs: any = {
      readyState: 1,
      send: () => {},
      close: (code: number, reason: string) => {
        wsCloseCode = code;
        wsCloseReason = reason;
      },
    };
    roomA.connections.add({
      id: 'conn-stale-a',
      ws: mockWs,
      userId,
      workspaceId,
      documentId: docId,
      canEdit: true,
      effectiveRole: 'editor',
    });

    // 2. Instance A begins protected operation
    // 3. A loses Redis ownership (simulating partition / expiry)
    await redis.del(`lock:${resourceKey}`);

    // 4. Instance B gets Redis token N+1 and advances DB fencing generation
    const handleB = await acquireRedisLock(resourceKey, { ttlMs: 2000 });
    const tokenB = handleB.fencingToken + 10;
    // Instant sync of newer generation in PostgreSQL
    await syncDocumentFencingToken(docId, tokenB);

    // 5. B commits authoritative PostgreSQL state
    const authYDoc = new Y.Doc();
    authYDoc.getText('default').insert(0, 'Authoritative State From Instance B');
    const authBytes = Y.encodeStateAsUpdate(authYDoc);
    await saveRecoverySnapshot(docId, authBytes, tokenB);
    await saveVersionSnapshot(docId, 1, authBytes);

    await withSystemContext(async (db) => {
      const updated = await db
        .updateTable('documents')
        .set({
          title: 'Authoritative State From Instance B',
          content_text: 'Authoritative State From Instance B',
          snapshot_version: 1,
          fencing_token: tokenB,
          updated_at: new Date(),
        })
        .where('id', '=', docId)
        .where('fencing_token', '<=', tokenB)
        .returningAll()
        .executeTakeFirst();

      expect(updated).toBeDefined();

      await db
        .insertInto('document_versions')
        .values({
          document_id: docId,
          version_number: 1,
          snapshot_key: `${docId}/1.yjs`,
          title: 'Authoritative State From Instance B',
          content_text: 'Authoritative State From Instance B',
          created_by: userId,
          trigger: 'manual',
          fencing_token: tokenB,
        })
        .execute();
    });

    await releaseRedisLock(handleB);

    // 6. A attempts mutations with token N:
    // VECTOR 1: Direct atomic conditional UPDATE on `documents` with token N
    let directUpdateRejected = false;
    try {
      await withSystemContext(async (db) => {
        const res = await db
          .updateTable('documents')
          .set({
            title: 'Stale Overwrite By Instance A',
            fencing_token: tokenA,
            updated_at: new Date(),
          })
          .where('id', '=', docId)
          .where('fencing_token', '<=', tokenA)
          .returningAll()
          .executeTakeFirst();

        // Atomic fencing invariant: zero affected rows MUST be treated as stale failure
        if (!res) {
          throw new StaleFencingTokenError(`Stale update: token ${tokenA} superseded in DB`);
        }
      });
    } catch (err) {
      if (err instanceof StaleFencingTokenError) {
        directUpdateRejected = true;
      }
    }
    expect(directUpdateRejected).toBe(true);

    // VECTOR 2: Stale version checkpoint creation with token N
    let checkpointRejected = false;
    const staleDoc = new Y.Doc();
    staleDoc.getText('default').insert(0, 'Stale Checkpoint Content By A');
    try {
      await createVersionCheckpointOnSessionEnd(docId, staleDoc, userId, tokenA);
    } catch (err) {
      if (err instanceof StaleFencingTokenError) {
        checkpointRejected = true;
      }
    }
    expect(checkpointRejected).toBe(true);

    // VECTOR 3: Stale recovery snapshot overwrite with token N
    let snapshotOverwriteRejected = false;
    try {
      const staleBytes = Buffer.from('Stale Snapshot Bytes By A');
      await saveRecoverySnapshot(docId, staleBytes, tokenA);
    } catch (err) {
      if (err instanceof StaleFencingTokenError) {
        snapshotOverwriteRejected = true;
      }
    }
    expect(snapshotOverwriteRejected).toBe(true);

    // VECTOR 4: Stale active room mutation into authoritative state with token N
    let roomMutationRejected = false;
    roomA.doc.getText('default').insert(0, 'Stale In-Memory Edit By A');
    roomA.docSeq = 1;

    try {
      await flushRoomPersistence(roomA);
    } catch (err) {
      if (err instanceof StaleFencingTokenError) {
        roomMutationRejected = true;
      }
    }
    expect(roomMutationRejected).toBe(true);
    expect(wsCloseCode).toBe(4009);
    expect(wsCloseReason).toBe('Document superseded');
    expect(getRoom(docId)).toBeUndefined();

    // 7. VERIFY FINAL DATABASE AND STORAGE STATE:
    // Instance B's state remains 100% authoritative and unchanged!
    const finalDoc = await withSystemContext(async (db) => {
      return await db
        .selectFrom('documents')
        .where('id', '=', docId)
        .selectAll()
        .executeTakeFirstOrThrow();
    });
    expect(finalDoc.title).toBe('Authoritative State From Instance B');
    expect(finalDoc.content_text).toBe('Authoritative State From Instance B');
    expect(Number(finalDoc.fencing_token)).toBe(tokenB);
    expect(Number(finalDoc.snapshot_version)).toBe(1);

    // Exactly one version checkpoint exists (Instance B's). Stale owner created 0 checkpoints.
    const versions = await withSystemContext(async (db) => {
      return await db
        .selectFrom('document_versions')
        .where('document_id', '=', docId)
        .selectAll()
        .execute();
    });
    expect(versions).toHaveLength(1);
    expect(versions[0].title).toBe('Authoritative State From Instance B');
    expect(Number(versions[0].fencing_token)).toBe(tokenB);

    // MinIO recovery snapshot remains Instance B's content
    const loadedRecovery = await loadRecoverySnapshot(docId);
    expect(loadedRecovery).toBeTruthy();
    const loadedYDoc = new Y.Doc();
    Y.applyUpdate(loadedYDoc, loadedRecovery!);
    expect(loadedYDoc.getText('default').toString()).toBe('Authoritative State From Instance B');

    await redis.del(`fence:${resourceKey}`);
  });

  it('14. BLK-1 Regression: Formatted rich text (bold, italic, code, links) survives full restoreDocument() pipeline without tag injection or data loss', async () => {
    const doc = await createTestDoc('Rich Text Formatting Restore Doc');
    const docId = doc.id;

    // 1. Build historical version 1 with rich-text ProseMirror/Tiptap structure:
    // <p><text with bold, italic, code, link></p>
    const histYDoc = new Y.Doc();
    const histFrag = histYDoc.getXmlFragment('default');
    const p1 = new Y.XmlElement('p');
    const t1 = new Y.XmlText();
    p1.insert(0, [t1]);
    histFrag.insert(0, [p1]);

    // Apply rich-text formatting delta:
    t1.applyDelta([
      { insert: 'Rich text with ' },
      { insert: 'bold formatting', attributes: { bold: true } },
      { insert: ', ' },
      { insert: 'italic formatting', attributes: { italic: true } },
      { insert: ', ' },
      { insert: 'inline code', attributes: { code: true } },
      { insert: ', and ' },
      { insert: 'hyperlink', attributes: { link: { href: 'https://knowledge.platform/doc' } } },
    ]);

    const histBytes = Y.encodeStateAsUpdate(histYDoc);
    await saveVersionSnapshot(docId, 1, histBytes);

    await withSystemContext(async (db) => {
      await db
        .insertInto('document_versions')
        .values({
          document_id: docId,
          version_number: 1,
          snapshot_key: `versions/${docId}/1.yjs`,
          title: 'Formatted V1',
          content_text: 'Rich text with bold formatting, italic formatting, inline code, and hyperlink',
          created_by: userId,
          trigger: 'manual',
        })
        .execute();
    });

    // 2. Establish active room with dummy/modified content
    const room = await getOrCreateRoom(docId);
    const preFrag = room.doc.getXmlFragment('default');
    const preP = new Y.XmlElement('p');
    preP.insert(0, [new Y.XmlText('Unrelated pre-restore draft')]);
    preFrag.insert(0, [preP]);

    // 3. Execute restoreDocument() to restore Version 1
    const restoreResult = await restoreDocument(docId, 1, userId);
    expect(restoreResult.newVersion).toBeDefined();

    // 4. VERIFY RESTORED ROOM DOC IN-MEMORY:
    const restoredFrag = room.doc.getXmlFragment('default');
    expect(restoredFrag.length).toBeGreaterThanOrEqual(1);

    const restoredP = restoredFrag.get(0) as Y.XmlElement;
    expect(restoredP).toBeInstanceOf(Y.XmlElement);
    expect(restoredP.nodeName).toBe('p');

    const restoredText = restoredP.get(0) as Y.XmlText;
    expect(restoredText).toBeInstanceOf(Y.XmlText);

    // Assert delta attributes are 100% preserved:
    const delta = restoredText.toDelta();
    expect(delta).toEqual([
      { insert: 'Rich text with ' },
      { insert: 'bold formatting', attributes: { bold: true } },
      { insert: ', ' },
      { insert: 'italic formatting', attributes: { italic: true } },
      { insert: ', ' },
      { insert: 'inline code', attributes: { code: true } },
      { insert: ', and ' },
      { insert: 'hyperlink', attributes: { link: { href: 'https://knowledge.platform/doc' } } },
    ]);

    // Assert that NO literal pseudo-XML tags leaked into string text content!
    const rawString = restoredText.toString();
    expect(rawString).not.toContain('<bold><bold>');
    expect(rawString).not.toContain('&lt;bold&gt;');
    // The clean plain-text string representation should have formatting tags stripped or pure
    expect(delta.map((d: any) => d.insert).join('')).toBe(
      'Rich text with bold formatting, italic formatting, inline code, and hyperlink'
    );

    await redis.del(`fence:document:${docId}`);
  });

  it('15. BLK-3 Regression: In-flight background persistence does not evict active room or disconnect clients during restoreDocument()', async () => {
    const doc = await createTestDoc('In-Flight Persistence Non-Eviction Doc');
    const docId = doc.id;

    // 1. Seed Version 1
    const ydoc1 = new Y.Doc();
    ydoc1.getText('default').insert(0, 'Historical Version 1');
    await saveVersionSnapshot(docId, 1, Y.encodeStateAsUpdate(ydoc1));

    await withSystemContext(async (db) => {
      await db
        .insertInto('document_versions')
        .values({
          document_id: docId,
          version_number: 1,
          snapshot_key: `versions/${docId}/1.yjs`,
          title: 'V1',
          content_text: 'Historical Version 1',
          created_by: userId,
          trigger: 'manual',
        })
        .execute();
    });

    // 2. Open active room and attach client connection
    const room = await getOrCreateRoom(docId);
    let wsClosed = false;
    let wsCloseCode = 0;
    let wsCloseReason = '';

    const mockWs: any = {
      readyState: 1,
      send: () => {},
      close: (code: number, reason: string) => {
        wsClosed = true;
        wsCloseCode = code;
        wsCloseReason = reason;
      },
    };

    room.connections.add({
      id: 'conn-active-restore',
      ws: mockWs,
      userId,
      workspaceId,
      documentId: docId,
      canEdit: true,
      effectiveRole: 'editor',
    });

    // 3. Simulate an in-flight background persistence promise that resolves after restore starts
    let inFlightSettled = false;
    room.inFlightPersistence = (async () => {
      await new Promise((r) => setTimeout(r, 60));
      inFlightSettled = true;
    })();

    // 4. Start restoreDocument() while inFlightPersistence is running
    const restorePromise = restoreDocument(docId, 1, userId);
    const result = await restorePromise;

    // 5. VERIFICATION:
    expect(result.newVersion).toBeDefined();
    expect(inFlightSettled).toBe(true);

    // Active room MUST NOT be evicted!
    expect(getRoom(docId)).toBe(room);
    expect(room.isClosing).toBeFalsy();

    // Client connection MUST NOT receive WebSocket close code 4009!
    expect(wsClosed).toBe(false);
    expect(wsCloseCode).toBe(0);

    // Room Y.Doc must have converged to restored content
    expect(room.doc.getText('default').toString()).toBe('Historical Version 1');

    await redis.del(`fence:document:${docId}`);
  });
});
