import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { StaleFencingTokenError } from '@knowledge/types';
import { logger } from '@knowledge/config';

export class AppError extends Error {
  public status: number;
  public code?: string;
  public details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiErrorEnvelope {
  error: string;
  code?: string;
  details?: unknown;
}

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // 1. Zod schema validation error -> 400 Bad Request
  if (err instanceof ZodError || err?.name === 'ZodError') {
    const details = err.errors || err.issues;
    res.status(400).json({
      error: 'Invalid request payload',
      code: 'VALIDATION_ERROR',
      details,
    });
    return;
  }

  // 2. Express JSON body parser SyntaxError -> 400 Bad Request
  if (
    err instanceof SyntaxError &&
    'status' in err &&
    (err as any).status === 400 &&
    'body' in err
  ) {
    res.status(400).json({
      error: 'Invalid JSON payload',
      code: 'INVALID_JSON',
    });
    return;
  }

  // 3. Stale state / fencing token conflict -> 409 Conflict
  if (err instanceof StaleFencingTokenError || err?.name === 'StaleFencingTokenError') {
    res.status(409).json({
      error: err.message || 'Resource conflict or stale document state',
      code: 'CONFLICT_STALE_STATE',
    });
    return;
  }

  // 4. Explicit client error status (400..499)
  const status =
    typeof err.status === 'number'
      ? err.status
      : typeof err.statusCode === 'number'
      ? err.statusCode
      : null;

  if (status && status >= 400 && status < 500) {
    res.status(status).json({
      error: err.message || 'Client error',
      ...(err.code ? { code: err.code } : {}),
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  // 5. Server error (5xx or unhandled error)
  // Security invariant: never expose raw SQL, stack traces, schema details to client.
  logger.error(`API Error ${req.method} ${req.originalUrl || req.url}`, err, {
    method: req.method,
    url: req.originalUrl || req.url,
  });

  const serverStatus = status && status >= 500 ? status : 500;
  const safeMessage =
    serverStatus === 503 ? 'Service unavailable' : 'Internal server error';

  res.status(serverStatus).json({
    error: safeMessage,
    code: serverStatus === 503 ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_SERVER_ERROR',
  });
}

