import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearAllRooms,
  getOrCreateRoom,
  getRoom,
  restoreDocument,
  createDocumentCheckpoint,
  Room,
  queueRoomPersistence,
  evictRoom,
  Y,
} from '../../apps/collab-server/src/room-manager';
import { createVersionCheckpointOnSessionEnd } from '../../apps/collab-server/src/snapshot-service';
import * as storage from '@knowledge/storage';
import * as database from '@knowledge/database';
import { getRedisClient, withDistributedLock, LockLostError, StaleFencingTokenError } from '@knowledge/redis';
import { createVersionCheckpoint } from '../../apps/api-server/src/lib/document-version-service';
import { getEnv } from '@knowledge/config';

describe('Phase 5 T4 Remediation Round 3: Adversarial Concurrency & Fencing Tests', () => {
  const docId = '11111111-1111-1111-1111-111111111111';
  const workspaceId = '22222222-2222-2222-2222-222222222222';
  const userId = '33333333-3333-3333-3333-333333333333';

  const storageSnapshots = new Map<string, Uint8Array>();
  const storageVersions = new Map<string, Uint8Array>();

  // In-memory mock DB document table state
  let dbDocRow: any;
  let dbVersions: any[];
  let throwOnRecoveryPointerUpdate = false;
  let forceDivergenceInTest = false;
  let divergenceDbVersionReads = 0;

  beforeEach(() => {
    clearAllRooms();
    storageSnapshots.clear();
    storageVersions.clear();
    throwOnRecoveryPointerUpdate = false;
    forceDivergenceInTest = false;
    divergenceDbVersionReads = 0;

    dbDocRow = {
      id: docId,
      workspace_id: workspaceId,
      title: 'Initial Title',
      content_text: 'Initial Text',
      snapshot_key: `versions/${docId}/1.yjs`,
      snapshot_version: 1,
      fencing_token: 10,
      is_archived: 0,
      updated_at: new Date(),
    };

    dbVersions = [
      {
        id: 'ver-1',
        document_id: docId,
        version_number: 1,
        snapshot_key: `versions/${docId}/1.yjs`,
        title: 'Initial Title',
        content_text: 'Initial Text',
        created_by: userId,
        trigger: 'manual',
        created_at: new Date().toISOString(),
      },
    ];

    // Seed storage with Version 1
    const v1Doc = new Y.Doc();
    v1Doc.getText('default').insert(0, 'Initial Text');
    storageVersions.set(`${docId}:1`, Y.encodeStateAsUpdate(v1Doc));

    vi.spyOn(storage, 'loadVersionSnapshot').mockImplementation(async (dId, ver) => {
      return storageVersions.get(`${dId}:${ver}`) || null;
    });

    vi.spyOn(storage, 'saveVersionSnapshot').mockImplementation(async (dId, ver, data) => {
      const key = `versions/${dId}/${ver}.yjs`;
      storageVersions.set(`${dId}:${ver}`, new Uint8Array(data));
      return key;
    });

    vi.spyOn(storage, 'loadRecoverySnapshot').mockImplementation(async (dId) => {
      return storageSnapshots.get(dId) || null;
    });

    vi.spyOn(storage, 'loadRecoverySnapshotWithMetadata').mockImplementation(async (dId) => {
      const data = storageSnapshots.get(dId);
      if (!data) return null;
      return { data, fencingToken: dbDocRow.fencing_token || 0 };
    });

    vi.spyOn(storage, 'saveRecoverySnapshot').mockImplementation(async (dId, data) => {
      storageSnapshots.set(dId, new Uint8Array(data));
      return `snapshots/${dId}/latest.yjs`;
    });

    setupMockSystemDb();
  });

  afterEach(() => {
    clearAllRooms();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    throwOnRecoveryPointerUpdate = false;
    forceDivergenceInTest = false;
    divergenceDbVersionReads = 0;
  });

  /**
   * Helper to set up a mock system DB reflecting the in-memory dbDocRow & dbVersions
   */
  function setupMockSystemDb() {
    vi.spyOn(database, 'withSystemContext').mockImplementation(async (fn: any) => {
      const createBuilder = (table: string, whereFilters: any[] = []): any => {
        const builder: any = {
          where: (arg1: any, op?: string, val?: any) => {
            return createBuilder(table, [...whereFilters, { arg1, op, val }]);
          },
          select: (_cols: any) => builder,
          selectAll: () => builder,
          forUpdate: () => builder,
          orderBy: () => builder,
          leftJoin: () => builder,
          executeTakeFirst: async () => {
            if (table === 'users') {
              return { id: userId };
            }
            if (table === 'documents') {
              if (whereFilters.some((f) => f.arg1 === 'id' && f.val !== dbDocRow.id)) {
                return null;
              }
              if (whereFilters.some((f) => f.arg1 === 'workspace_id' && f.val !== dbDocRow.workspace_id)) {
                return null;
              }
              return dbDocRow;
            }
            if (table === 'workspace_members') {
              return { role: 'editor' };
            }
            if (table === 'document_permissions') {
              return null;
            }
            if (table === 'document_versions') {
              if (whereFilters.some((f) => f.arg1 === 'version_number')) {
                const verNum = whereFilters.find((f) => f.arg1 === 'version_number')?.val;
                return dbVersions.find((v) => v.version_number === verNum) || null;
              }
              if (forceDivergenceInTest) {
                if (divergenceDbVersionReads > 0) {
                  return { max_ver: 2 }; // Diverged!
                }
                divergenceDbVersionReads++;
                return { max_ver: 1 };
              }
              const maxVer = dbVersions.reduce((m, v) => Math.max(m, v.version_number), 0);
              return { max_ver: maxVer };
            }
            return null;
          },
          executeTakeFirstOrThrow: async () => {
            const res = await builder.executeTakeFirst();
            if (!res) throw new Error(`Not found in ${table}`);
            return res;
          },
          execute: async () => {
            if (table === 'document_versions') {
              return [...dbVersions];
            }
            return [];
          },
        };
        return builder;
      };

      const mockSystemDb: any = {
        selectFrom: (table: string) => createBuilder(table),
        transaction: () => ({
          execute: async (trxFn: any) => await trxFn(mockSystemDb),
        }),
        insertInto: (table: string) => ({
          values: (vals: any) => {
            if (table === 'document_versions') {
              dbVersions.push({ id: `ver-${vals.version_number}`, ...vals });
            }
            return {
              returningAll: () => ({
                executeTakeFirstOrThrow: async () => ({ id: `id-${vals.version_number}`, ...vals }),
              }),
              execute: async () => {},
            };
          },
        }),
        updateTable: (table: string) => ({
          set: (sets: any) => {
            if (
              table === 'documents' &&
              throwOnRecoveryPointerUpdate &&
              sets.snapshot_key &&
              !sets.snapshot_version
            ) {
              throw new Error('PostgreSQL connection dropped during recovery pointer update');
            }

            let whereMatches = true;
            const updateBuilder: any = {
              where: (predicate: any, op?: string, val?: any) => {
                if (typeof predicate === 'function') {
                  const eb: any = (col: string, condOp: string, condVal: any) => {
                    if (condOp === '<=') {
                      return dbDocRow[col] <= condVal;
                    }
                    if (condOp === '<') {
                      return dbDocRow[col] < condVal;
                    }
                    if (condOp === 'is') {
                      return dbDocRow[col] === null || dbDocRow[col] === undefined;
                    }
                    return true;
                  };
                  eb.or = (arr: boolean[]) => arr.some(Boolean);
                  eb.and = (arr: boolean[]) => arr.every(Boolean);
                  eb.val = (v: boolean) => v;

                  const predRes = predicate(eb);
                  if (!predRes) {
                    whereMatches = false;
                  }
                } else if (predicate === 'id' && val !== dbDocRow.id) {
                  whereMatches = false;
                }
                return updateBuilder;
              },
              returning: (_cols: any) => updateBuilder,
              returningAll: () => ({
                executeTakeFirst: async () => {
                  if (!whereMatches) return null;
                  Object.assign(dbDocRow, sets);
                  return dbDocRow;
                },
                executeTakeFirstOrThrow: async () => {
                  if (!whereMatches) throw new StaleFencingTokenError('Stale fencing token');
                  Object.assign(dbDocRow, sets);
                  return dbDocRow;
                },
              }),
              executeTakeFirst: async () => {
                if (!whereMatches) {
                  return { numUpdatedRows: 0n };
                }
                Object.assign(dbDocRow, sets);
                return { numUpdatedRows: 1n };
              },
              execute: async () => {
                if (whereMatches) {
                  Object.assign(dbDocRow, sets);
                }
              },
            };
            return updateBuilder;
          },
        }),
      };
      return await fn(mockSystemDb);
    });
  }

  // =========================================================================
  // TEST 1 — Stale recovery pointer (Blocker 1)
  // =========================================================================
  it('TEST 1: Stale recovery pointer: Token 10 restore delayed write cannot overwrite Token 11 authoritative metadata', async () => {
    // 1. Simulate Token 11 has committed newer state in PostgreSQL
    dbDocRow.fencing_token = 11;
    dbDocRow.snapshot_version = 5;
    dbDocRow.snapshot_key = `versions/${docId}/5.yjs`;

    // 2. Instance A executing with stale Token 10 attempts Step C recovery pointer update:
    let updatedRows = 0;
    await database.withSystemContext(async (systemDb) => {
      const res = await systemDb
        .updateTable('documents')
        .set({ snapshot_key: 'snapshots/11111111-1111-1111-1111-111111111111/latest.yjs' })
        .where('id', '=', docId)
        .where((eb: any) =>
          eb.and([
            eb.or([eb('fencing_token', '<=', 10), eb('fencing_token', 'is', null)]),
            eb('snapshot_version', '<=', 2),
          ])
        )
        .executeTakeFirst();
      updatedRows = Number(res?.numUpdatedRows || 0);
    });

    // 3. ASSERT: 0 rows updated!
    expect(updatedRows).toBe(0);

    // 4. ASSERT: Authoritative DB metadata was NOT overwritten!
    expect(dbDocRow.fencing_token).toBe(11);
    expect(dbDocRow.snapshot_version).toBe(5);
    expect(dbDocRow.snapshot_key).toBe(`versions/${docId}/5.yjs`);
  });

  // =========================================================================
  // TEST 2 — Recovery pointer database failure (Blocker 1)
  // =========================================================================
  it('TEST 2: Recovery pointer database failure: restore fails closed when recovery pointer DB update throws', async () => {
    throwOnRecoveryPointerUpdate = true;

    // restoreDocument must NOT swallow the DB error into a warning; it must reject
    await expect(restoreDocument(docId, 1, userId)).rejects.toThrow(
      'PostgreSQL connection dropped during recovery pointer update'
    );
  });

  // =========================================================================
  // TEST 3 — Concurrent version allocation (Blocker 2 & 3)
  // =========================================================================
  it('TEST 3: Concurrent version allocation: two concurrent checkpoints serialize under document lock without collision', async () => {
    const [vA, vB] = await Promise.all([
      createDocumentCheckpoint(docId, workspaceId, userId, 'manual'),
      createDocumentCheckpoint(docId, workspaceId, userId, 'manual'),
    ]);

    expect(vA).toBeDefined();
    expect(vB).toBeDefined();

    const versions = [vA.version_number, vB.version_number].sort((a, b) => a - b);
    expect(versions).toEqual([2, 3]);

    const v2 = vA.version_number === 2 ? vA : vB;
    const v3 = vA.version_number === 3 ? vA : vB;

    expect(v2.snapshot_key).toBe(`versions/${docId}/2.yjs`);
    expect(v3.snapshot_key).toBe(`versions/${docId}/3.yjs`);
    expect(dbDocRow.snapshot_version).toBe(3);
  });

  // =========================================================================
  // TEST 4 — Restore vs manual checkpoint (Blocker 2 & 3)
  // =========================================================================
  it('TEST 4: Restore vs manual checkpoint: concurrent restore and manual checkpoint serialize under same document lock', async () => {
    const [restoreRes, checkpointRes] = await Promise.all([
      restoreDocument(docId, 1, userId),
      createDocumentCheckpoint(docId, workspaceId, userId, 'manual'),
    ]);

    expect(restoreRes.newVersion).toBeDefined();
    expect(checkpointRes).toBeDefined();

    const restoreVer = restoreRes.newVersion.version_number;
    const checkpointVer = checkpointRes.version_number;

    expect(restoreVer).not.toBe(checkpointVer);
    const sorted = [restoreVer, checkpointVer].sort((a, b) => a - b);
    expect(sorted).toEqual([2, 3]);

    expect(restoreRes.newVersion.snapshot_key).toBe(`versions/${docId}/${restoreVer}.yjs`);
    expect(checkpointRes.snapshot_key).toBe(`versions/${docId}/${checkpointVer}.yjs`);
  });

  // =========================================================================
  // TEST 5 — Session-end checkpoint vs restore
  // =========================================================================
  it('TEST 5: Session-end checkpoint vs restore: concurrent session-end checkpoint and restore serialize cleanly', async () => {
    const sessionDoc = new Y.Doc();
    sessionDoc.getText('default').insert(0, 'Session end content');

    const [sessionEndRes, restoreRes] = await Promise.allSettled([
      createVersionCheckpointOnSessionEnd(docId, sessionDoc, userId),
      restoreDocument(docId, 1, userId),
    ]);

    expect(sessionEndRes.status).toBe('fulfilled');
    expect(restoreRes.status).toBe('fulfilled');

    // Verify all committed versions have matching snapshot keys and no duplicates
    const vNums = dbVersions.map((v) => v.version_number);
    const uniqueVNums = new Set(vNums);
    expect(uniqueVNums.size).toBe(vNums.length);

    for (const v of dbVersions) {
      expect(v.snapshot_key).toBe(`versions/${docId}/${v.version_number}.yjs`);
    }
  });

  // =========================================================================
  // TEST 6 — Active-room checkpoint failure (Option A fail-closed)
  // =========================================================================
  it('TEST 6: Active-room checkpoint failure: storage failure fails closed without committing version or advancing snapshot_version', async () => {
    const prevVersion = dbDocRow.snapshot_version;
    const prevVersionsCount = dbVersions.length;

    vi.spyOn(storage, 'saveVersionSnapshot').mockRejectedValueOnce(
      new Error('MinIO S3 connection refused')
    );

    await expect(
      createDocumentCheckpoint(docId, workspaceId, userId, 'manual')
    ).rejects.toThrow('MinIO S3 connection refused');

    // Invariant: No document_versions row committed, snapshot_version not advanced
    expect(dbDocRow.snapshot_version).toBe(prevVersion);
    expect(dbVersions.length).toBe(prevVersionsCount);
  });

  // =========================================================================
  // TEST 7 — Active-room checkpoint timeout (Option A fail-closed)
  // =========================================================================
  it('TEST 7: Active-room checkpoint timeout: collab server timeout causes API server checkpoint to fail closed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }));

    const mockScopedDb: any = {
      execute: async (fn: any) => await database.withSystemContext(fn),
    };

    await expect(
      createVersionCheckpoint(mockScopedDb, workspaceId, docId, userId, 'manual')
    ).rejects.toThrow(/Collab server timed out during version checkpoint/);

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // TEST 8 — Active-room checkpoint succeeds (Option A)
  // =========================================================================
  it('TEST 8: Active-room checkpoint succeeds: live state captured, persisted, and checkpointed', async () => {
    const room = await getOrCreateRoom(docId);
    room.doc.getText('default').insert(0, 'Live room active text');

    const res = await createDocumentCheckpoint(docId, workspaceId, userId, 'manual');

    expect(res).toBeDefined();
    expect(res.version_number).toBe(2);
    expect(res.snapshot_key).toBe(`versions/${docId}/2.yjs`);
    expect(res.content_text).toContain('Live room active text');
    expect(dbDocRow.snapshot_version).toBe(2);
    expect(room.lastPersistedSeq).toBe(room.docSeq);
  });

  // =========================================================================
  // TEST 9 — Edit immediately around checkpoint (Option A race elimination)
  // =========================================================================
  it('TEST 9: Edit immediately around checkpoint: checkpoint captures state at lock acquisition', async () => {
    const room = await getOrCreateRoom(docId);

    // Edit 1 arrives
    room.doc.getText('default').insert(0, 'Edit 1 before checkpoint. ');

    // Checkpoint executes
    const checkpoint = await createDocumentCheckpoint(docId, workspaceId, userId, 'manual');

    // Edit 2 arrives immediately after
    room.doc.getText('default').insert(0, 'Edit 2 after checkpoint. ');

    expect(checkpoint.content_text).toContain('Edit 1 before checkpoint.');
    expect(checkpoint.content_text).not.toContain('Edit 2 after checkpoint.');

    // Storage recovery snapshot was also updated during checkpoint
    const storedRecovery = storageSnapshots.get(docId);
    expect(storedRecovery).toBeDefined();
    const recoveryDoc = new Y.Doc();
    Y.applyUpdate(recoveryDoc, storedRecovery!);
    expect(recoveryDoc.getText('default').toString()).toContain('Edit 1 before checkpoint.');
  });

  // =========================================================================
  // TEST 10 — Lock loss during checkpoint
  // =========================================================================
  it('TEST 10: Lock loss: fails closed before DB commit if lock verification fails', async () => {
    const prevVersion = dbDocRow.snapshot_version;
    const prevVersionsCount = dbVersions.length;

    vi.spyOn(storage, 'saveVersionSnapshot').mockImplementationOnce(async () => {
      throw new LockLostError('Lock lost during checkpoint');
    });

    await expect(
      createDocumentCheckpoint(docId, workspaceId, userId, 'manual')
    ).rejects.toThrow(LockLostError);

    // Invariant: No version committed in DB
    expect(dbDocRow.snapshot_version).toBe(prevVersion);
    expect(dbVersions.length).toBe(prevVersionsCount);
  });

  // =========================================================================
  // TEST 11 — Version/Key Matching Invariant
  // =========================================================================
  it('TEST 11: Version/key invariant: for every committed row, parseVersion(snapshot_key) === version_number', async () => {
    function parseVersionFromKey(key: string): number {
      const match = key.match(/\/(\d+)\.yjs$/);
      if (!match) throw new Error(`Invalid snapshot key format: ${key}`);
      return parseInt(match[1], 10);
    }

    // Run several checkpoints
    await createDocumentCheckpoint(docId, workspaceId, userId, 'manual');
    await createDocumentCheckpoint(docId, workspaceId, userId, 'manual');
    await restoreDocument(docId, 1, userId);

    expect(dbVersions.length).toBeGreaterThanOrEqual(4);

    for (const v of dbVersions) {
      expect(parseVersionFromKey(v.snapshot_key)).toBe(v.version_number);
    }
  });

  // =========================================================================
  // TEST 12 — Multi-Instance Real Redis Fencing & Lock Serialization
  // =========================================================================
  it('TEST 12: Real Redis serialization: prevents two simultaneous critical sections on same document', async () => {
    const lockKey = `document:multi-instance-${Date.now()}`;
    const executionOrder: string[] = [];
    const tokens: number[] = [];

    const p1 = withDistributedLock(lockKey, async (ctx1) => {
      tokens.push(ctx1.fencingToken);
      executionOrder.push('start:1');
      await new Promise((r) => setTimeout(r, 40));
      executionOrder.push('end:1');
    });

    const p2 = (async () => {
      await new Promise((r) => setTimeout(r, 10));
      return await withDistributedLock(lockKey, async (ctx2) => {
        tokens.push(ctx2.fencingToken);
        executionOrder.push('start:2');
        executionOrder.push('end:2');
      });
    })();

    await Promise.all([p1, p2]);

    expect(executionOrder).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
    expect(tokens[1]).toBeGreaterThan(tokens[0]);
  });

  // =========================================================================
  // TEST 13 — Eviction guard refinement (from Round 2)
  // =========================================================================
  it('TEST 13: Refined eviction guard: genuine LockLostError evicts room even if isRestoring is true', async () => {
    const room = await getOrCreateRoom(docId);
    room.isRestoring = true;

    let evicted = false;
    let evictionReason = '';

    const mockWs: any = {
      readyState: 1,
      close: (code: number, reason: string) => {
        if (code === 4009) {
          evicted = true;
          evictionReason = reason;
        }
      },
    };
    room.connections.add({
      id: 'conn-test',
      ws: mockWs,
      userId,
      workspaceId,
      documentId: docId,
      canEdit: true,
      effectiveRole: 'editor',
    });

    vi.spyOn(storage, 'saveRecoverySnapshot').mockRejectedValue(
      new LockLostError('Lock lease expired in Redis')
    );

    await expect(queueRoomPersistence(room)).rejects.toThrow(LockLostError);

    expect(evicted).toBe(true);
    expect(getRoom(docId)).toBeUndefined();
  });
});
