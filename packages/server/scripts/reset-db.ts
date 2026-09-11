import path from 'node:path';
import fs from 'node:fs';
import { loadEnv, env } from '../src/config/env.js';

/**
 * Delete the SQLite database files so the next boot re-creates and re-seeds
 * a clean platform. Refuses to run in production.
 */
loadEnv();
const e = env();
if (e.isProduction) {
  console.error('db:reset is disabled when NODE_ENV=production.');
  process.exit(1);
}

const file = path.isAbsolute(e.dbFile) ? e.dbFile : path.resolve(process.cwd(), e.dbFile);
let removed = 0;
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  const target = `${file}${suffix}`;
  if (fs.existsSync(target)) {
    fs.rmSync(target);
    removed += 1;
  }
}
console.log(`Removed ${removed} database file(s) for ${file}`);
