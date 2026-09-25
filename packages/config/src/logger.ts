const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /auth/i,
  /authorization/i,
  /cookie/i,
  /key/i,
  /credential/i,
];

export function sanitizeLogData(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    // Redact JWT tokens (header.payload.signature)
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data)) {
      return '[REDACTED_JWT]';
    }
    // Redact Bearer tokens
    if (data.startsWith('Bearer ')) {
      return 'Bearer [REDACTED]';
    }
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeLogData);
  }

  if (typeof data === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
        sanitized[key] = '[REDACTED]';
      } else if (key === 'contentText' || key === 'content_text') {
        // Redact private document text from logs, preserving only character length for diagnostics
        sanitized[key] = typeof value === 'string' ? `[TEXT_LEN_${value.length}]` : '[REDACTED_CONTENT]';
      } else {
        sanitized[key] = sanitizeLogData(value);
      }
    }
    return sanitized;
  }

  return data;
}

export interface StructuredLogMeta {
  requestId?: string;
  jobId?: string;
  workspaceId?: string;
  documentId?: string;
  userId?: string;
  queue?: string;
  status?: number;
  [key: string]: unknown;
}

export const logger = {
  info(message: string, meta?: StructuredLogMeta): void {
    const payload = meta ? ` ${JSON.stringify(sanitizeLogData(meta))}` : '';
    console.log(`[INFO] ${message}${payload}`);
  },
  warn(message: string, meta?: StructuredLogMeta): void {
    const payload = meta ? ` ${JSON.stringify(sanitizeLogData(meta))}` : '';
    console.warn(`[WARN] ${message}${payload}`);
  },
  error(message: string, err?: unknown, meta?: StructuredLogMeta): void {
    const errInfo =
      err instanceof Error
        ? {
            name: err.name,
            message: err.message,
            stack: err.stack,
          }
        : err !== undefined
        ? { rawError: String(err) }
        : {};

    const combined = sanitizeLogData({
      ...meta,
      ...errInfo,
    });

    console.error(`[ERROR] ${message} ${JSON.stringify(combined)}`);
  },
};
