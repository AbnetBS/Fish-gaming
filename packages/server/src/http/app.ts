import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getDb } from '../db/index.js';
import { csrfGuard, registerAuthHooks } from './auth.js';
import { registerPublicRoutes } from './routes/public.routes.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerAccountRoutes } from './routes/account.routes.js';
import { registerGameRoutes } from './routes/game.routes.js';
import { registerAdminRoutes } from './routes/admin.routes.js';
import { registerGameSocket } from '../ws/game-socket.js';
import type { RoundManager } from '../sim/round-manager.js';
import { REAL_MONEY_ENABLED } from '../config/flags.js';

export interface BuildAppOptions {
  rounds: RoundManager;
  /** Serve the built SPA from this directory when it exists. */
  staticDir?: string;
  logger?: boolean;
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
  'cache-control': 'no-store',
};

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const e = env();
  const app = Fastify({
    logger: options.logger === false ? false : ({ level: e.logLevel, base: { service: 'reef-server' } } as any),
    bodyLimit: 64 * 1024,
    trustProxy: true,
    genReqId: (req) => (req.headers['x-request-id'] as string)?.slice(0, 32) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  });

  registerAuthHooks(app);

  // POST endpoints that take no payload are common (leave, logout, publish). A
  // browser fetch with `content-type: application/json` and an empty body would
  // otherwise be a hard 400 from the default parser, so accept it as {}.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = (body as string) ?? '';
    if (!text.trim()) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      done(new AppError(400, 'VALIDATION_FAILED', 'The request body is not valid JSON.'), undefined);
    }
  });

  /* ------------------------------- plugins ------------------------------- */

  await app.register(cookie);
  await app.register(cors, {
    origin: (origin, cb) => {
      // Same-origin / curl / server-to-server requests have no Origin header.
      if (!origin) return cb(null, true);
      if (e.corsOrigins.includes(origin)) return cb(null, true);
      // Local dev: any localhost port is fine (Vite picks a free one).
      if (!e.isProduction && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-csrf-token', 'x-request-id'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: e.rateLimitMax,
    timeWindow: e.rateLimitWindowMs,
    // Per-user quota is friendlier than per-IP behind a shared NAT/mobile IP.
    keyGenerator: (request: FastifyRequest) => (request as any).user?.id || request.ip,
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: 'Too Many Requests',
      code: 'RATE_LIMITED',
      message: 'You are doing that too quickly. Please wait a moment.',
    }),
  });

  await app.register(websocket, { options: { maxPayload: 8192 } });

  /* --------------------------- security hardening --------------------------- */

  app.addHook('onRequest', async (request, reply) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (e.isProduction) {
      reply.header(
        'strict-transport-security',
        'max-age=31536000; includeSubDomains',
      );
      // The CSP keeps the SPA safe even if an injection bug appears somewhere:
      // scripts are same-origin only, and blob: data URLs cover our generated
      // audio. Frames are refused entirely (see x-frame-options too).
      reply.header(
        'content-security-policy',
        [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "media-src 'self' blob: data:",
          "font-src 'self' data:",
          "connect-src 'self' ws: wss:",
          "object-src 'none'",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; '),
      );
    }
    if (REAL_MONEY_ENABLED) {
      // Defence in depth: real money is off by policy; refuse all traffic if it
      // was ever enabled without the compliance attestation passing at boot.
      app.log.warn('REAL_MONEY_ENABLED is true — this deployment must be operating under a valid licence.');
    }
    csrfGuard(request);
  });

  app.addHook('onResponse', async (request, reply) => {
    if (request.url.startsWith('/api/auth/') && request.method === 'POST') {
      reply.header('cache-control', 'no-store');
    }
  });

  /* -------------------------------- errors -------------------------------- */

  app.setErrorHandler((error: any, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    if (error instanceof AppError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, requestId }, ...(error.details ? { details: error.details } : {}) });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_FAILED', message: 'The request could not be validated.', requestId },
        details: error.issues.slice(0, 6).map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    if (error?.validationContext) {
      return reply.code(400).send({ error: { code: 'VALIDATION_FAILED', message: 'The request could not be validated.', requestId } });
    }
    if (error?.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply.code(415).send({ error: { code: 'VALIDATION_FAILED', message: 'Unsupported content type.', requestId } });
    }
    if (error?.statusCode === 413) {
      return reply.code(413).send({ error: { code: 'VALIDATION_FAILED', message: 'Request too large.', requestId } });
    }
    if (error?.code === 'ROUTE_NOT_FOUND' || error?.statusCode === 404) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'That endpoint does not exist.', requestId } });
    }

    // Anything else is a bug: log it fully, tell the user something friendly.
    logger.error('Unhandled error', { err: error?.stack ?? String(error), url: request.url, method: request.method, requestId });
    return reply.code(500).send({
      error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.', requestId },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/ws/')) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'That endpoint does not exist.', requestId: request.id } });
    }
    // SPA fallback for client-side routing when the web build is served here.
    const index = path.join(options.staticDir ?? '', 'index.html');
    if (options.staticDir && fs.existsSync(index)) {
      return reply.type('text/html').send(fs.createReadStream(index));
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Open the web client to play.' } });
  });

  /* -------------------------------- routes -------------------------------- */

  app.get('/api/ping', async () => ({ pong: Date.now(), db: getDb().scalar<number>('SELECT COUNT(*) FROM users') ?? 0 }));

  registerPublicRoutes(app, () => options.rounds);
  registerAuthRoutes(app);
  registerAccountRoutes(app, () => options.rounds);
  registerGameRoutes(app, () => options.rounds);
  registerAdminRoutes(app, () => options.rounds);
  registerGameSocket(app, () => options.rounds);

  /* ------------------------------ static SPA ------------------------------ */

  const staticDir = options.staticDir ?? path.resolve(process.cwd(), '../../packages/web/dist');
  if (fs.existsSync(path.join(staticDir, 'index.html'))) {
    await app.register(staticFiles, { root: staticDir, prefix: '/', index: ['index.html'], wildcard: false });
    app.log.info(`Serving web client from ${staticDir}`);
  } else if (e.isProduction) {
    app.log.warn('No web build found. Run `npm run build` before starting in production.');
  }

  return app;
}
