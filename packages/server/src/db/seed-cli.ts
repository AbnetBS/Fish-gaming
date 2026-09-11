import path from 'node:path';
import { loadEnv, env } from '../config/env.js';
import { initDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { seed } from '../db/seed.js';
import { logger } from '../lib/logger.js';

/** `npm run db:seed` — create/migrate the database and insert baseline config. */
loadEnv();
const e = env();
const file = path.isAbsolute(e.dbFile) ? e.dbFile : path.resolve(process.cwd(), e.dbFile);
const db = initDb(file);
migrate(db);
const force = process.argv.includes('--force');
const result = await seed(db, { force });
logger.info('Seed complete', { ...result, force });
if (result.adminEmail) {
  process.stdout.write(
    `\nBootstrap admin: ${result.adminEmail} / ${e.bootstrapAdmin.password}  (change this immediately)\n\n`,
  );
}
db.close();
