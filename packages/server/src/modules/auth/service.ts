import bcrypt from 'bcryptjs';
import type { Database } from '../../db/index.js';
import { AppError, badRequest, unauthorized } from '../../lib/errors.js';
import { randomToken, sha256, uid } from '../../lib/ids.js';
import { env } from '../../config/env.js';
import { verifyPassword } from '../../security/passwords.js';
import { signAccessToken } from '../../security/tokens.js';
import { ensureWallet } from '../wallet/ledger.js';
import {
  findUserByEmail,
  findUserById,
  getProfile,
  toProfileDto,
  toPublicUser,
  touchLastActive,
  type UserRow,
} from '../users/service.js';
import { logger } from '../../lib/logger.js';

/**
 * Authentication.
 *
 *  * bcrypt verification with per-account lockout
 *  * short-lived JWT access token — role & status are re-read from the DB on
 *    every request, so a revoked account stops working immediately
 *  * opaque, rotated refresh token, stored only as a SHA-256 hash
 *  * no user enumeration: identical error text and comparable timing for
 *    unknown emails
 */

export const MAX_FAILED_LOGINS = 8;
export const LOCKOUT_MINUTES = 15;
const BCRYPT_COST = 12;

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
  /** Session row id (the access token's `sid`) — used for rotation bookkeeping. */
  sid?: string;
}

export interface LoginContext {
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuthResult {
  user: ReturnType<typeof toPublicUser>;
  profile: ReturnType<typeof toProfileDto>;
  tokens: SessionTokens;
}

interface UserRowFull extends UserRow {
  locked_until: string | null;
  failed_login_count: number;
}

function isLocked(row: { locked_until?: string | null }): boolean {
  if (!row.locked_until) return false;
  return new Date(row.locked_until).getTime() > Date.now();
}

function noteAttempt(db: Database, email: string, ip: string | null | undefined, success: boolean, reason?: string): void {
  db.run(
    'INSERT INTO login_attempts (id, email, ip_address, success, reason, created_at) VALUES (?,?,?,?,?,?)',
    uid('att'),
    (email || '').toLowerCase(),
    ip ?? null,
    success ? 1 : 0,
    reason ?? null,
    new Date().toISOString(),
  );
}

export async function login(db: Database, identifier: string, password: string, ctx: LoginContext = {}): Promise<AuthResult> {
  const row = db.get<UserRowFull>('SELECT * FROM users WHERE lower(email) = lower(?)', identifier);

  // A real bcrypt comparison runs even for unknown accounts so that response
  // timing does not reveal whether an email is registered.
  const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO7ZBVb0Jb0FYuBvXQbQAqLgqMWqJxGmO';
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);

  if (!row || !ok) {
    noteAttempt(db, identifier, ctx.ip, false, row ? 'bad_password' : 'unknown_account');
    if (row) {
      const fails = (row.failed_login_count ?? 0) + 1;
      const lockedUntil = fails >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString() : null;
      db.run('UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?', fails, lockedUntil, row.id);
    }
    throw unauthorized('Email or password is incorrect.');
  }

  if (isLocked(row)) {
    noteAttempt(db, identifier, ctx.ip, false, 'locked');
    throw new AppError(429, 'RATE_LIMITED', 'Too many failed attempts. Please try again in a few minutes.');
  }
  if (row.status === 'SUSPENDED') {
    noteAttempt(db, identifier, ctx.ip, false, 'suspended');
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended. Please contact support.');
  }
  if (row.status === 'CLOSED') throw new AppError(403, 'FORBIDDEN', 'This account has been closed.');

  db.run('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?', row.id);
  noteAttempt(db, identifier, ctx.ip, true);
  touchLastActive(db, row.id);
  // Older installs may pre-date the wallet table — make sure one exists.
  ensureWallet(db, row.id, 0);

  const tokens = await issueSession(db, row.id, ctx);
  const fresh = findUserById(db, row.id)!;
  return { user: toPublicUser(fresh), profile: toProfileDto(getProfile(db, row.id)), tokens };
}

export async function issueSession(db: Database, userId: string, ctx: LoginContext): Promise<SessionTokens> {
  const e = env();
  const sessionId = uid('ses');
  const accessToken = await signAccessToken(userId, sessionId);
  const refreshToken = randomToken(48);
  const expiresAt = new Date(Date.now() + e.refreshTokenTtlS * 1000).toISOString();
  db.run(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, user_agent, ip_address, expires_at, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    sessionId,
    userId,
    sha256(refreshToken),
    truncate(ctx.userAgent ?? null, 240),
    ctx.ip ?? null,
    expiresAt,
    new Date().toISOString(),
  );
  return { accessToken, refreshToken, accessExpiresIn: e.accessTokenTtlS, sid: sessionId };
}

