import bcrypt from 'bcryptjs';
import type { Database } from '../../db/index.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { uid } from '../../lib/ids.js';
import { hashPassword, isValidEmail, isValidUsername, verifyPassword } from '../../security/passwords.js';
import type { AccountStatus, AdminUserRow, PublicUser, Role } from '@reef/shared';
import { ADMIN_ROLES } from '@reef/shared';

const BCRYPT_COST = 12;

/**
 * Users + profiles. Password hashes are filtered out here, at the boundary
 * between the database and any serialisable object, so they cannot leak through
 * a route that forgets to strip them.
 */

export interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  role: Role;
  status: AccountStatus;
  avatar_seed: string;
  email_verified: number;
  created_at: string;
  last_active_at: string | null;
  updated_at: string;
}

export interface ProfileRow {
  user_id: string;
  display_name: string | null;
  country: string | null;
  birth_date: string | null;
  bio: string | null;
  avatar_url: string | null;
  language: string;
  two_factor_enabled: number;
  login_notify: number;
  deposit_limit: number | null;
  loss_limit: number | null;
  session_limit_min: number | null;
  self_excluded_until: string | null;
}

export interface ProfileDto {
  displayName: string | null;
  country: string | null;
  birthDate: string | null;
  bio: string | null;
  avatarUrl: string | null;
  language: string;
  twoFactorEnabled: boolean;
  loginNotify: boolean;
  depositLimit: number | null;
  lossLimit: number | null;
  sessionLimitMin: number | null;
  selfExcludedUntil: string | null;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    status: row.status,
    avatarSeed: row.avatar_seed,
    emailVerified: row.email_verified === 1,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

export function toProfileDto(row: ProfileRow | undefined): ProfileDto {
  return {
    displayName: row?.display_name ?? null,
    country: row?.country ?? null,
    birthDate: row?.birth_date ?? null,
    bio: row?.bio ?? null,
    avatarUrl: row?.avatar_url ?? null,
    language: row?.language ?? 'en',
    twoFactorEnabled: row?.two_factor_enabled === 1,
    loginNotify: row?.login_notify === 1,
    depositLimit: row?.deposit_limit ?? null,
    lossLimit: row?.loss_limit ?? null,
    sessionLimitMin: row?.session_limit_min ?? null,
    selfExcludedUntil: row?.self_excluded_until ?? null,
  };
}

export function findUserById(db: Database, id: string): UserRow | undefined {
  return db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
}

export function findUserByEmail(db: Database, email: string): UserRow | undefined {
  return db.get<UserRow>('SELECT * FROM users WHERE lower(email) = lower(?)', email);
}

export function findUserByUsername(db: Database, username: string): UserRow | undefined {
  return db.get<UserRow>('SELECT * FROM users WHERE lower(username) = lower(?)', username);
}

export function getProfile(db: Database, userId: string): ProfileRow | undefined {
  return db.get<ProfileRow>('SELECT * FROM profiles WHERE user_id = ?', userId);
}

/** Older/partial rows may lack a profile record; create it on first use. */
export function ensureUserProfile(db: Database, userId: string): void {
  db.run(
    `INSERT INTO profiles (user_id, language, updated_at) VALUES (?, 'en', ?)
     ON CONFLICT(user_id) DO NOTHING`,
    userId,
    new Date().toISOString(),
  );
}

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  acceptTerms: boolean;
}

export interface CreateUserResult {
  user: PublicUser;
  profile: ProfileDto;
  walletId: string;
}

export function createUser(db: Database, input: RegisterInput): CreateUserResult {
  const username = input.username.trim();
  const email = input.email.trim().toLowerCase();

  if (!isValidUsername(username)) {
    throw badRequest('Username must be 3-24 characters using letters, numbers or underscore.');
  }
  if (!isValidEmail(email)) throw badRequest('Please enter a valid email address.');
  if (!input.acceptTerms) throw badRequest('You must confirm you understand this is a demo-currency product.');
  if (findUserByEmail(db, email)) throw conflict('An account with that email already exists.');
  if (findUserByUsername(db, username)) throw conflict('That username is already taken.');

  const timestamp = new Date().toISOString();
  const id = uid('usr');
  const passwordHash = bcrypt.hashSync(input.password, BCRYPT_COST);

  return db.transaction(() => {
    db.run(
      `INSERT INTO users (id, username, email, password_hash, role, status, avatar_seed, email_verified,
                          created_at, updated_at, last_active_at)
       VALUES (?,?,?,?, 'USER', 'ACTIVE', ?, 0, ?, ?, NULL)`,
      id,
      username,
      email,
      passwordHash,
      username,
      timestamp,
      timestamp,
    );
    db.run(`INSERT INTO profiles (user_id, display_name, language, updated_at) VALUES (?,?,?,?)`, id, username, 'en', timestamp);

    const walletId = uid('wlt');
    db.run(
      `INSERT INTO wallets (id, user_id, balance, currency, version, created_at, updated_at) VALUES (?,?,?,?,0,?,?)`,
      walletId,
      id,
      0,
      'DEMO',
      timestamp,
      timestamp,
    );
    return {
      user: toPublicUser(db.get<UserRow>('SELECT * FROM users WHERE id = ?', id)!),
      profile: toProfileDto(getProfile(db, id)),
      walletId,
    };
  });
}

