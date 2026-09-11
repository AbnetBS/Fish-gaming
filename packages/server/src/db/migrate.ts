import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * `schema.sql` sits next to this file in `src/`, and next to the compiled
 * module in `dist/` (copied by `scripts/copy-assets.mjs`). Check both so the
 * server boots identically under `tsx` and under `node dist/index.js`.
 */
const SCHEMA_CANDIDATES = [
  path.resolve(__dirname, 'schema.sql'),
  path.resolve(__dirname, '../../src/db/schema.sql'),
];

export function resolveSchemaPath(): string {
  const found = SCHEMA_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      `db/schema.sql not found (looked in: ${SCHEMA_CANDIDATES.join(', ')}). ` +
        'Run `npm run build -w @reef/server` to copy assets into dist/.',
    );
  }
  return found;
}

/** Applies `schema.sql` idempotently (every statement uses IF NOT EXISTS). */
export function migrate(db: Database): void {
  const sql = fs.readFileSync(resolveSchemaPath(), 'utf8');
  db.exec(sql);
  db.exec(
    `INSERT INTO system_settings (key, value, description, updated_at)
     VALUES ('schema_version', '1', 'Relational schema revision', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO NOTHING;`,
  );
}

export function readSchemaSql(): string {
  return fs.readFileSync(resolveSchemaPath(), 'utf8');
}
