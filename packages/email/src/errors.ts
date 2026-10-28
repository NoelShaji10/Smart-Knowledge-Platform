/**
 * Typed error hierarchy for email transport operations.
 * Enables background workers to accurately classify delivery failures for retry or dead-lettering.
 */

export class EmailTransportError extends Error {
  public readonly provider: string;
  public readonly isRetryable: boolean;
  public readonly originalCode?: string;

  constructor(
    message: string,
    options: {
      provider: string;
      isRetryable: boolean;
      originalCode?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'EmailTransportError';
    this.provider = options.provider;
    this.isRetryable = options.isRetryable;
    this.originalCode = options.originalCode;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export class SmtpConfigError extends EmailTransportError {
  constructor(message: string) {
    super(message, {
      provider: 'smtp',
      isRetryable: false,
      originalCode: 'INVALID_CONFIG',
    });
    this.name = 'SmtpConfigError';
  }
}

export class SmtpDeliveryError extends EmailTransportError {
  constructor(
    message: string,
    options: {
      isRetryable: boolean;
      originalCode?: string;
      cause?: unknown;
    },
  ) {
    super(message, {
      provider: 'smtp',
      isRetryable: options.isRetryable,
      originalCode: options.originalCode,
      cause: options.cause,
    });
    this.name = 'SmtpDeliveryError';
  }
}

/**
 * Sanitizes potentially sensitive error text (such as SMTP connection strings or passwords)
 * to prevent leaking credentials into error logs.
 */
export function sanitizeErrorMessage(rawMessage: string, sensitiveStrings: string[] = []): string {
  let sanitized = rawMessage;

  // Redact explicit sensitive strings (passwords, auth tokens)
  for (const sensitive of sensitiveStrings) {
    if (sensitive && sensitive.trim().length > 0) {
      sanitized = sanitized.split(sensitive).join('[REDACTED]');
    }
  }

  // Redact standard password query parameters or URL credentials: e.g. user:pass@host
  sanitized = sanitized.replace(/(:\/\/[^:]+:)[^@]+(@)/g, '$1[REDACTED]$2');
  // Redact password="..." or pass=...
  sanitized = sanitized.replace(/(password|pass|secret)=([^\s&;,]+)/gi, '$1=[REDACTED]');

  return sanitized;
}

/**
 * Classifies an SMTP failure to determine whether it is transient/retryable.
 */
export function isSmtpRetryable(err: any): boolean {
  if (!err) return false;

  const code = (err.code || err.errno || '').toString().toUpperCase();
  const responseCode = typeof err.responseCode === 'number' ? err.responseCode : parseInt(err.responseCode, 10);

  // Transient network / connection errors
  const retryableNetworkCodes = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EAI_AGAIN',
    'ESOCKET',
    'ENOTFOUND',
  ];
  if (retryableNetworkCodes.includes(code)) {
    return true;
  }

  // Transient SMTP 4xx response codes (e.g. 421 service unavailable, 450 mailbox busy, 451 local error)
  if (!isNaN(responseCode) && responseCode >= 400 && responseCode < 500) {
    return true;
  }

  // Permanent failure conditions
  // EAUTH (auth failed), 5xx response codes (e.g. 550 mailbox not found, 554 transaction failed)
  return false;
}
