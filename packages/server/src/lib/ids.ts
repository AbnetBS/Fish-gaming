import crypto from 'node:crypto';

/**
 * Id generation.
 *
 * `uid()` produces a sortable, url-safe id (timestamp prefix + random).
 * Round ids are human-readable and sequential per year: `RND-2026-000123`.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomChars(n: number): string {
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i += 1) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

export function uid(prefix = ''): string {
  const t = Date.now().toString(36).padStart(9, '0');
  const id = `${t}${randomChars(10)}`;
  return prefix ? `${prefix}_${id}` : id;
}

export function newRoundId(sequence: number, year = new Date().getUTCFullYear()): string {
  return `RND-${year}-${String(sequence).padStart(6, '0')}`;
}

export function newTransactionRef(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomChars(6).toUpperCase()}`;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
