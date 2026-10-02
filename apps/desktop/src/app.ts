import express, { type Express } from 'express';
import { AppError, type RelayerService } from '@occulta/framework';
import { nodeRoutes, type NodeService } from './modules/node/index.ts';
import { relayerRoutes } from './modules/relayer/index.ts';
import type { Logger } from './shared/logger.ts';
import { bearerToken, errorHandler, localOnly, openCors, requestId, requestLog } from './shared/middlewares/index.ts';

const bigintAsString = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);

function notFound(): never {
  throw new AppError(404, 'NOT_FOUND', 'No such endpoint');
}

/** The local RPC API for desktop applications on the same machine (BRD 2.2.15). */
export function createRpcApp(deps: { node: NodeService; token: string; logger: Logger; ready: () => boolean }): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('json replacer', bigintAsString);
  app.use(requestId(), requestLog(deps.logger, 'rpc'), localOnly());
  app.get('/healthz', (_req, res) => {
    res.status(deps.ready() ? 200 : 503).json({ ok: deps.ready() });
  });
  app.use(bearerToken(deps.token), express.json({ limit: '1mb' }));
  app.use(nodeRoutes(deps.node));
  app.use(notFound);
  app.use(errorHandler(deps.logger));
  return app;
}

/** The public transaction relayer API (BRD 2.2.11), callable from the wallet website. */
export function createRelayerApp(deps: { relayer: RelayerService; logger: Logger }): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId(), requestLog(deps.logger, 'relayer'), openCors(), express.json({ limit: '64kb' }));
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(relayerRoutes(deps.relayer));
  app.use(notFound);
  app.use(errorHandler(deps.logger));
  return app;
}
