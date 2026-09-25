import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger, sanitizeLogData } from '@knowledge/config';
import { processWorkerJob } from '../main';

describe('Tasks 7 & 8: Background Job Failure and Structured Logging', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('processWorkerJob logs structured correlation metadata and rethrows error for pg-boss', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

    const job = {
      id: 'job-uuid-123',
      data: {
        documentId: 'doc-uuid-456',
        workspaceId: 'ws-uuid-789',
        version: 2,
      },
    };

    const failingHandler = vi.fn().mockRejectedValue(new Error('Qdrant service unreachable'));

    await expect(
      processWorkerJob('index.document', job, failingHandler),
    ).rejects.toThrow('Qdrant service unreachable');

    expect(failingHandler).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    const [msg, err, meta] = errorSpy.mock.calls[0];
    expect(msg).toContain('Worker job execution failed');
    expect((err as Error).message).toBe('Qdrant service unreachable');
    expect(meta).toEqual(
      expect.objectContaining({
        queue: 'index.document',
        jobId: 'job-uuid-123',
        documentId: 'doc-uuid-456',
        workspaceId: 'ws-uuid-789',
      }),
    );
  });

  it('sanitizeLogData redacts sensitive tokens, passwords, and secrets', () => {
    const sensitiveData = {
      password: 'SuperSecretPassword123!',
      accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThisSignature',
      authHeader: 'Bearer mock_bearer_token_string',
      apiKey: 'secret_live_key_9999',
      cookie: 'refreshToken=rt_abc123',
      nested: {
        userSecret: 'confidential_value',
        normalField: 'safe_to_log',
      },
    };

    const sanitized: any = sanitizeLogData(sensitiveData);

    expect(sanitized.password).toBe('[REDACTED]');
    expect(sanitized.accessToken).toBe('[REDACTED]');
    expect(sanitized.authHeader).toBe('[REDACTED]');
    expect(sanitized.apiKey).toBe('[REDACTED]');
    expect(sanitized.cookie).toBe('[REDACTED]');
    expect(sanitized.nested.userSecret).toBe('[REDACTED]');
    expect(sanitized.nested.normalField).toBe('safe_to_log');
  });

  it('sanitizeLogData redacts private document content to character length indicator', () => {
    const docData = {
      documentId: 'doc-123',
      title: 'Quarterly Financials',
      contentText: 'CONFIDENTIAL: Internal company financial metrics and payroll disclosures.',
      metadata: {
        content_text: 'Secondary sensitive text block',
      },
    };

    const sanitized: any = sanitizeLogData(docData);

    expect(sanitized.documentId).toBe('doc-123');
    expect(sanitized.title).toBe('Quarterly Financials');
    // Content text must NOT be printed verbatim
    expect(sanitized.contentText).toBe('[TEXT_LEN_73]');
    expect(sanitized.metadata.content_text).toBe('[TEXT_LEN_30]');
    expect(JSON.stringify(sanitized)).not.toContain('financial metrics');
    expect(JSON.stringify(sanitized)).not.toContain('payroll disclosures');
  });
});
