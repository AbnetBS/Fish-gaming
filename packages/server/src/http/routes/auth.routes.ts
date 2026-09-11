import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, type Database } from '../../db/index.js';
import { env } from '../../config/env.js';
import { parse, emailSchema, passwordSchema, usernameSchema } from '../validate.js';
import { AppError, badRequest } from '../../lib/errors.js';
import {
  activeSessions,
  createEmailVerificationToken,
  createPasswordResetToken,
  login,
  logout,
  refresh,
  resetPasswordWithToken,
  revokeAllSessions,
  verifyEmailToken,
} from '../../modules/auth/service.js';
import { checkPasswordPolicy, isValidEmail } from '../../security/passwords.js';
import { createUser, ensureUserProfile, toProfileDto, toPublicUser } from '../../modules/users/service.js';
import { credit, ensureWallet, getWallet } from '../../modules/wallet/ledger.js';
import { ACCESS_COOKIE, CSRF_COOKIE, REFRESH_COOKIE, clearSessionCookies, requireAuth, resolveUser, setSessionCookies } from '../auth.js';
import { logger } from '../../lib/logger.js';
import { permissionsForRole } from '@reef/shared';
import { writeAudit } from '../../lib/audit.js';

/**
 * Authentication surface.
 *
 * Tokens are delivered *both* as an httpOnly cookie (so the browser can restore
 * a session on reload without touching JS-readable storage) and in the JSON
 * body (so the SPA can put it in an Authorization header for same-origin
 * robustness and for the WebSocket handshake). Cookie writes are CSRF-guarded.
 */

const registerBody = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  acceptTerms: z.boolean(),
}).strict();

const loginBody = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(200),
}).strict();

/**
 * New-device alert. Compares this sign-in's browser against the player's other
 * live sessions and warns when nothing else shares the user agent. Only fires
 * when the player has `loginNotify` switched on — the toggle in Settings is what
 * gates it, so the switch is not decorative.
 */
function newSignInNotice(
  db: Database,
  userId: string,
  currentSessionId: string | undefined,
  loginNotify: boolean,
  userAgent: string | null,
): string | null {
  if (!loginNotify) return null;
  const others = db.all<{ user_agent: string | null }>(
    currentSessionId
      ? 'SELECT user_agent FROM refresh_tokens WHERE user_id = ? AND id <> ? AND revoked_at IS NULL'
      : 'SELECT user_agent FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL',
    ...(currentSessionId ? [userId, currentSessionId] : [userId]),
  );
  // A first sign-in (or a device already in use) is not news.
  if (others.length === 0) return null;
  const ua = (userAgent ?? '').slice(0, 240);
  if (others.some((row) => (row.user_agent ?? '') === ua)) return null;
  return 'Signed in from a browser that has no other active session. If that was not you, change your password and close every session.';
}

