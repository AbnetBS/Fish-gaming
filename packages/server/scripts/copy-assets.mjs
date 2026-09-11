/**
 * Copies non-TypeScript assets from `src/` into `dist/`, preserving the
 * directory structure.
 *
 * `tsc` only emits `.js`/`.d.ts`/`.map` files, but the server reads
 * `db/schema.sql` relative to its own compiled location
 * (`path.resolve(__dirname, 'schema.sql')`). Without this step a production
 * build boots against a fresh database and dies with ENOENT.
 *
 * Runs after every `npm run build -w @reef/server`.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const srcDir = path.resolve(process.cwd(), 'src');
const outDir = path.resolve(process.cwd(), 'dist');

/** Extensions owned by the compiler — never copied verbatim. */
const compiled = new Set(['.ts', '.tsx', '.js', '.map', '.d.ts', '.mts', '.cts']);

function isAsset(file) {
  const base = path.basename(file);
  if (base.startsWith('.')) return false; // dotfiles/vim swapfiles
  return ![...compiled].some((ext) => base.endsWith(ext));
}

function walk(dir, copied) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, copied);
      continue;
    }
    if (!isAsset(abs)) continue;
    const dest = path.join(outDir, path.relative(srcDir, abs));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
    copied.push(path.relative(process.cwd(), dest));
  }
}

if (!fs.existsSync(outDir)) {
  console.error('[copy-assets] dist/ is missing — run tsc first.');
  process.exit(1);
}

const copied = [];
walk(srcDir, copied);
for (const file of copied) console.log(`[copy-assets] ${file}`);
if (copied.length === 0) console.log('[copy-assets] no assets to copy');
