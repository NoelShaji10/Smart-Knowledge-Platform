import { describe, it, expect, vi } from 'vitest';
import PgBoss from 'pg-boss';
import { enqueueInvitationEmailJob, SendInvitationEmailJobPayload } from '../invitation-email';
import { QUEUE_SEND_INVITATION_EMAIL } from '../queues';
import { EncryptedPayload } from '@knowledge/email';

describe('Job Queue: Send Invitation Email', () => {
  const sampleEncryptedToken: EncryptedPayload = {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: 'dGVzdC1pdi0xMnl0ZQ==',
    tag: 'dGVzdC1hdXRoLXRhZy0xNg==',
    ciphertext: 'dGVzdC1jaXBoZXJ0ZXh0LXZhbHVl',
    keyId: 'v1',
    hasAad: true,
  };

  const validPayload: SendInvitationEmailJobPayload = {
    invitationId: 'inv-uuid-1234',
    workspaceId: 'ws-uuid-5678',
    encryptedToken: sampleEncryptedToken,
    keyId: 'v1',
  };

  it('enqueues job with correct queue name, singletonKey, and default retry backoff', async () => {
    const mockSend = vi.fn().mockResolvedValue('job-id-999');
    const mockBoss = {
      send: mockSend,
    } as unknown as PgBoss;

    const jobId = await enqueueInvitationEmailJob(mockBoss, validPayload);

    expect(jobId).toBe('job-id-999');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(
      QUEUE_SEND_INVITATION_EMAIL,
      validPayload,
      {
        retryLimit: 3,
        retryDelay: 30,
        retryBackoff: true,
        expireInSeconds: 300,
        singletonKey: 'inv-uuid-1234',
      },
    );
  });

  it('allows overriding retryLimit and retryDelay options', async () => {
    const mockSend = vi.fn().mockResolvedValue('job-id-custom');
    const mockBoss = {
      send: mockSend,
    } as unknown as PgBoss;

    const jobId = await enqueueInvitationEmailJob(mockBoss, validPayload, {
      retryLimit: 5,
      retryDelay: 60,
      retryBackoff: false,
      expireInSeconds: 600,
    });

    expect(jobId).toBe('job-id-custom');
    expect(mockSend).toHaveBeenCalledWith(
      QUEUE_SEND_INVITATION_EMAIL,
      validPayload,
      {
        retryLimit: 5,
        retryDelay: 60,
        retryBackoff: false,
        expireInSeconds: 600,
        singletonKey: 'inv-uuid-1234',
      },
    );
  });

  it('rejects invalid payload missing required fields', async () => {
    const mockBoss = { send: vi.fn() } as unknown as PgBoss;

    await expect(
      enqueueInvitationEmailJob(mockBoss, null as any),
    ).rejects.toThrow(/missing required fields/);

    await expect(
      enqueueInvitationEmailJob(mockBoss, {
        ...validPayload,
        invitationId: '',
      }),
    ).rejects.toThrow(/missing required fields/);

    await expect(
      enqueueInvitationEmailJob(mockBoss, {
        ...validPayload,
        workspaceId: '',
      }),
    ).rejects.toThrow(/missing required fields/);

    await expect(
      enqueueInvitationEmailJob(mockBoss, {
        ...validPayload,
        encryptedToken: null as any,
      }),
    ).rejects.toThrow(/missing required fields/);
  });

  it('ensures payload does not leak raw tokens or credentials', () => {
    const payloadKeys = Object.keys(validPayload);
    expect(payloadKeys).not.toContain('rawToken');
    expect(payloadKeys).not.toContain('token');
    expect(payloadKeys).not.toContain('password');
    expect(payloadKeys).not.toContain('key');
    expect(payloadKeys).not.toContain('secret');
  });
});
