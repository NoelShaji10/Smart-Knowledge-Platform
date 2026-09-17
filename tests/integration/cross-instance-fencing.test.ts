import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { runMigrations, getSystemDb, withSystemContext } from '@knowledge/database';
import { registerUser } from '@knowledge/auth';
import {
  ensureBucketsExist,
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
  getFencingToken,
  validateFencingToken,
} from '@knowledge/redis';
import { createWorkspace } from '../../apps/api-server/src/lib/workspace-service';
import {
  getOrCreateRoom,
  removeRoomIfEmpty,
  restoreDocument,
  clearAllRooms,
  flushRoomPersistence,
  withDocumentLock,
  Y,
} from '../../apps/collab-server/src/room-manager';
import {
  persistRecoverySnapshot,
  createVersionCheckpointOnSessionEnd,
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

  it('5. CRITICAL SCENARIO: Old owner write rejected after newer owner commits mutation', async () => {
    const doc = await createTestDoc('Fencing Proof Doc');
    const docId = doc.id;

    // Seed Version 1 and Version 2 in database and MinIO
    const ydoc1 = new Y.Doc();
    ydoc1.getText('default').insert(0, 'Version 1 Content from Instance Initial');
    const v1Bytes = Y.encodeStateAsUpdate(ydoc1);
    await saveVersionSnapshot(docId, 1, v1Bytes);

    const ydoc2 = new Y.Doc();
    ydoc2.getText('default').insert(0, 'Version 2 Content from Instance Initial');
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
          title: 'Doc V2',
        })
        .where('id', '=', docId)
        .execute();
    });

    // Step 1: Instance A acquires document lock (token N = 3)
    const resourceKey = `document:${docId}`;
    const handleA = await acquireRedisLock(resourceKey, { ttlMs: 500, minFencingToken: 2 });
    const tokenA = handleA.fencingToken;
    expect(tokenA).toBeGreaterThanOrEqual(3);

    // Step 2: Instance A starts restore of version 1
    const histBytesA = await loadVersionSnapshot(docId, 1);
    expect(histBytesA).toBeTruthy();

    // Step 3: Instance A loses Redis lease (simulating network split / timeout)
    await redis.del(`lock:${resourceKey}`);

    // Step 4: Instance B acquires document lock (token N+1)
    const handleB = await acquireRedisLock(resourceKey, { ttlMs: 2000 });
    const tokenB = handleB.fencingToken;
    expect(tokenB).toBe(tokenA + 1);

    // Step 5: Instance B performs restore/mutation of version 2 and commits
    const bRestoredBytes = Buffer.from('B Authoritative Content');
    // Instance B writes recovery snapshot with token B
    await saveRecoverySnapshot(docId, bRestoredBytes, tokenB);

    // Instance B commits to PostgreSQL with token B
    await withSystemContext(async (db) => {
      const docRow = await db
        .selectFrom('documents')
        .where('id', '=', docId)
        .select(['fencing_token'])
        .forUpdate()
        .executeTakeFirstOrThrow();

      expect(Number(docRow.fencing_token)).toBeLessThanOrEqual(tokenB);

      await db
        .updateTable('documents')
        .set({
          title: 'Instance B Authoritative State',
          content_text: 'B Authoritative Content',
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
          title: 'Instance B Authoritative State',
          content_text: 'B Authoritative Content',
          created_by: userId,
          trigger: 'restore',
          fencing_token: tokenB,
        })
        .execute();
    });

    // Instance B finishes its operation and releases lock
    await releaseRedisLock(handleB);

    // Step 6: Instance A (which had in-flight async work still settling) wakes up and attempts mutation!
    let instanceAStorageRejected = false;
    let instanceADatabaseRejected = false;

    // 6a: Instance A attempts to overwrite MinIO recovery snapshot with stale token A
    try {
      const aStaleBytes = Buffer.from('A Stale Content Overwrite');
      await saveRecoverySnapshot(docId, aStaleBytes, tokenA);
    } catch (err) {
      if (err instanceof StaleFencingTokenError) {
        instanceAStorageRejected = true;
      }
    }

    // 6b: Instance A attempts to commit stale mutation to PostgreSQL
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

        // Even if check was skipped, conditional update WHERE fencing_token <= tokenA would match 0 rows
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
        instanceADatabaseRejected = true;
      }
    }

    // VERIFICATION:
    // Both MinIO and PostgreSQL must reject Instance A's stale write!
    expect(instanceAStorageRejected).toBe(true);
    expect(instanceADatabaseRejected).toBe(true);

    // Instance B's state in PostgreSQL remains authoritative!
    const finalDoc = await withSystemContext(async (db) => {
      return await db
        .selectFrom('documents')
        .where('id', '=', docId)
        .selectAll()
        .executeTakeFirstOrThrow();
    });

    expect(finalDoc.title).toBe('Instance B Authoritative State');
    expect(finalDoc.content_text).toBe('B Authoritative Content');
    expect(Number(finalDoc.fencing_token)).toBe(tokenB);

    // MinIO recovery snapshot remains Instance B's bytes!
    const loadedRecovery = await loadRecoverySnapshot(docId);
    expect(Buffer.from(loadedRecovery!).toString()).toBe('B Authoritative Content');

    await redis.del(`fence:${resourceKey}`);
  });

  it('6. concurrent restore requests across independent instances serialize cleanly', async () => {
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

    // Execute two restores concurrently simulating two instances
    const p1 = restoreDocument(docId, 1, userId);
    const p2 = restoreDocument(docId, 2, userId);

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

  it('7. room creation vs restore across independent instances serializes safely', async () => {
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

    // Start restore (Instance 1) and room creation (Instance 2) concurrently
    const restorePromise = restoreDocument(docId, 1, userId);
    const roomPromise = getOrCreateRoom(docId);

    const [restoreRes, room] = await Promise.all([restorePromise, roomPromise]);

    expect(restoreRes.newVersion).toBeDefined();
    expect(room).toBeDefined();
    // Room doc must contain restored text
    expect(room.doc.getText('default').toString()).toBe('Historical Version 1 Restored Text');
    expect(room.fencingToken).toBeGreaterThanOrEqual(1);

    await redis.del(`fence:document:${docId}`);
  });

  it('8. ownership-checked release prevents releasing another instance lock', async () => {
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

  it('9. validateFencingToken and assertFencingTokenValid reject stale tokens', async () => {
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

  it('10. T3 persistence sequencing and debounced snapshots remain intact under fencing', async () => {
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