export async function changePassword(
  db: Database,
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepSessionId?: string | null,
): Promise<void> {
  const row = findUserById(db, userId);
  if (!row) throw notFound('Account not found.');
  const ok = await verifyPassword(currentPassword, row.password_hash);
  if (!ok) throw new AppError(403, 'FORBIDDEN', 'Current password is incorrect.');
  if (currentPassword === newPassword) throw badRequest('New password must differ from the current one.');
  const hash = await hashPassword(newPassword);
  const timestamp = new Date().toISOString();
  db.run(
    `UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?`,
    hash,
    timestamp,
    timestamp,
    userId,
  );
  // Force re-authentication on every *other* device.
  db.run(
    `UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?`,
    timestamp,
    userId,
    keepSessionId ?? null,
  );
}

export function updateProfile(
  db: Database,
  userId: string,
  patch: Partial<{
    displayName: string | null;
    country: string | null;
    bio: string | null;
    language: string;
    loginNotify: boolean;
    sessionLimitMin: number | null;
  }>,
): ProfileDto {
  const existing = getProfile(db, userId);
  if (!existing) throw notFound('Profile not found.');
  const timestamp = new Date().toISOString();
  const assignments: string[] = [];
  const args: unknown[] = [];
  const map: Record<string, [string, unknown]> = {
    displayName: ['display_name', patch.displayName ?? existing.display_name],
    country: ['country', patch.country ?? existing.country],
    bio: ['bio', patch.bio ?? existing.bio],
    language: ['language', patch.language ?? existing.language],
    loginNotify: ['login_notify', patch.loginNotify === undefined ? existing.login_notify : patch.loginNotify ? 1 : 0],
    sessionLimitMin: ['session_limit_min', patch.sessionLimitMin === undefined ? existing.session_limit_min : patch.sessionLimitMin],
  };
  for (const key of Object.keys(patch)) {
    const entry = map[key];
    if (!entry) continue;
    assignments.push(`${entry[0]} = ?`);
    args.push(entry[1]);
  }
  if (assignments.length) {
    db.run(`UPDATE profiles SET ${assignments.join(', ')}, updated_at = ? WHERE user_id = ?`, ...args, timestamp, userId);
  }
  return toProfileDto(getProfile(db, userId));
}

export function touchLastActive(db: Database, userId: string): void {
  db.run('UPDATE users SET last_active_at = ? WHERE id = ?', new Date().toISOString(), userId);
}

export function setEmailVerified(db: Database, userId: string): void {
  db.run('UPDATE users SET email_verified = 1, status = ?, updated_at = ? WHERE id = ? AND status = ?', 'ACTIVE', new Date().toISOString(), userId, 'PENDING_VERIFICATION');
}

export interface ListUsersParams {
  search?: string;
  status?: AccountStatus;
  limit?: number;
  offset?: number;
}

export function listUsers(
  db: Database,
  params: ListUsersParams,
): { items: AdminUserRow[]; total: number } {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const offset = Math.max(params.offset ?? 0, 0);
  const where: string[] = [];
  const args: unknown[] = [];
  if (params.search) {
    where.push('(username LIKE ? ESCAPE \'\\\' OR email LIKE ? ESCAPE \'\\\')');
    const like = `%${escapeLike(params.search)}%`;
    args.push(like, like);
  }
  if (params.status) {
    where.push('status = ?');
    args.push(params.status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.scalar<number>(`SELECT COUNT(*) FROM users ${clause}`, ...args) ?? 0;
  const items = db
    .all<any>(
      `SELECT u.*, a.admin_role FROM users u LEFT JOIN admin_accounts a ON a.user_id = u.id
       ${clause} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      ...args,
      limit,
      offset,
    )
    .map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email,
      role: r.role,
      status: r.status,
      avatarSeed: r.avatar_seed,
      emailVerified: r.email_verified === 1,
      createdAt: r.created_at,
      lastActiveAt: r.last_active_at,
      adminRole: (r.admin_role ?? r.role) as Role,
    }));
  return { items, total };
}

export function setAccountStatus(db: Database, userId: string, status: AccountStatus): PublicUser {
  const row = findUserById(db, userId);
  if (!row) throw notFound('Account not found.');
  if (row.role !== 'USER' && status === 'SUSPENDED' && !ADMIN_ROLES.includes(row.role as any)) {
    throw badRequest('That account cannot be suspended.');
  }
  db.run('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', status, new Date().toISOString(), userId);
  if (status === 'SUSPENDED') {
    db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', new Date().toISOString(), userId);
  }
  return toPublicUser(findUserById(db, userId)!);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
