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

// Matches JWTs embedded anywhere in strings (min 20 base64 chars per segment)
const EMBEDDED_JWT_REGEX = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/g;
// Matches Bearer tokens
const BEARER_REGEX = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
// Matches connection URIs containing credentials, e.g. postgres://user:pass@host or redis://:pass@host
// Explicitly ignores file:// URLs and avoids crossing path boundaries.
const URI_PASSWORD_REGEX = /(?<![a-zA-Z0-9])((?!file:\/\/)[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@\s/:]*:)?)([^@\s/]+)(@)/gi;

function sanitizeString(str: string): string {
  let result = str;
  result = result.replace(BEARER_REGEX, 'Bearer [REDACTED]');
  result = result.replace(EMBEDDED_JWT_REGEX, '[REDACTED_JWT]');
  result = result.replace(URI_PASSWORD_REGEX, '$1[REDACTED]$3');
  return result;
}

export function sanitizeLogData(data: unknown, seen = new WeakSet()): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    return sanitizeString(data);
  }

  if (typeof data !== 'object') {
    return data;
  }

  // Cycle-safe guard for non-null objects and arrays
  if (seen.has(data)) {
    return '[CIRCULAR]';
  }
  seen.add(data);

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeLogData(item, seen));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      sanitized[key] = '[REDACTED]';
    } else if (key === 'contentText' || key === 'content_text') {
      // Redact private document text from logs, preserving only character length for diagnostics
      sanitized[key] = typeof value === 'string' ? `[TEXT_LEN_${value.length}]` : '[REDACTED_CONTENT]';
    } else {
      sanitized[key] = sanitizeLogData(value, seen);
    }
  }
  return sanitized;
}

export function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    try {
      // Fallback: pass through cycle-safe sanitizer before stringifying
      return JSON.stringify(sanitizeLogData(data));
    } catch {
      return '[UNSERIALIZABLE]';
    }
  }
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
    const payload = meta ? ` ${safeStringify(sanitizeLogData(meta))}` : '';
    console.log(`[INFO] ${sanitizeString(message)}${payload}`);
  },
  warn(message: string, meta?: StructuredLogMeta): void {
    const payload = meta ? ` ${safeStringify(sanitizeLogData(meta))}` : '';
    console.warn(`[WARN] ${sanitizeString(message)}${payload}`);
  },
  error(message: string, err?: unknown, meta?: StructuredLogMeta): void {
    const errInfo =
      err instanceof Error
        ? {
            name: err.name,
            message: sanitizeString(err.message),
            stack: err.stack ? sanitizeString(err.stack) : undefined,
          }
        : err !== undefined
        ? { rawError: sanitizeString(String(err)) }
        : {};

    const combined = sanitizeLogData({
      ...meta,
      ...errInfo,
    });

    console.error(`[ERROR] ${sanitizeString(message)} ${safeStringify(combined)}`);
  },
};
