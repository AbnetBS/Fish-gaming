type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = ORDER.info;

export function setLogLevel(level: string): void {
  threshold = ORDER[(level as Level) in ORDER ? (level as Level) : 'info'];
}

function emit(level: Level, msg: string, meta?: unknown): void {
  if (ORDER[level] < threshold) return;
  const line = { ts: new Date().toISOString(), level, msg, ...(meta !== undefined ? { meta } : {}) };
  const text = JSON.stringify(line);
  if (level === 'error') process.stderr.write(`${text}\n`);
  else process.stdout.write(`${text}\n`);
}

export interface Logger {
  debug: (msg: string, meta?: unknown) => void;
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
  error: (msg: string, meta?: unknown) => void;
  child: (bindings: Record<string, unknown>) => Logger;
}

function make(bindings: Record<string, unknown> = {}): Logger {
  const wrap =
    (level: Level) =>
    (msg: string, meta?: unknown): void =>
      emit(level, msg, Object.keys(bindings).length ? { ...bindings, ...(meta as object) } : meta);
  return {
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
    child: (b) => make({ ...bindings, ...b }),
  };
}

export const logger: Logger = make();

/** Strips anything that must never reach a client (or a log aggregator). */
export const REDACT_KEYS = new Set([
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'jwtSecret',
]);

export function redact<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.has(k) ? '[redacted]' : redact(v);
  }
  return out as T;
}
