import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, isAppError } from '@occulta/framework';
import type { Logger } from '../logger.ts';

/** Tags every request with an id (the caller's `x-request-id` if it sent one) and returns it. */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const id = req.get('x-request-id') ?? randomUUID();
    res.locals.requestId = id;
    res.setHeader('x-request-id', id);
    next();
  };
}

/** Logs each request when it finishes. */
export function requestLog(logger: Logger, module: string): RequestHandler {
  return (req, res, next) => {
    const started = performance.now();
    res.on('finish', () => {
      logger.info({ module, requestId: res.locals.requestId, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(performance.now() - started) }, 'request');
    });
    next();
  };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** BRD 2.2.15: the RPC server accepts connections only from the same machine. */
export function localOnly(): RequestHandler {
  return (req, _res, next) => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) throw new AppError(403, 'NOT_LOCAL', 'The RPC server only accepts local connections');
    next();
  };
}

/** BRD 2.2.15: every RPC call carries the local access token. */
export function bearerToken(token: string): RequestHandler {
  const expected = Buffer.from(token);
  return (req, _res, next) => {
    const given = Buffer.from(/^Bearer (.+)$/.exec(req.get('authorization') ?? '')?.[1] ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new AppError(401, 'UNAUTHORIZED', 'Missing or wrong access token');
    next();
  };
}

/** Allows the wallet website (any origin) to call the public relayer API. */
export function openCors(): RequestHandler {
  return (req, res, next) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

/** The only place that turns errors into responses: `{ code, message }`, never a stack trace. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    if (isAppError(err)) {
      res.status(err.statusCode).json({ code: err.code, message: err.message });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ code: 'INVALID_INPUT', message: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') });
      return;
    }
    if ((err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ code: 'INVALID_JSON', message: 'The request body is not valid JSON' });
      return;
    }
    logger.error({ err, requestId: res.locals.requestId }, 'unexpected error');
    res.status(500).json({ code: 'INTERNAL', message: 'Something went wrong' });
  };
}
