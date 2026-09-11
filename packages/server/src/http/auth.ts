import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/index.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from '../security/tokens.js';
import { getProfile, toProfileDto, toPublicUser, type UserRow } from '../modules/users/service.js';
import type { Permission, PublicUser } from '@reef/shared';
import { permissionsForRole } from '@reef/shared';

/**
 * Request authentication + authorisation.
 *
 * Order of precedence:
 *   1. `Authorization: Bearer <jwt>` (used by the SPA and the WebSocket)
 *   2. `rr_at` httpOnly cookie (used for silent session restore / refresh)
 *
 * The JWT only carries the subject. The role, status and capability set are
 * read from the database on every request, so "never trust roles supplied by
 * the browser" holds literally: the browser never supplies a role at all.
 */

export interface AuthedUser {
  sid?: string;
  id: string;
  username: string;
  email: string;
  role: PublicUser['role'];
  permissions: Permission[];
  row: UserRow;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser;
    sessionId?: string;
  }
}

export const ACCESS_COOKIE = 'rr_at';
export const REFRESH_COOKIE = 'rr_rt';
export const CSRF_COOKIE = 'rr_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export function readBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    const token = header.slice(7).trim();
    if (token.length > 20) return token;
  }
  return null;
}

export function readAccessToken(request: FastifyRequest): string | null {
  const bearer = readBearer(request);
  if (bearer) return bearer;
  const cookies = (request as any).cookies as Record<string, string> | undefined;
  return cookies?.[ACCESS_COOKIE] ?? null;
}

export function readRefreshToken(request: FastifyRequest): string | null {
  const cookies = (request as any).cookies as Record<string, string> | undefined;
  if (cookies?.[REFRESH_COOKIE]) return cookies[REFRESH_COOKIE];
  const body = request.body as { refreshToken?: unknown } | undefined;
  const fromBody = body?.refreshToken;
  return typeof fromBody === 'string' && fromBody.length > 20 ? fromBody : null;
}

/** Resolve the caller, or `undefined`. Never throws. */
export function resolveUser(request: FastifyRequest): AuthedUser | undefined {
  if (request.user) return request.user;
  const token = readAccessToken(request);
  if (!token) return undefined;
  let userId: string;
  let sessionId: string;
  try {
    const claims = verifyAccessToken(token);
    userId = claims.sub;
    sessionId = claims.sid;
  } catch {
    return undefined;
  }
  const db = getDb();
  const row = db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
  if (!row) return undefined;
  if (row.status === 'SUSPENDED' || row.status === 'CLOSED') return undefined;
  // Server-side revocation: the token's `sid` is tied to a session row, so
  // logging out (or an admin killing the session) invalidates an access token
  // immediately instead of waiting for it to expire.
  const session = db.get<{ revoked_at: string | null }>('SELECT revoked_at FROM refresh_tokens WHERE id = ?', sessionId);
  if (!session || session.revoked_at) return undefined;
  const user: AuthedUser = {
    sid: sessionId,
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    permissions: permissionsForRole(row.role),
    row,
  };
  request.user = user;
  request.sessionId = sessionId;
  return user;
}

export function requireAuth(request: FastifyRequest): AuthedUser {
  const user = resolveUser(request);
  if (!user) throw unauthorized('Please sign in to continue.');
  return user;
}

export function requirePermission(request: FastifyRequest, permission: Permission): AuthedUser {
  const user = requireAuth(request);
  if (!user.permissions.includes(permission)) {
    throw forbidden('Your account does not have access to that area.');
  }
  return user;
}

/** Attaches an admin-capable user or throws. Used by every /api/admin route. */
export function requireAdmin(request: FastifyRequest, permission: Permission): AuthedUser & { adminId: string; adminUsername: string } {
  const user = requirePermission(request, permission);
  return { ...user, adminId: user.id, adminUsername: user.username };
}

/* ---------------------------------- cookies ---------------------------------- */

const ONE_YEAR_MS = 365 * 24 * 3600 * 1000;

export function setSessionCookies(
  reply: FastifyReply,
  tokens: { accessToken: string; refreshToken: string; accessExpiresIn: number },
  csrf: string,
  secure: boolean,
): void {
  const base = { path: '/', sameSite: 'lax' as const, secure, httpOnly: true };
  reply.header(
    'set-cookie',
    [
      serializeCookie(ACCESS_COOKIE, tokens.accessToken, { ...base, maxAge: tokens.accessExpiresIn }),
      serializeCookie(REFRESH_COOKIE, tokens.refreshToken, { ...base, maxAge: Math.floor(ONE_YEAR_MS / 1000), path: '/api/auth' }),
      serializeCookie(CSRF_COOKIE, csrf, { ...base, httpOnly: false, maxAge: tokens.accessExpiresIn }),
    ],
  );
}

export function clearSessionCookies(reply: FastifyReply, secure: boolean): void {
  const base = { path: '/', sameSite: 'lax' as const, secure, httpOnly: true, maxAge: 0 };
  reply.header(
    'set-cookie',
    [
      serializeCookie(ACCESS_COOKIE, '', base),
      serializeCookie(REFRESH_COOKIE, '', { ...base, path: '/api/auth' }),
      serializeCookie(CSRF_COOKIE, '', { ...base, httpOnly: false }),
    ],
  );
}

function serializeCookie(name: string, value: string, opts: { path: string; sameSite: 'lax' | 'strict' | 'none'; secure: boolean; httpOnly: boolean; maxAge: number }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path}`, `SameSite=${capitalize(opts.sameSite)}`, `Max-Age=${Math.floor(opts.maxAge)}`];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ----------------------------------- CSRF ----------------------------------- */

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Cookie-authenticated writes must carry the double-submit CSRF token.
 * Bearer-authenticated writes are inherently immune (a cross-site attacker
 * cannot read the token from memory) and are therefore exempt.
 */
export function csrfGuard(request: FastifyRequest): void {
  if (!UNSAFE.has(request.method)) return;
  if (readBearer(request)) return;
  const cookies = (request as any).cookies as Record<string, string> | undefined;
  const fromCookie = cookies?.[CSRF_COOKIE];
  const fromHeader = request.headers[CSRF_HEADER];
  if (!fromCookie) return; // no cookie session -> nothing to forge
  if (typeof fromHeader !== 'string' || fromHeader.length < 16 || fromHeader !== fromCookie) {
    throw new AppError(403, 'FORBIDDEN', 'Security token mismatch. Please reload the page and try again.');
  }
}

export function profileFor(request: FastifyRequest): PublicUser & { profile: ReturnType<typeof toProfileDto> } {
  const user = requireAuth(request);
  const db = getDb();
  return {
    ...toPublicUser(user.row),
    profile: toProfileDto(getProfile(db, user.id)),
  };
}

/** Register the auth hooks on the app. */
export function registerAuthHooks(app: FastifyInstance): void {
  app.decorateRequest('user', undefined);
  app.decorateRequest('sessionId', undefined);
}
