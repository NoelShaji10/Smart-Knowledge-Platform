import { describe, it, expect, vi } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { z, ZodError } from 'zod';
import { StaleFencingTokenError } from '@knowledge/types';
import { errorHandler, AppError } from '../middleware/error-handler';
import { createApiApp } from '../app';

describe('Task 1: API Error Contract & Error Handler', () => {
  function createAppWithRoutes(attachRoutes: (app: express.Express) => void) {
    const app = express();
    app.use(express.json());
    attachRoutes(app);
    app.use(errorHandler);
    return app;
  }

  it('standardizes ZodError to HTTP 400 Bad Request with VALIDATION_ERROR code and details', async () => {
    const schema = z.object({
      name: z.string().min(3),
      count: z.number().positive(),
    });

    const app = createAppWithRoutes((router) => {
      router.post('/test/validation', (req, res, next) => {
        try {
          schema.parse(req.body);
          res.json({ ok: true });
        } catch (err) {
          next(err);
        }
      });
    });

    const res = await request(app)
      .post('/test/validation')
      .send({ name: 'a', count: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request payload');
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.details.length).toBeGreaterThanOrEqual(2);
  });

  it('standardizes JSON syntax parsing error from body parser to HTTP 400 with INVALID_JSON code', async () => {
    const app = createAppWithRoutes((router) => {
      router.post('/test/json', (_req, res) => {
        res.json({ ok: true });
      });
    });

    const res = await request(app)
      .post('/test/json')
      .set('Content-Type', 'application/json')
      .send('{"invalid json: raw');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid JSON payload');
    expect(res.body.code).toBe('INVALID_JSON');
  });

  it('standardizes StaleFencingTokenError to HTTP 409 Conflict', async () => {
    const app = createAppWithRoutes((router) => {
      router.post('/test/stale', (_req, _res, next) => {
        next(new StaleFencingTokenError('Stale fencing token: token 5 superseded by 6'));
      });
    });

    const res = await request(app).post('/test/stale').send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Stale fencing token: token 5 superseded by 6');
    expect(res.body.code).toBe('CONFLICT_STALE_STATE');
  });

  it('preserves meaningful 4xx client errors (401, 403, 404, 429)', async () => {
    const app = createAppWithRoutes((router) => {
      router.get('/test/401', () => {
        throw new AppError('Unauthorized token', 401, 'UNAUTHORIZED');
      });
      router.get('/test/403', () => {
        throw new AppError('Forbidden workspace access', 403, 'FORBIDDEN');
      });
      router.get('/test/404', () => {
        throw new AppError('Document not found', 404, 'NOT_FOUND');
      });
      router.get('/test/429', () => {
        throw new AppError('Too many requests', 429, 'RATE_LIMIT_EXCEEDED');
      });
    });

    const res401 = await request(app).get('/test/401');
    expect(res401.status).toBe(401);
    expect(res401.body.error).toBe('Unauthorized token');
    expect(res401.body.code).toBe('UNAUTHORIZED');

    const res403 = await request(app).get('/test/403');
    expect(res403.status).toBe(403);
    expect(res403.body.error).toBe('Forbidden workspace access');
    expect(res403.body.code).toBe('FORBIDDEN');

    const res404 = await request(app).get('/test/404');
    expect(res404.status).toBe(404);
    expect(res404.body.error).toBe('Document not found');
    expect(res404.body.code).toBe('NOT_FOUND');

    const res429 = await request(app).get('/test/429');
    expect(res429.status).toBe(429);
    expect(res429.body.error).toBe('Too many requests');
    expect(res429.body.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('redacts internal database errors and stack traces on HTTP 500 server failure', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = createAppWithRoutes((router) => {
      router.get('/test/db-failure', () => {
        // Simulate a raw database driver exception leaking query syntax or schema internals
        const rawDbError = new Error('error: relation "sensitive_documents" does not exist in schema "public" at character 15');
        throw rawDbError;
      });
    });

    const res = await request(app).get('/test/db-failure');

    expect(res.status).toBe(500);
    // Security check: client MUST receive safe envelope, NEVER raw SQL or schema names
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.code).toBe('INTERNAL_SERVER_ERROR');
    expect(res.body.error).not.toContain('sensitive_documents');
    expect(res.body.error).not.toContain('schema');
    expect(res.body.stack).toBeUndefined();

    // Verification: server logs captured diagnostic details
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('handles HTTP 503 service unavailable with safe message', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const app = createAppWithRoutes((router) => {
      router.get('/test/unavailable', () => {
        const err = new Error('Database pool exhausted');
        (err as any).status = 503;
        throw err;
      });
    });

    const res = await request(app).get('/test/unavailable');

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Service unavailable');
    expect(res.body.code).toBe('SERVICE_UNAVAILABLE');

    consoleSpy.mockRestore();
  });

  it('returns structured 404 for unmatched routes in createApiApp', async () => {
    const app = createApiApp();
    const res = await request(app).get('/api/v1/completely/nonexistent/endpoint');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Endpoint not found');
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
