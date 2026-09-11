import path from 'node:path';
import fs from 'node:fs';
import { env, loadEnv } from './config/env.js';
import { assertRealMoneyPolicySafe, REAL_MONEY_ENABLED } from './config/flags.js';
import { initDb, getDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { logger, setLogLevel } from './lib/logger.js';
import { buildApp } from './http/app.js';
import { RoundManager } from './sim/round-manager.js';
import { shutdownSockets } from './ws/game-socket.js';
import { writeSettings } from './modules/config/service.js';

/**
 * Process entry point.
 *
 * Order matters: policy assertion -> database -> migrations -> baseline seed
 * -> simulation -> HTTP. The server refuses to boot in an unsafe configuration
 * rather than starting and failing later.
 */
export async function bootstrap(): Promise<{ close: () => Promise<void>; app: ReturnType<typeof buildApp> extends Promise<infer T> ? T : never }> {
  const e = env();
  setLogLevel(e.logLevel);

  assertRealMoneyPolicySafe();

  const dbFile = path.isAbsolute(e.dbFile) ? e.dbFile : path.resolve(process.cwd(), e.dbFile);
  if (dbFile !== ':memory:') fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = initDb(dbFile);
  migrate(db);
  const seeded = await seed(db);
  writeSettings(db, { roundDurationS: e.roundDurationS });

  if (seeded.adminEmail) {
    logger.info('Bootstrap administrator created', { email: seeded.adminEmail, note: 'Change this password immediately.' });
  }
  logger.info('Database ready', { file: dbFile, users: seeded.users, fish: seeded.fish, cannons: seeded.cannons, rooms: seeded.rooms, config: seeded.configVersion });

  const rounds = new RoundManager({
    db,
    tickMs: e.simTickMs,
    snapshotMs: e.snapshotMs,
    roundDurationS: e.roundDurationS,
  });
  rounds.start();

  const app = await buildApp({ rounds, staticDir: resolveStaticDir() });

  await app.listen({ port: e.port, host: e.host });
  logger.info('Reef Raiders API listening', {
    listen: `${e.host}:${e.port}`,
    local: `http://${e.host === '0.0.0.0' ? 'localhost' : e.host}:${e.port}`,
    publicUrl: e.publicUrl,
    realMoneyEnabled: REAL_MONEY_ENABLED,
    currency: 'DEMO COINS',
    node: process.version,
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down`);
    shutdownSockets('The server is restarting. Please reconnect.');
    rounds.stop();
    await app.close();
    db.close();
  };

  let closing = false;
  const onSignal = (signal: string) => {
    if (closing) return;
    closing = true;
    shutdown(signal).then(
      () => process.exit(0),
      (err) => {
        logger.error('Shutdown error', { err: String(err) });
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection', { reason: String(reason) }));
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { err: err instanceof Error ? err.stack : String(err) });
    onSignal('uncaughtException');
  });

  return { close: () => shutdown('close()'), app };
}

function resolveStaticDir(): string | undefined {
  const candidates = [
    process.env.WEB_DIST,
    path.resolve(process.cwd(), '../../packages/web/dist'),
    path.resolve(process.cwd(), 'packages/web/dist'),
    path.resolve(import.meta.dirname ?? '.', '../../web/dist'),
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return undefined;
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isDirectRun) {
  loadEnv();
  bootstrap().catch((err) => {
    logger.error('Boot failed', { err: err instanceof Error ? err.stack ?? err.message : String(err) });
    process.exitCode = 1;
  });
}

export { getDb };
export { loadEnv, env, setEnv } from './config/env.js';
export { initDb, setDb, Database } from './db/index.js';
export { migrate } from './db/migrate.js';
export { seed } from './db/seed.js';
export { buildApp } from './http/app.js';
export { RoundManager } from './sim/round-manager.js';
export type { Env } from './config/env.js';
