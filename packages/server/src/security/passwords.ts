import bcrypt from 'bcryptjs';
import { sha256, timingSafeEqualStr } from '../lib/ids.js';

/**
 * Password handling.
 *
 * bcrypt (cost 12) is used because it is deliberately slow and has a long,
 * well-understood security history. Hashes are never returned by any API and
 * are never written to logs.
 */
const BCRYPT_COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/** Constant-time compare for opaque tokens (we store SHA-256 of the token). */
export function hashToken(token: string): string {
  return sha256(token);
}

export function compareToken(plain: string, storedHash: string): boolean {
  return timingSafeEqualStr(sha256(plain), storedHash);
}

export interface PasswordPolicyResult {
  ok: boolean;
  errors: string[];
}

export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  const errors: string[] = [];
  if (password.length < 8) errors.push('Password must be at least 8 characters.');
  if (password.length > 200) errors.push('Password must be at most 200 characters.');
  if (!/[a-zA-Z]/.test(password)) errors.push('Password must contain a letter.');
  if (!/[0-9]/.test(password)) errors.push('Password must contain a number.');
  return { ok: errors.length === 0, errors };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

export function isValidUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}
