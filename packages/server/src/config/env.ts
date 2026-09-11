import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal, dependency-free `.env` loader. Values already present in
 * `process.env` always win, so container/orchestrator configuration overrides
 * the file.
 */
function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function int(v: string | undefined, fallback: number): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

// Load .env from the repository root (walk upwards until found).
(function discoverEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) {
      loadEnvFile(candidate);
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
})();

export interface Env {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  host: string;
  publicUrl: string;
  corsOrigins: string[];
  dbFile: string;
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  accessTokenTtlS: number;
  refreshTokenTtlS: number;
  cookieDomain: string;
  cookieSecure: boolean;
  /** `lax` for same-origin hosting, `none` when the client lives on another origin (Vercel, CDN, ...). */
  cookieSameSite: 'lax' | 'none';
  startingDemoCoins: number;
  simTickMs: number;
  snapshotMs: number;
  roundDurationS: number;
  logLevel: string;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  bootstrapAdmin: { email: string; username: string; password: string };
}

function parseSameSite(raw: string | undefined): 'lax' | 'none' {
  return raw?.trim().toLowerCase() === 'none' ? 'none' : 'lax';
}

function parseOrigins(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  const list = raw
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return list.length ? list : fallback;
}

export function loadEnv(overrides: Partial<Record<string, string>> = {}): Env {
  const get = (k: string, d = '') => overrides[k] ?? process.env[k] ?? d;
  const nodeEnv = get('NODE_ENV', 'development');
  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    port: int(get('PORT'), 3000),
    host: get('HOST', '0.0.0.0'),
    publicUrl: get('PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, ''),
    corsOrigins: parseOrigins(get('CORS_ORIGINS'), ['http://localhost:5173', 'http://127.0.0.1:5173']),
    dbFile: get('DB_FILE', './data/reef-raiders.db'),
    jwtSecret: get('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
    jwtIssuer: get('JWT_ISSUER', 'reef-raiders'),
    jwtAudience: get('JWT_AUDIENCE', 'reef-raiders-web'),
    accessTokenTtlS: int(get('ACCESS_TOKEN_TTL'), 900),
    refreshTokenTtlS: int(get('REFRESH_TOKEN_TTL'), 2_592_000),
    cookieDomain: get('COOKIE_DOMAIN', ''),
    cookieSecure: bool(get('COOKIE_SECURE'), false),
    cookieSameSite: parseSameSite(get('COOKIE_SAMESITE')),
    startingDemoCoins: int(get('STARTING_DEMO_COINS'), 10_000),
    simTickMs: int(get('SIM_TICK_MS'), 50),
    snapshotMs: int(get('SNAPSHOT_MS'), 50),
    roundDurationS: int(get('ROUND_DURATION_S'), 1800),
    logLevel: get('LOG_LEVEL', 'info'),
    rateLimitMax: int(get('RATE_LIMIT_MAX'), 300),
    rateLimitWindowMs: int(get('RATE_LIMIT_WINDOW_MS'), 60_000),
    bootstrapAdmin: {
      email: get('BOOTSTRAP_ADMIN_EMAIL', 'admin@reefraiders.local'),
      username: get('BOOTSTRAP_ADMIN_USERNAME', 'admin'),
      password: get('BOOTSTRAP_ADMIN_PASSWORD', 'ChangeMe!2345'),
    },
  };
}

let cached: Env | null = null;

export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

export function setEnv(e: Env): void {
  cached = e;
}