export function registerAuthRoutes(app: FastifyInstance): void {
  const secure = () => env().cookieSecure;
  const sameSite = () => env().cookieSameSite;

  app.post('/api/auth/register', { config: { rateLimit: { max: 8, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const body = parse(registerBody, request.body, 'body');
    const db = getDb();
    const policy = checkPasswordPolicy(body.password);
    if (!policy.ok) throw badRequest(policy.errors.join(' '));

    const created = createUser(db, {
      username: body.username,
      email: body.email,
      password: body.password,
      acceptTerms: body.acceptTerms,
    });
    ensureUserProfile(db, created.user.id);
    // New accounts start with the configured demo credit — granted server-side,
    // idempotent per user, and recorded in the ledger.
    const opening = env().startingDemoCoins;
    ensureWallet(db, created.user.id, 0);
    if (opening > 0) {
      credit(db, {
        userId: created.user.id,
        amount: opening,
        type: 'DEMO_CREDIT',
        referenceId: `signup:${created.user.id}`,
        idempotencyKey: `signup-credit:${created.user.id}`,
        description: 'Welcome demo credit',
      });
    }

    const verifyToken = createEmailVerificationToken(db, created.user.id);
    const tokens = await login(db, body.email, body.password, { ip: request.ip, userAgent: request.headers['user-agent'] ?? null });
    const csrf = crypto.randomBytes(24).toString('base64url');
    setSessionCookies(reply, tokens.tokens, csrf, secure(), sameSite());

    logger.info('User registered', { userId: created.user.id });
    return reply.code(201).send({
      user: tokens.user,
      profile: tokens.profile,
      wallet: getWallet(db, created.user.id),
      permissions: [],
      accessToken: tokens.tokens.accessToken,
      refreshToken: tokens.tokens.refreshToken,
      csrfToken: csrf,
      emailVerificationToken: env().isProduction ? undefined : verifyToken,
    });
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 12, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const body = parse(loginBody, request.body, 'body');
    const db = getDb();
    const identifier = body.identifier;
    const result = await login(db, identifier, body.password, { ip: request.ip, userAgent: request.headers['user-agent'] ?? null });
    const csrf = crypto.randomBytes(24).toString('base64url');
    setSessionCookies(reply, result.tokens, csrf, secure(), sameSite());
    return reply.send({
      user: result.user,
      profile: result.profile,
      wallet: getWallet(db, result.user.id),
      permissions: permissionsForRole(result.user.role),
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      csrfToken: csrf,
      // Respects the player's own "new sign-in alerts" setting; the client shows
      // it as a warning banner on the dashboard.
      securityNotice: newSignInNotice(db, result.user.id, result.tokens.sid, result.profile.loginNotify, request.headers['user-agent'] ?? null),
    });
  });

  app.post('/api/auth/refresh', async (request, reply) => {
    const db = getDb();
    const cookies = (request as any).cookies as Record<string, string> | undefined;
    const token = cookies?.[REFRESH_COOKIE] ?? (request.body as { refreshToken?: string } | undefined)?.refreshToken;
    if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'You are not signed in.');
    const result = await refresh(db, token, { ip: request.ip, userAgent: request.headers['user-agent'] ?? null });
    const user = db.get<any>('SELECT * FROM users WHERE id = ?', result.userId)!;
    const csrf = crypto.randomBytes(24).toString('base64url');
    setSessionCookies(reply, result.tokens, csrf, secure(), sameSite());
    return reply.send({
      user: toPublicUser(user),
      profile: toProfileDto(db.get('SELECT * FROM profiles WHERE user_id = ?', result.userId)),
      permissions: permissionsForRole(user.role),
      accessToken: result.tokens.accessToken,
      refreshToken: result.tokens.refreshToken,
      csrfToken: csrf,
    });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const db = getDb();
    const cookies = (request as any).cookies as Record<string, string> | undefined;
    logout(db, cookies?.[REFRESH_COOKIE] ?? (request.body as { refreshToken?: string } | undefined)?.refreshToken);
    // Sign out this device only: revoking the session row makes the access token
    // stop working immediately rather than at its expiry. "Sign out everywhere"
    // is a separate, explicit action.
    const caller = resolveUser(request);
    if (caller?.sid) db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', new Date().toISOString(), caller.sid);
    clearSessionCookies(reply, secure(), sameSite());
    reply.header('set-cookie', `${CSRF_COOKIE}=; Path=/; Max-Age=0`);
    void ACCESS_COOKIE;
    return reply.send({ ok: true });
  });

  app.get('/api/auth/me', async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    return {
      user: toPublicUser(user.row),
      profile: toProfileDto(db.get('SELECT * FROM profiles WHERE user_id = ?', user.id)),
      wallet: getWallet(db, user.id),
      permissions: user.permissions,
    };
  });

  app.post('/api/auth/forgot-password', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request) => {
    const body = parse(z.object({ email: z.string().trim().max(254) }).strict(), request.body, 'body');
    const db = getDb();
    const email = body.email.toLowerCase();
    if (!isValidEmail(email)) throw badRequest('Please enter a valid email address.');
    const token = createPasswordResetToken(db, email);
    // The response is deliberately identical whether or not the account exists.
    const response = { ok: true, message: 'If that email is registered, a reset link is on its way.' } as Record<string, unknown>;
    if (token && !env().isProduction) {
      // No mail transport in a demo deployment: surface the link in dev only.
      response.devResetToken = token;
    }
    return response;
  });

  app.post('/api/auth/reset-password', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, async (request) => {
    const body = parse(z.object({ token: z.string().min(10).max(200), password: passwordSchema }).strict(), request.body, 'body');
    const policy = checkPasswordPolicy(body.password);
    if (!policy.ok) throw badRequest(policy.errors.join(' '));
    resetPasswordWithToken(getDb(), body.token, body.password);
    return { ok: true, message: 'Password updated. Please sign in with your new password.' };
  });

  app.post('/api/auth/verify-email', async (request) => {
    const body = parse(z.object({ token: z.string().min(8).max(200) }).strict(), request.body, 'body');
    const ok = verifyEmailToken(getDb(), body.token);
    if (!ok) throw badRequest('That verification link is not valid or has expired.');
    return { ok: true, message: 'Email verified.' };
  });

  app.get('/api/auth/sessions', async (request) => {
    const user = requireAuth(request);
    return { items: activeSessions(getDb(), user.id) };
  });

  app.post('/api/auth/sessions/revoke-all', async (request) => {
    const user = requireAuth(request);
    revokeAllSessions(getDb(), user.id);
    return { ok: true, message: 'All other sessions were signed out.' };
  });

}
