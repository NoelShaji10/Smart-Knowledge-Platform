import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import * as databaseModule from '@knowledge/database';
import * as jobsModule from '@knowledge/jobs';
import * as emailModule from '@knowledge/email';
import { reconcilePendingInvitationEmails } from '../handlers/reconcile-invitations';
import { PgBoss } from '@knowledge/jobs';

describe('Reconciliation Worker: reconcilePendingInvitationEmails (AUD-T3-05)', () => {
  const invitationId = 'inv-uuid-reconcile-1111';
  const workspaceId = 'ws-uuid-reconcile-2222';
  const rawToken = 'raw_invitation_secret_for_reconciliation_test';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  let mockRows: any[];
  let mockBossSend: any;
  let mockBoss: PgBoss;

  function createEncryptedTokenEnvelope(id: string): any {
    const aad = emailModule.buildInvitationAad(id);
    return emailModule.encryptInvitationToken(rawToken, undefined, {
      associatedData: aad,
      keyId: 'v1',
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();

    const validEnvelope = createEncryptedTokenEnvelope(invitationId);

    // Initial stranded invitation: committed in DB with 'queued' status 60 seconds ago, but no job in pg-boss
    mockRows = [
      {
        id: invitationId,
        workspace_id: workspaceId,
        invitee_email: 'stranded_user@example.com',
        role: 'editor',
        status: 'pending',
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + 86400000 * 7), // 7 days in future
        email_delivery_status: 'queued',
        email_queued_at: new Date(Date.now() - 60000), // 60 seconds ago (stale threshold is 30s)
        email_delivery_attempts: 0,
        encrypted_token: JSON.stringify(validEnvelope),
      },
    ];

    // Mock withSystemContext to query and update mockRows
    vi.spyOn(databaseModule, 'withSystemContext').mockImplementation(async (callback: any) => {
      const mockDb: any = {
        selectFrom: () => {
          let filterStatus: string | null = null;
          let filterBefore: Date | null = null;

          const builder: any = {
            where: (col: string, op: string, val: any) => {
              if (col === 'email_delivery_status') filterStatus = val;
              if (col === 'email_queued_at') filterBefore = val;
              return builder;
            },
            select: () => builder,
            orderBy: () => builder,
            limit: () => builder,
            execute: async () => {
              return mockRows.filter((r) => {
                if (filterStatus && r.email_delivery_status !== filterStatus) return false;
                if (filterBefore && r.email_queued_at > filterBefore) return false;
                if (!r.encrypted_token) return false;
                return true;
              });
            },
          };
          return builder;
        },
        updateTable: () => {
          let setVals: any = {};
          let targetId: string | null = null;

          const builder: any = {
            set: (vals: any) => {
              setVals = vals;
              return builder;
            },
            where: (col: string, op: string, val: any) => {
              if (col === 'id') targetId = val;
              return builder;
            },
            execute: async () => {
              const row = mockRows.find((r) => r.id === targetId);
              if (row) {
                Object.assign(row, setVals);
              }
              return [{ numUpdatedRows: 1n }];
            },
          };
          return builder;
        },
      };

      return callback(mockDb);
    });

    mockBossSend = vi.fn().mockResolvedValue('job-uuid-recovered-123');
    mockBoss = {
      send: mockBossSend,
    } as unknown as PgBoss;
  });

  it('1. recovers committed invitation stranded after API process crash before enqueue', async () => {
    const result = await reconcilePendingInvitationEmails(mockBoss);

    expect(result.discovered).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockBossSend).toHaveBeenCalledTimes(1);

    const [queue, payload, options] = mockBossSend.mock.calls[0];
    expect(queue).toBe(jobsModule.QUEUE_SEND_INVITATION_EMAIL);
    expect(payload.invitationId).toBe(invitationId);
    expect(payload.workspaceId).toBe(workspaceId);
    expect(options.singletonKey).toBe(invitationId);
  });

  it('2. decrypts and verifies token security and encryption during recovery (no raw token in storage)', async () => {
    await reconcilePendingInvitationEmails(mockBoss);

    const payload = mockBossSend.mock.calls[0][1];
    expect(payload.encryptedToken).toBeDefined();
    expect(payload.rawToken).toBeUndefined();

    // Verify recovery preserved AAD binding
    const aad = emailModule.buildInvitationAad(invitationId);
    const decrypted = emailModule.decryptInvitationToken(payload.encryptedToken, undefined, {
      associatedData: aad,
    });
    expect(decrypted).toBe(rawToken);
  });

  it('3. does not re-enqueue if pg-boss reports job already exists (singleton deduplication)', async () => {
    // pg-boss returns null when a job with singletonKey is already active
    mockBossSend.mockResolvedValueOnce(null);

    const result = await reconcilePendingInvitationEmails(mockBoss);

    expect(result.discovered).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1); // Safely skipped deduplicated
    expect(result.failed).toBe(0);
  });

  it('4. retries safely on subsequent reconciliation after transient pg-boss queue failure', async () => {
    // Pass 1: Transient error when enqueuing
    mockBossSend.mockRejectedValueOnce(new Error('pg-boss connection refused'));

    const pass1 = await reconcilePendingInvitationEmails(mockBoss);
    expect(pass1.discovered).toBe(1);
    expect(pass1.enqueued).toBe(0);
    expect(pass1.failed).toBe(1);

    // Row remains queued in database
    expect(mockRows[0].email_delivery_status).toBe('queued');

    // Pass 2: Connection restored
    mockBossSend.mockResolvedValueOnce('job-uuid-recovered-pass2');
    const pass2 = await reconcilePendingInvitationEmails(mockBoss);

    expect(pass2.discovered).toBe(1);
    expect(pass2.enqueued).toBe(1);
    expect(pass2.failed).toBe(0);
  });

  it('5. marks expired invitations as expired and does not enqueue delivery', async () => {
    mockRows[0].expires_at = new Date(Date.now() - 10000); // Expired 10s ago

    const result = await reconcilePendingInvitationEmails(mockBoss);

    expect(result.discovered).toBe(1);
    expect(result.expired).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(mockBossSend).not.toHaveBeenCalled();

    // Checked DB update
    expect(mockRows[0].status).toBe('expired');
    expect(mockRows[0].email_delivery_status).toBe('failed');
    expect(mockRows[0].email_failure_reason).toBe('INVITATION_EXPIRED');
  });

  it('6. skips invitations that were revoked or accepted while queued', async () => {
    mockRows[0].status = 'revoked';

    const result = await reconcilePendingInvitationEmails(mockBoss);

    expect(result.discovered).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.enqueued).toBe(0);
    expect(mockBossSend).not.toHaveBeenCalled();
  });

  it('7. repeated reconciliation remains safe and idempotent', async () => {
    // Run 1: Enqueued
    const run1 = await reconcilePendingInvitationEmails(mockBoss);
    expect(run1.enqueued).toBe(1);

    // Run 2: pg-boss deduplicates active singleton job
    mockBossSend.mockResolvedValue(null);
    const run2 = await reconcilePendingInvitationEmails(mockBoss);
    expect(run2.enqueued).toBe(0);
    expect(run2.skipped).toBe(1);

    // Run 3: Same safe skip
    const run3 = await reconcilePendingInvitationEmails(mockBoss);
    expect(run3.enqueued).toBe(0);
    expect(run3.skipped).toBe(1);
  });
});
