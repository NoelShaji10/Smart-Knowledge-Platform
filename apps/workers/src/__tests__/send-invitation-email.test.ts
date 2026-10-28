import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import * as databaseModule from '@knowledge/database';
import * as emailModule from '@knowledge/email';
import { handleSendInvitationEmail } from '../handlers/send-invitation-email';
import { SendInvitationEmailJobPayload } from '@knowledge/jobs';

describe('Worker Handler: handleSendInvitationEmail (AUD-T3-01 & AUD-T3-02)', () => {
  const invitationId = 'inv-uuid-1111-2222-3333';
  const workspaceId = 'ws-uuid-4444-5555-6666';
  const rawToken = 'raw_invitation_secret_entropy_token_12345';
  const validTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  let mockDbUpdates: Array<{ table: string; values: any; whereClause?: any }>;
  let mockInvitationRow: any;
  let mockTransportSend: any;
  let activeTransactionCount: number;
  let transactionCommitCount: number;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockDbUpdates = [];
    activeTransactionCount = 0;
    transactionCommitCount = 0;

    // Default valid pending invitation row
    mockInvitationRow = {
      id: invitationId,
      workspace_id: workspaceId,
      invitee_email: 'newuser@example.com',
      role: 'editor',
      status: 'pending',
      token_hash: validTokenHash,
      expires_at: new Date(Date.now() + 86400000 * 7), // 7 days in future
      email_delivery_status: 'queued',
      email_delivery_attempts: 0,
      workspace_name: 'Acme Corp',
      inviter_name: 'Alice Admin',
    };

    // Realistic transaction mock simulating Kysely's rollback on exception and conditional update semantics
    vi.spyOn(databaseModule, 'withSystemContext').mockImplementation(async (callback: any) => {
      activeTransactionCount++;
      const txUpdates: Array<{ table: string; values: any; whereClauses?: any[] }> = [];

      const mockTxDb: any = {
        updateTable: (table: string) => {
          let setValues: any = {};
          const whereClauses: any[] = [];
          const builder: any = {
            set: (vals: any) => {
              setValues = vals;
              return builder;
            },
            where: (colOrEb: any, op?: string, val?: any) => {
              whereClauses.push({ colOrEb, op, val });
              return builder;
            },
            execute: async () => {
              if (table === 'workspace_invitations' && mockInvitationRow) {
                // Conditional checks for claim lease ownership and status
                const claimClause = whereClauses.find((w) => w.colOrEb === 'claim_id');
                if (claimClause && mockInvitationRow.claim_id !== claimClause.val) {
                  return [{ numUpdatedRows: 0n }];
                }
                const statusClause = whereClauses.find((w) => w.colOrEb === 'status');
                if (statusClause && mockInvitationRow.status !== statusClause.val) {
                  return [{ numUpdatedRows: 0n }];
                }

                txUpdates.push({ table, values: setValues, whereClauses });
                Object.assign(mockInvitationRow, setValues);
                return [{ numUpdatedRows: 1n }];
              }
              return [{ numUpdatedRows: 1n }];
            },
          };
          return builder;
        },
        selectFrom: (table: string) => {
          const builder: any = {
            innerJoin: () => builder,
            leftJoin: () => builder,
            where: () => builder,
            select: () => builder,
            forUpdate: () => builder,
            executeTakeFirst: async () => (mockInvitationRow ? { ...mockInvitationRow } : null),
          };
          return builder;
        },
      };

      try {
        const res = await callback(mockTxDb);
        // Transaction committed: persist updates to global log
        mockDbUpdates.push(...txUpdates);
        transactionCommitCount++;
        return res;
      } catch (txErr) {
        // Transaction aborted: updates in this transaction are rolled back (not added to mockDbUpdates)
        throw txErr;
      } finally {
        activeTransactionCount--;
      }
    });

    mockTransportSend = vi.fn().mockImplementation(async () => {
      // VERIFY AUD-T3-01 INVARIANT: SMTP network I/O must execute COMPLETELY OUTSIDE any DB transaction
      expect(activeTransactionCount).toBe(0);
      return {
        messageId: '<invitation-msg-123@smtp.knowledge.local>',
        accepted: true,
        provider: 'mock-smtp',
      };
    });

    vi.spyOn(emailModule, 'getEmailTransport').mockReturnValue({
      name: 'mock',
      send: mockTransportSend,
    } as any);
  });

  function createValidPayload(): SendInvitationEmailJobPayload {
    const aad = emailModule.buildInvitationAad(invitationId);
    const encryptedToken = emailModule.encryptInvitationToken(rawToken, undefined, {
      associatedData: aad,
      keyId: 'v1',
    });

    return {
      invitationId,
      workspaceId,
      encryptedToken,
      keyId: 'v1',
    };
  }

  describe('Payload & Security Validation', () => {
    it('returns INVALID_PAYLOAD if required payload fields are missing', async () => {
      const result = await handleSendInvitationEmail({} as any);
      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('INVALID_PAYLOAD');
      expect(mockTransportSend).not.toHaveBeenCalled();
    });

    it('fails closed and marks permanently_failed if token decryption fails (AAD mismatch)', async () => {
      const wrongAad = emailModule.buildInvitationAad('different-invitation-id');
      const badPayload: SendInvitationEmailJobPayload = {
        invitationId,
        workspaceId,
        encryptedToken: emailModule.encryptInvitationToken(rawToken, undefined, {
          associatedData: wrongAad,
        }),
      };

      const result = await handleSendInvitationEmail(badPayload);
      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('CRYPTO_DECRYPTION_FAILED');
      expect(mockTransportSend).not.toHaveBeenCalled();

      // Check that DB update committed in separate transaction
      const update = mockDbUpdates.find(
        (u) => u.values.email_delivery_status === 'permanently_failed',
      );
      expect(update).toBeTruthy();
      expect(update?.values.email_failure_reason).toBe('CRYPTO_DECRYPTION_FAILED');
    });

    it('drops job cleanly if invitation record does not exist in database (AUD-T3-02)', async () => {
      mockInvitationRow = null;
      const payload = createValidPayload();

      const result = await handleSendInvitationEmail(payload);
      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('NOT_FOUND');
      expect(mockTransportSend).not.toHaveBeenCalled();
    });
  });

  describe('Idempotency & Race Conditions', () => {
    it('skips duplicate send if invitation email was already accepted by provider', async () => {
      mockInvitationRow.email_delivery_status = 'accepted_by_provider';
      const payload = createValidPayload();

      const result = await handleSendInvitationEmail(payload);
      expect(result.delivered).toBe(true);
      expect(result.reason).toBe('ALREADY_ACCEPTED_BY_PROVIDER');
      expect(mockTransportSend).not.toHaveBeenCalled();
    });

    it('skips delivery and records failed if invitation is no longer pending (revoked or accepted)', async () => {
      mockInvitationRow.status = 'revoked';
      const payload = createValidPayload();

      const result = await handleSendInvitationEmail(payload);
      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('INVITATION_REVOKED');
      expect(mockTransportSend).not.toHaveBeenCalled();

      const update = mockDbUpdates.find(
        (u) => u.values.email_delivery_status === 'failed',
      );
      expect(update).toBeTruthy();
      expect(update?.values.email_failure_reason).toBe('INVITATION_REVOKED');
    });

    it('skips delivery and marks expired if invitation expired before delivery', async () => {
      mockInvitationRow.expires_at = new Date(Date.now() - 60000); // 1 minute ago
      const payload = createValidPayload();

      const result = await handleSendInvitationEmail(payload);
      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('INVITATION_EXPIRED');
      expect(mockTransportSend).not.toHaveBeenCalled();

      const update = mockDbUpdates.find((u) => u.values.status === 'expired');
      expect(update).toBeTruthy();
      expect(update?.values.email_delivery_status).toBe('failed');
      expect(update?.values.email_failure_reason).toBe('INVITATION_EXPIRED');
    });

    it('detects superseded token hash and drops stale job after resend', async () => {
      mockInvitationRow.token_hash = crypto.createHash('sha256').update('brand_new_token').digest('hex');
      const payload = createValidPayload(); // contains old token

      const result = await handleSendInvitationEmail(payload);
      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('TOKEN_SUPERSEDED');
      expect(mockTransportSend).not.toHaveBeenCalled();

      const update = mockDbUpdates.find((u) => u.values.email_failure_reason === 'TOKEN_SUPERSEDED');
      expect(update).toBeTruthy();
      expect(update?.values.email_delivery_status).toBe('failed');
    });

    it('skips sending email if invitation is shareable without recipient email', async () => {
      mockInvitationRow.invitee_email = null;
      const payload = createValidPayload();

      const result = await handleSendInvitationEmail(payload);
      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('NO_RECIPIENT_EMAIL');
      expect(mockTransportSend).not.toHaveBeenCalled();
    });
  });

  describe('AUD-T3-01: Transaction Isolation & Retry Persistence Regression Tests', () => {
    it('executes transport.send outside of any database transaction and commits both transactions on success', async () => {
      const payload = createValidPayload();

      const result = await handleSendInvitationEmail(payload);
      expect(result.delivered).toBe(true);

      // Verify email transport was called outside transaction
      expect(mockTransportSend).toHaveBeenCalledTimes(1);

      // Verify 2 separate transactions committed: Transaction 1 (preparation) and Transaction 2 (accepted)
      expect(transactionCommitCount).toBe(2);

      const processingUpdate = mockDbUpdates.find(
        (u) => u.values.email_delivery_status === 'processing',
      );
      expect(processingUpdate).toBeTruthy();
      expect(processingUpdate?.values.email_delivery_attempts).toBe(1);

      const acceptedUpdate = mockDbUpdates.find(
        (u) => u.values.email_delivery_status === 'accepted_by_provider',
      );
      expect(acceptedUpdate).toBeTruthy();
      expect(acceptedUpdate?.values.email_sent_at).toBeInstanceOf(Date);
      expect(acceptedUpdate?.values.email_failure_reason).toBeNull();
    });

    it('commits attemptCount and failed status in DB before rethrowing retryable SMTP error (no rollback loss)', async () => {
      const payload = createValidPayload();
      const retryableError = new emailModule.SmtpDeliveryError('Transient SMTP failure', {
        isRetryable: true,
        originalCode: 'ECONNRESET',
      });
      mockTransportSend.mockRejectedValueOnce(retryableError);

      // Handler must rethrow for pg-boss
      await expect(handleSendInvitationEmail(payload)).rejects.toThrow('Transient SMTP failure');

      // Verify 2 separate transactions were committed despite outer rethrow:
      // Transaction 1: processing + attempts = 1
      // Transaction 2: failed + ECONNRESET
      expect(transactionCommitCount).toBe(2);

      // Verify attempts and status were NOT rolled back in PostgreSQL
      expect(mockInvitationRow.email_delivery_attempts).toBe(1);
      expect(mockInvitationRow.email_delivery_status).toBe('failed');
      expect(mockInvitationRow.email_failure_reason).toBe('ECONNRESET');

      const failedUpdate = mockDbUpdates.find(
        (u) => u.values.email_delivery_status === 'failed',
      );
      expect(failedUpdate).toBeTruthy();
      expect(failedUpdate?.values.email_failure_reason).toBe('ECONNRESET');
    });

    it('persists attempt counter increments across multiple successive retries (Attempt 1 -> 2 -> 3)', async () => {
      const payload = createValidPayload();
      const retryableError = new emailModule.SmtpDeliveryError('Transient network timeout', {
        isRetryable: true,
        originalCode: 'ETIMEDOUT',
      });
      mockTransportSend.mockRejectedValue(retryableError);

      // --- ATTEMPT 1 ---
      mockInvitationRow.email_delivery_attempts = 0;
      await expect(handleSendInvitationEmail(payload)).rejects.toThrow('Transient network timeout');
      expect(mockInvitationRow.email_delivery_attempts).toBe(1);
      expect(mockInvitationRow.email_delivery_status).toBe('failed');

      // --- ATTEMPT 2 (pg-boss retries after 30s) ---
      // Database row retains attempt = 1 from previous commit
      await expect(handleSendInvitationEmail(payload)).rejects.toThrow('Transient network timeout');
      expect(mockInvitationRow.email_delivery_attempts).toBe(2);
      expect(mockInvitationRow.email_delivery_status).toBe('failed');

      // --- ATTEMPT 3 (pg-boss retries after 60s) ---
      // On 3rd attempt, attempt reaches 3 -> transitions to permanently_failed and does NOT rethrow
      const thirdResult = await handleSendInvitationEmail(payload);
      expect(thirdResult.delivered).toBe(false);
      expect(thirdResult.reason).toBe('ETIMEDOUT');
      expect(mockInvitationRow.email_delivery_attempts).toBe(3);
      expect(mockInvitationRow.email_delivery_status).toBe('permanently_failed');
    });

    it('marks permanently_failed and does not rethrow on non-retryable 550 SMTP error', async () => {
      const payload = createValidPayload();
      const permanentError = new emailModule.SmtpDeliveryError('Mailbox does not exist (550)', {
        isRetryable: false,
        originalCode: '550',
      });
      mockTransportSend.mockRejectedValueOnce(permanentError);

      const result = await handleSendInvitationEmail(payload);
      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('550');

      expect(mockInvitationRow.email_delivery_status).toBe('permanently_failed');
      expect(mockInvitationRow.email_failure_reason).toBe('550');
      expect(mockInvitationRow.email_delivery_attempts).toBe(1);
    });
  });

  describe('AUD-T3-06: Concurrency, Lease Claim, and Stale Worker Protection', () => {
    it('1. prevents duplicate send when another worker holds an active, unexpired lease (CLAIM_ACTIVE)', async () => {
      // Simulate another worker having claimed the invitation 1 minute ago with a 5-minute lease
      mockInvitationRow.email_delivery_status = 'processing';
      mockInvitationRow.claim_id = 'worker-1-uuid';
      mockInvitationRow.claim_expires_at = new Date(Date.now() + 4 * 60 * 1000); // 4 minutes remaining
      const payload = createValidPayload();

      const result = await handleSendInvitationEmail(payload);

      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('CLAIM_ACTIVE');
      expect(mockTransportSend).not.toHaveBeenCalled();
      // Ensure existing worker claim was NOT overwritten
      expect(mockInvitationRow.claim_id).toBe('worker-1-uuid');
    });

    it('2. handles duplicate pg-boss delivery arriving while worker 1 is actively sending', async () => {
      const payload = createValidPayload();

      // While worker 1 is in-flight, mockInvitationRow is 'processing' with unexpired claim_expires_at
      mockInvitationRow.email_delivery_status = 'processing';
      mockInvitationRow.claim_id = 'claim-in-flight-uuid';
      mockInvitationRow.claim_expires_at = new Date(Date.now() + 300000);

      const duplicateResult = await handleSendInvitationEmail(payload);

      expect(duplicateResult.delivered).toBe(false);
      expect(duplicateResult.reason).toBe('CLAIM_ACTIVE');
      expect(mockTransportSend).not.toHaveBeenCalled();
    });

    it('3. allows a second worker to take over and resume after an expired or abandoned lease claim', async () => {
      // Worker 1 crashed or abandoned the job 10 minutes ago (lease was 5 mins)
      mockInvitationRow.email_delivery_status = 'processing';
      mockInvitationRow.claim_id = 'abandoned-claim-uuid';
      mockInvitationRow.claim_expires_at = new Date(Date.now() - 5 * 60 * 1000); // Expired 5 mins ago
      mockInvitationRow.email_delivery_attempts = 1;

      const payload = createValidPayload();
      const result = await handleSendInvitationEmail(payload);

      expect(result.delivered).toBe(true);
      expect(mockTransportSend).toHaveBeenCalledTimes(1);

      // Successfully updated: attempts incremented to 2, accepted by provider, claim cleared
      expect(mockInvitationRow.email_delivery_status).toBe('accepted_by_provider');
      expect(mockInvitationRow.email_delivery_attempts).toBe(2);
      expect(mockInvitationRow.claim_id).toBeNull();
      expect(mockInvitationRow.claim_expires_at).toBeNull();
    });

    it('4. prevents a stale worker from persisting success if its claim has been superseded', async () => {
      const payload = createValidPayload();

      // Simulate a scenario where Worker 1 claimed the job, but while sending, its claim was stolen/superseded
      let txCount = 0;
      const originalWithSystemContext = databaseModule.withSystemContext;
      vi.spyOn(databaseModule, 'withSystemContext').mockImplementation(async (callback: any) => {
        txCount++;
        if (txCount === 2) {
          // In Transaction 2: simulate that another worker took over and changed claim_id in the DB
          mockInvitationRow.claim_id = 'worker-2-new-claim';
        }
        return originalWithSystemContext(callback);
      });

      const result = await handleSendInvitationEmail(payload);

      // Stale worker should be rejected with CLAIM_SUPERSEDED and not overwrite DB
      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('CLAIM_SUPERSEDED');
      expect(mockInvitationRow.claim_id).toBe('worker-2-new-claim');
      expect(mockInvitationRow.email_delivery_status).not.toBe('accepted_by_provider');
    });

    it('5. prevents stale worker from setting accepted_by_provider if invitation was revoked or accepted during send', async () => {
      const payload = createValidPayload();

      let txCount = 0;
      const originalWithSystemContext = databaseModule.withSystemContext;
      vi.spyOn(databaseModule, 'withSystemContext').mockImplementation(async (callback: any) => {
        txCount++;
        if (txCount === 2) {
          // While sending, user revoked the invitation
          mockInvitationRow.status = 'revoked';
        }
        return originalWithSystemContext(callback);
      });

      const result = await handleSendInvitationEmail(payload);

      expect(result.delivered).toBe(false);
      expect(result.reason).toBe('CLAIM_SUPERSEDED');
      // Status remains revoked, NOT overwritten with accepted_by_provider
      expect(mockInvitationRow.status).toBe('revoked');
      expect(mockInvitationRow.email_delivery_status).not.toBe('accepted_by_provider');
    });
  });
});
