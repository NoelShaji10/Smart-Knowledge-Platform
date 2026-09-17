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
  Y,
  ClientConnection,
} from '../../apps/collab-server/src/room-manager';
import { loadRoomSnapshot } from '../../apps/collab-server/src/snapshot-service';

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

  it('5. Test A — End-to-end stale restore rejection across independent instances', async () => {
    const doc = await createTestDoc('End-to-End Fencing Doc');
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
            snapshot_key: `versions/${docId}/1.yjs`,
            title: 'Doc V1',
            content_text: 'V1 Content',
            created_by: userId,
            trigger: 'manual',
            fencing_token: 1,
          },
          {
            document_id: docId,
            version_number: 2,
            snapshot_key: `versions/${docId}/2.yjs`,
            title: 'Doc V2',
            content_text: 'V2 Content',
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
        })
        .where('id', '=', docId)
        .execute();
    });

    const resourceKey = `document:${docId}`;

    // Step 1: Instance A acquires document lock with token N = 3
    const handleA = await acquireRedisLock(resourceKey, { ttlMs: 300, minFencingToken: 2 });
    const tokenA = handleA.fencingToken;
    expect(tokenA).toBeGreaterThanOrEqual(3);

    // Step 2: Instance A starts restore of version 1, but its lease expires / split occurs
    await redis.del(`lock:${resourceKey}`);

    // Step 3: Instance B acquires the same document lock with token N+1 = 4
    const handleB = await acquireRedisLock(resourceKey, { ttlMs: 2000 });
    const tokenB = handleB.fencingToken;
    expect(tokenB).toBe(tokenA + 1);

    // Step 4: Instance B performs restore/mutation of version 2 and commits
    const bRestoredBytes = Y.encodeStateAsUpdate(ydoc2);
    await saveRecoverySnapshot(docId, bRestoredBytes, tokenB);

    await withSystemContext(async (db) => {
      await db
        .updateTable('documents')
        .set({
          title: 'Authoritative State From Instance B',
          content_text: 'Historical Version 2 Content',
          snapshot_version: 3,
          fencing_token: tokenB,
          updated_at: new Date(),
        })
        .where('id', '=', docId)
        .where('fencing_token', '<=', tokenB)
        .execute();

      await db
        .insertInto('document_versions')
        .values({
          document_id: docId,
          version_number: 3,
          snapshot_key: `versions/${docId}/3.yjs`,
          title: 'Authoritative State From Instance B',
          content_text: 'Historical Version 2 Content',
          created_by: userId,
          trigger: 'restore',
          fencing_token: tokenB,
        })
        .execute();
    });

    await releaseRedisLock(handleB);

    // Step 5: Instance A (which had in-flight async work still settling with token A) attempts protected mutation!
    let aStorageRejected = false;
    let aDatabaseRejected = false;

    // 5a: Instance A attempts to write recovery snapshot with stale token A
    try {
      const aStaleBytes = Buffer.from('Stale Overwrite From Instance A');
      await saveRecoverySnapshot(docId, aStaleBytes, tokenA);
    } catch (err) {
      if (err instanceof StaleFencingTokenError) {
        aStorageRejected = true;
      }
    }

    // 5b: Instance A attempts to commit to PostgreSQL with stale token A
    try {
      await withSystemContext(async (db) => {
        const docRow = await db
          .selectFrom('documents')
          .where('id', '=', docId)
          .select(['fencing_token'])
          .forUpdate()
          .executeTakeFirstOrThrow();

        if (Number(docRow.fencing_token) > tokenA) {
          throw new StaleFencingTokenError(
            `Stale write: doc fencing_token ${docRow.fencing_token} > incoming ${tokenA}`
          );
        }

        await db
          .updateTable('documents')
          .set({
            title: 'Stale Instance A Title',
            fencing_token: tokenA,
          })
          .where('id', '=', docId)
          .where('fencing_token', '<=', tokenA)
          .returningAll()
          .executeTakeFirstOrThrow();
      });
    } catch (err) {
      if (err instanceof StaleFencingTokenError) {
        aDatabaseRejected = true;
      }
    }

    // VERIFICATION:
    // Both MinIO and PostgreSQL must reject Instance A's stale write!
    expect(aStorageRejected).toBe(true);
    expect(aDatabaseRejected).toBe(true);

    // Instance B's state remains authoritative!
    const finalDoc = await withSystemContext(async (db) => {
      return await db
        .selectFrom('documents')
        .where('id', '=', docId)
        .selectAll()
        .executeTakeFirstOrThrow();
    });

    expect(finalDoc.title).toBe('Authoritative State From Instance B');
    expect(finalDoc.content_text).toBe('Historical Version 2 Content');
    expect(Number(finalDoc.fencing_token)).toBe(tokenB);

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
});
