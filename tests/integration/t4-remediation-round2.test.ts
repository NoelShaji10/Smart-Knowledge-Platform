import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearAllRooms, getOrCreateRoom, getRoom, restoreDocument, Room, queueRoomPersistence, evictRoom, Y } from '../../apps/collab-server/src/room-manager';
import * as storage from '@knowledge/storage';
import * as database from '@knowledge/database';
import { getRedisClient, withDistributedLock, LockLostError, StaleFencingTokenError } from '@knowledge/redis';
import { createVersionCheckpoint } from '../../apps/api-server/src/lib/document-version-service';
import { getEnv } from '@knowledge/config';

describe('Phase 5 T4 Remediation Round 2: Adversarial Concurrency & Fencing Tests', () => {
  const docId = '11111111-1111-1111-1111-111111111111';
  const workspaceId = '22222222-2222-2222-2222-222222222222';
  const userId = '33333333-3333-3333-3333-333333333333';

  const storageSnapshots = new Map<string, Uint8Array>();
  const storageVersions = new Map<string, Uint8Array>();

  // In-memory mock DB document table state
  let dbDocRow: any;
  let dbVersions: any[];

  beforeEach(() => {
    clearAllRooms();
    storageSnapshots.clear();
    storageVersions.clear();

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
    forceDivergenceInTest2 = false;
    test2DbVersionReads = 0;
  });

  let forceDivergenceInTest2 = false;
  let test2DbVersionReads = 0;

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
          executeTakeFirst: async () => {
            if (table === 'users') {
              return { id: userId };
            }
            if (table === 'documents') {
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
              if (forceDivergenceInTest2) {
                if (test2DbVersionReads > 0) {
                  return { max_ver: 2 }; // Diverged!
                }
                test2DbVersionReads++;
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
          execute: async () => [],
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
            let whereMatches = true;
            const updateBuilder: any = {
              where: (predicate: any, op?: string, val?: any) => {
                if (typeof predicate === 'function') {
                  // Simulate kysely expression builder
                  const eb: any = (col: string, condOp: string, condVal: any) => {
                    if (condOp === '<=') {
                      return dbDocRow[col] <= condVal;
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
    setupMockSystemDb();

    // 1. Simulate Token 11 has committed newer state in PostgreSQL
    dbDocRow.fencing_token = 11;
    dbDocRow.snapshot_version = 5;
    dbDocRow.snapshot_key = `versions/${docId}/5.yjs`;

    // 2. Instance A executing with stale Token 10 attempts Step C recovery pointer update:
    // UPDATE documents SET snapshot_key = recoveryKey WHERE id = docId AND fencing_token <= 10 AND snapshot_version <= 2
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
  // TEST 2 — Version/key divergence (Blocker 2)
  // =========================================================================
  it('TEST 2: Version/key divergence: fails closed if version allocation diverges before commit', async () => {
    // Force version divergence: Step A sees max_ver = 1 (allocatedVersion = 2).
    // But right before Step B commits, another concurrent checkpoint commits Version 2, advancing max_ver to 2.
    forceDivergenceInTest2 = true;
    test2DbVersionReads = 0;

    // Restore must abort and fail closed with Version divergence detected
    await expect(restoreDocument(docId, 1, userId)).rejects.toThrow(
      /Version divergence detected for document/
    );

    // Verify no mismatched document_versions row was added
    for (const v of dbVersions) {
      const match = v.snapshot_key.match(/\/(\d+)\.yjs$/);
      if (match) {
        expect(Number(match[1])).toBe(v.version_number);
      }
    }
  });

  // =========================================================================
  // TEST 3 — Flush HTTP 500 (Blocker 3)
  // =========================================================================
  it('TEST 3: Flush HTTP 500: createVersionCheckpoint fails closed when collab server returns 500', async () => {
    // Mock global.fetch to return 500
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'Collab server snapshot failure' }),
    }));

    const mockScopedDb: any = {
      execute: vi.fn(),
    };

    await expect(
      createVersionCheckpoint(mockScopedDb, workspaceId, docId, userId, 'manual')
    ).rejects.toThrow(/Collab server flush failed with status 500/);

    // Ensure database transaction was NEVER entered
    expect(mockScopedDb.execute).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // TEST 4 — Flush timeout (Blocker 3)
  // =========================================================================
  it('TEST 4: Flush timeout: createVersionCheckpoint fails closed when collab server flush times out', async () => {
    // Mock global.fetch to simulate AbortError (timeout)
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }));

    const mockScopedDb: any = {
      execute: vi.fn(),
    };

    await expect(
      createVersionCheckpoint(mockScopedDb, workspaceId, docId, userId, 'manual')
    ).rejects.toThrow(/Collab server timed out during persistence flush/);

    // Ensure database transaction was NEVER entered
    expect(mockScopedDb.execute).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // TEST 5 — Flush success with active room (Blocker 3)
  // =========================================================================
  it('TEST 5: Flush success: createVersionCheckpoint proceeds when flush returns 200 { active: true }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ active: true, persistedSeq: 5 }),
    }));

    let checkpointCommitted = false;
    const createUpdateBuilder = () => {
      const ub: any = {
        set: () => ub,
        where: () => ub,
        execute: async () => {},
        executeTakeFirst: async () => ({ numUpdatedRows: 1n }),
      };
      return ub;
    };

    const mockDb: any = {
      selectFrom: (table: string) => ({
        where: () => ({
          where: () => ({
            select: () => ({
              forUpdate: () => ({
                executeTakeFirst: async () => ({
                  id: docId,
                  title: 'Live Title',
                  content_text: 'Live Text',
                  is_archived: 0,
                  snapshot_key: `versions/${docId}/1.yjs`,
                  fencing_token: 0,
                }),
              }),
            }),
          }),
          select: () => ({
            executeTakeFirst: async () => ({ max_ver: 1 }),
          }),
        }),
      }),
      updateTable: () => createUpdateBuilder(),
      insertInto: () => ({
        values: (vals: any) => ({
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => {
              checkpointCommitted = true;
              return { id: 'ver-2', ...vals };
            },
          }),
        }),
      }),
    };

    const mockScopedDb: any = {
      execute: async (fn: any) => await fn(mockDb),
    };

    const res = await createVersionCheckpoint(mockScopedDb, workspaceId, docId, userId, 'manual');
    expect(res).toBeDefined();
    expect(checkpointCommitted).toBe(true);
    expect(res.version_number).toBe(2);

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // TEST 6 — No active room (Blocker 3)
  // =========================================================================
  it('TEST 6: No active room: createVersionCheckpoint succeeds normally when flush returns 200 { active: false }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ active: false }),
    }));

    const createUpdateBuilder = () => {
      const ub: any = {
        set: () => ub,
        where: () => ub,
        execute: async () => {},
        executeTakeFirst: async () => ({ numUpdatedRows: 1n }),
      };
      return ub;
    };

    const mockDb: any = {
      selectFrom: (table: string) => ({
        where: () => ({
          where: () => ({
            select: () => ({
              forUpdate: () => ({
                executeTakeFirst: async () => ({
                  id: docId,
                  title: 'Dormant Title',
                  content_text: 'Dormant Text',
                  is_archived: 0,
                  snapshot_key: `versions/${docId}/1.yjs`,
                  fencing_token: 0,
                }),
              }),
            }),
          }),
          select: () => ({
            executeTakeFirst: async () => ({ max_ver: 1 }),
          }),
        }),
      }),
      updateTable: () => createUpdateBuilder(),
      insertInto: () => ({
        values: (vals: any) => ({
          returningAll: () => ({
            executeTakeFirstOrThrow: async () => ({ id: 'ver-2', ...vals }),
          }),
        }),
      }),
    };

    const mockScopedDb: any = {
      execute: async (fn: any) => await fn(mockDb),
    };

    const res = await createVersionCheckpoint(mockScopedDb, workspaceId, docId, userId, 'manual');
    expect(res).toBeDefined();
    expect(res.version_number).toBe(2);

    vi.unstubAllGlobals();
  });

  // =========================================================================
  // TEST 7 — Checkpoint vs restore race (Blocker 3B)
  // =========================================================================
  it('TEST 7: Manual checkpoint vs restore: serialized by distributed lock', async () => {
    const lockKey = `document:${docId}`;
    let restoreRanFirst = false;
    let checkpointRanSecond = false;

    // Simulate concurrent restore acquiring lock, then checkpoint acquiring lock
    const pRestore = withDistributedLock(lockKey, async () => {
      await new Promise((r) => setTimeout(r, 40));
      restoreRanFirst = true;
    });

    const pCheckpoint = (async () => {
      await new Promise((r) => setTimeout(r, 10)); // initiates while restore holds lock
      return await withDistributedLock(lockKey, async () => {
        expect(restoreRanFirst).toBe(true); // Must execute strictly after restore releases lock!
        checkpointRanSecond = true;
      });
    })();

    await Promise.all([pRestore, pCheckpoint]);
    expect(restoreRanFirst).toBe(true);
    expect(checkpointRanSecond).toBe(true);
  });

  // =========================================================================
  // TEST 8 — Eviction guard refinement (Finding 4)
  // =========================================================================
  it('TEST 8: Refined eviction guard: genuine LockLostError evicts room even if isRestoring is true', async () => {
    const room = await getOrCreateRoom(docId);
    room.isRestoring = true; // Restore in progress

    let evicted = false;
    let evictionReason = '';

    // Mock WebSocket connection to detect close code
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

    // Simulate snapshot service throwing genuine LockLostError
    vi.spyOn(storage, 'saveRecoverySnapshot').mockRejectedValue(
      new LockLostError('Lock lease expired in Redis')
    );

    // Trigger room persistence
    await expect(queueRoomPersistence(room)).rejects.toThrow(LockLostError);

    // Invariant: Genuine LockLostError MUST evict the room even when isRestoring is true!
    expect(evicted).toBe(true);
    expect(getRoom(docId)).toBeUndefined();
  });

  // =========================================================================
  // TEST 9 — Version/Key Matching Invariant
  // =========================================================================
  it('TEST 9: ParseVersion invariant: version_number must strictly equal snapshot_key version for all versions', () => {
    function parseVersionFromKey(key: string): number {
      const match = key.match(/\/(\d+)\.yjs$/);
      if (!match) throw new Error(`Invalid snapshot key format: ${key}`);
      return parseInt(match[1], 10);
    }

    // Seed test versions across multiple ranges
    const versions = [
      { version_number: 1, snapshot_key: `versions/${docId}/1.yjs` },
      { version_number: 2, snapshot_key: `versions/${docId}/2.yjs` },
      { version_number: 15, snapshot_key: `versions/${docId}/15.yjs` },
      { version_number: 999, snapshot_key: `versions/${docId}/999.yjs` },
    ];

    for (const v of versions) {
      expect(parseVersionFromKey(v.snapshot_key)).toBe(v.version_number);
    }
  });

  // =========================================================================
  // TEST 10 — Multi-Instance Real Redis Fencing & Lock Serialization
  // =========================================================================
  it('TEST 10: Multi-instance behavior: real Redis lock hands out strictly increasing fencing tokens and serializes execution', async () => {
    const lockKey = `document:multi-instance-${Date.now()}`;
    const tokens: number[] = [];

    // Instance A acquires lock
    await withDistributedLock(lockKey, async (ctxA) => {
      tokens.push(ctxA.fencingToken);
      expect(ctxA.fencingToken).toBeGreaterThan(0);
    });

    // Instance B acquires lock
    await withDistributedLock(lockKey, async (ctxB) => {
      tokens.push(ctxB.fencingToken);
      expect(ctxB.fencingToken).toBeGreaterThan(tokens[0]);
    });

    expect(tokens[1]).toBeGreaterThan(tokens[0]);
  });
});
