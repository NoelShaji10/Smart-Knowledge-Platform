import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger, sanitizeLogData, safeStringify } from '@knowledge/config';
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

  it('sanitizeLogData safely handles circular object references without crashing or infinite recursion', () => {
    const circularObj: any = {
      name: 'root',
      child: {
        name: 'child-node',
      },
    };
    circularObj.child.parent = circularObj;
    circularObj.self = circularObj;

    const sanitized: any = sanitizeLogData(circularObj);

    expect(sanitized.name).toBe('root');
    expect(sanitized.child.name).toBe('child-node');
    expect(sanitized.child.parent).toBe('[CIRCULAR]');
    expect(sanitized.self).toBe('[CIRCULAR]');
    expect(() => JSON.stringify(sanitized)).not.toThrow();
  });

  it('logger.error and safeStringify handle circular structures without throwing', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const circularMeta: any = { requestId: 'req-1' };
    circularMeta.circularRef = circularMeta;

    expect(() => {
      logger.error('Test error with circular metadata', new Error('Something failed'), circularMeta);
    }).not.toThrow();

    expect(consoleSpy).toHaveBeenCalled();
    const loggedOutput = consoleSpy.mock.calls[0][0];
    expect(loggedOutput).toContain('[CIRCULAR]');
    expect(loggedOutput).toContain('Something failed');

    consoleSpy.mockRestore();
  });

  it('redacts embedded JWTs, Bearer tokens, and connection passwords in error messages and stacks', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const embeddedJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const errorWithSecrets = new Error(
      `Database connection to postgres://db_user:SuperSecretPassword123@postgres.internal:5432/knowledge failed with token ${embeddedJwt} and header Bearer secret_bearer_token`,
    );

    logger.error('Database connection error occurred', errorWithSecrets, {
      endpoint: '/api/v1/workspaces',
      connectionUri: 'postgres://app:AppSecretPass@pg.local:5432/db',
    });

    expect(consoleSpy).toHaveBeenCalled();
    const loggedOutput = consoleSpy.mock.calls[0][0];

    // Must NOT contain raw secrets
    expect(loggedOutput).not.toContain('SuperSecretPassword123');
    expect(loggedOutput).not.toContain('AppSecretPass');
    expect(loggedOutput).not.toContain(embeddedJwt);
    expect(loggedOutput).not.toContain('secret_bearer_token');

    // Must contain redaction markers
    expect(loggedOutput).toContain('[REDACTED]');
    expect(loggedOutput).toContain('[REDACTED_JWT]');
    expect(loggedOutput).toContain('Bearer [REDACTED]');

    consoleSpy.mockRestore();
  });

  it('redacts Redis URIs with omitted username (redis://:password@host)', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = new Error('Connection refused to redis://:SecretPass123!@cache.internal:6379');
    logger.error('Redis worker connection failure', err, {
      redisUri: 'redis://:AnotherSecretPass@redis-node-1:6379/0',
    });

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0];

    expect(output).not.toContain('SecretPass123!');
    expect(output).not.toContain('AnotherSecretPass');
    expect(output).toContain('redis://:[REDACTED]@cache.internal:6379');
    expect(output).toContain('redis://:[REDACTED]@redis-node-1:6379/0');

    consoleSpy.mockRestore();
  });

  it('redacts Redis URIs with username and password (redis://user:password@host)', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = new Error('Auth failed on redis://default:SuperSecretPass456@cache.internal:6379');
    logger.error('Redis auth error', err);

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0];

    expect(output).not.toContain('SuperSecretPass456');
    expect(output).toContain('redis://default:[REDACTED]@cache.internal:6379');

    consoleSpy.mockRestore();
  });

  it('preserves Windows stack traces and file:/// URLs with pnpm package paths without corrupting diagnostic text', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const windowsStackTrace =
      'Error: Query failed\n' +
      '    at PostgresConnection.executeQuery (file:///C:/Users/Noel/Desktop/Knowledge%20Platform/node_modules/.pnpm/kysely@0.27.6/node_modules/kysely/dist/esm/dialect/postgres/postgres-driver.js:72:28)\n' +
      '    at DefaultQueryExecutor.executeQuery (file:///C:/Users/Noel/Desktop/Knowledge%20Platform/node_modules/.pnpm/kysely@0.27.6/node_modules/kysely/dist/esm/query-executor/query-executor-base.js:34:16)';

    const err = new Error('Query failed');
    err.stack = windowsStackTrace;

    logger.error('Database query execution error', err);

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0];

    // File path must be completely preserved and NOT corrupted to file:///C:[REDACTED]@0.27.6/...
    expect(output).toContain('file:///C:/Users/Noel/Desktop/Knowledge%20Platform/node_modules/.pnpm/kysely@0.27.6/');
    expect(output).not.toContain('file:///C:[REDACTED]');

    consoleSpy.mockRestore();
  });
});