export interface RefreshResult {
  userId: string;
  tokens: SessionTokens;
}

export async function refresh(db: Database, refreshToken: string, ctx: LoginContext): Promise<RefreshResult> {
  const hash = sha256(refreshToken);
  const row = db.get<any>('SELECT * FROM refresh_tokens WHERE token_hash = ?', hash);
  if (!row) throw unauthorized('Session expired. Please sign in again.');

  if (row.revoked_at) {
    // Re-use of an already-rotated token is a theft indicator: revoke the set.
    logger.warn('Refresh token reuse detected', { userId: row.user_id });
    db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', new Date().toISOString(), row.user_id);
    throw unauthorized('Session expired. Please sign in again.');
  }
  if (new Date(row.expires_at).getTime() < Date.now()) throw unauthorized('Session expired. Please sign in again.');

  const user = findUserById(db, row.user_id);
  if (!user) throw unauthorized('Session expired. Please sign in again.');
  if (user.status === 'SUSPENDED') throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');

  const tokens = await issueSession(db, row.user_id, ctx);
  // Rotation: the presented token is consumed and linked to its replacement, so
  // a stolen copy is detected on reuse.
  db.run('UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ?', new Date().toISOString(), tokens.sid ?? null, row.id);
  return { userId: row.user_id, tokens };
}

export function logout(db: Database, refreshToken: string | undefined): void {
  if (!refreshToken) return;
  db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', new Date().toISOString(), sha256(refreshToken));
}

export function revokeAllSessions(db: Database, userId: string, exceptSessionId?: string | null): void {
  const timestamp = new Date().toISOString();
  if (exceptSessionId) {
    db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?', timestamp, userId, exceptSessionId);
    return;
  }
  db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', timestamp, userId);
}

export interface SessionInfo {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

export function activeSessions(db: Database, userId: string): SessionInfo[] {
  return db
    .all<{ id: string; ip_address: string | null; user_agent: string | null; created_at: string; expires_at: string }>(
      `SELECT id, ip_address, user_agent, created_at, expires_at FROM refresh_tokens
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
       ORDER BY created_at DESC`,
      userId,
    )
    .map((r) => ({
      id: r.id,
      ip: r.ip_address,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }));
}

/* ------------------------- password reset / email verification ------------------------- */

/**
 * Returns the token only for an existing account; the route always answers the
 * same way so the endpoint cannot be used to enumerate emails. In development
 * the token is surfaced in the response because there is no mail transport.
 */
export function createPasswordResetToken(db: Database, email: string): string | null {
  const user = findUserByEmail(db, email);
  if (!user) return null;
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  db.run('UPDATE users SET password_reset_token = ?, password_reset_expiry = ? WHERE id = ?', sha256(token), expiresAt, user.id);
  return token;
}

export function resetPasswordWithToken(db: Database, token: string, newPassword: string): void {
  if (!newPassword || newPassword.length < 8) throw badRequest('Password must be at least 8 characters.');
  if (newPassword.length > 200) throw badRequest('Password is too long.');
  const user = db.get<any>('SELECT * FROM users WHERE password_reset_token = ?', sha256(token));
  if (!user) throw badRequest('That reset link is not valid.');
  if (!user.password_reset_expiry || new Date(user.password_reset_expiry).getTime() < Date.now()) {
    throw badRequest('That reset link has expired. Please request a new one.');
  }
  const timestamp = new Date().toISOString();
  db.run(
    `UPDATE users SET password_hash = ?, password_reset_token = NULL, password_reset_expiry = NULL,
                      password_changed_at = ?, updated_at = ?, failed_login_count = 0, locked_until = NULL WHERE id = ?`,
    bcrypt.hashSync(newPassword, BCRYPT_COST),
    timestamp,
    timestamp,
    user.id,
  );
  revokeAllSessions(db, user.id);
}

export function createEmailVerificationToken(db: Database, userId: string): string {
  const token = randomToken(24);
  db.run(
    `INSERT INTO email_verifications (id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)`,
    uid('evr'),
    userId,
    sha256(token),
    new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    new Date().toISOString(),
  );
  return token;
}

export function verifyEmailToken(db: Database, token: string): boolean {
  const row = db.get<any>('SELECT * FROM email_verifications WHERE token_hash = ? AND used_at IS NULL', sha256(token));
  if (!row) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  db.run('UPDATE email_verifications SET used_at = ? WHERE id = ?', new Date().toISOString(), row.id);
  db.run(
    'UPDATE users SET email_verified = 1, status = ? WHERE id = ? AND status = ?',
    'ACTIVE',
    row.user_id,
    'PENDING_VERIFICATION',
  );
  return true;
}

function truncate(s: string | null, n: number): string | null {
  if (!s) return null;
  return s.slice(0, n);
}
