import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { parse, passwordSchema } from '../validate.js';
import { badRequest } from '../../lib/errors.js';
import { requireAuth } from '../auth.js';
import { changePassword, getProfile, toProfileDto, toPublicUser, updateProfile } from '../../modules/users/service.js';
import { checkPasswordPolicy } from '../../security/passwords.js';
import { revokeAllSessions } from '../../modules/auth/service.js';
import { listTransactions, getWallet } from '../../modules/wallet/ledger.js';
import { listHistory, listSessions, leaderboard, personalRank, playerTotals, betOptionsFor } from '../../modules/game/service.js';
import { writeAudit } from '../../lib/audit.js';
import { readPlayLimits, requestSelfExclusion } from '../../modules/game/limits.js';
import type { RoundManager } from '../../sim/round-manager.js';
import type { LeaderboardWindow } from '@reef/shared';

const WINDOWS = ['daily', 'weekly', 'alltime'] as const;

/**
 * Player-facing account, wallet, history and leaderboard endpoints.
 *
 * Every route here is scoped to `request.user.id`; there is no parameter that
 * lets one player read another player's private data.
 */
export function registerAccountRoutes(app: FastifyInstance, rounds: () => RoundManager): void {
  app.get('/api/me', async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    return {
      user: toPublicUser(user.row),
      profile: toProfileDto(getProfile(db, user.id)),
      wallet: getWallet(db, user.id),
      totals: playerTotals(db, user.id),
      permissions: user.permissions,
    };
  });

  app.patch('/api/me/profile', async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    const body = parse(
      z
        .object({
          displayName: z.string().trim().max(48).nullable().optional(),
          country: z.string().trim().length(2).toUpperCase().nullable().optional(),
          bio: z.string().trim().max(280).nullable().optional(),
          language: z.string().trim().length(2).optional(),
          loginNotify: z.boolean().optional(),
          sessionLimitMin: z.number().int().min(0).max(1440).nullable().optional(),
        })
        .strict(),
      request.body,
      'body',
    );
    const profile = updateProfile(db, user.id, body);
    return { profile };
  });

  /**
   * Player-protection state, read straight from the rows the game enforces —
   * so what the settings page shows is what the shot path applies.
   */
  app.get('/api/me/limits', async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    const limits = readPlayLimits(db, user.id);
    return {
      limitMin: limits.limitMin,
      minutesPlayedToday: limits.minutesPlayedToday,
      minutesRemaining: Number.isFinite(limits.minutesRemaining) ? limits.minutesRemaining : null,
      selfExcludedUntil: limits.selfExcludedUntil,
    };
  });

  /**
   * Start a self-exclusion. Available to the player at any time; lifting one
   * early is an admin action (`POST /api/admin/users/:id/limits/lift`) and a
   * shorter request can never shorten an exclusion that is already running.
   */
  app.post('/api/me/self-exclusion', async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    const body = parse(
      z.object({ duration: z.enum(['24h', '7d', '30d', '90d']) }).strict(),
      request.body,
      'body',
    );
    const result = requestSelfExclusion(db, user.id, body.duration, { id: user.id, username: user.username });
    // Effective immediately: if they are mid-round, that round stops now.
    rounds().suspendPlayer(user.id, 'SELF_EXCLUDED', 'Your self-exclusion has started. Play is blocked for this period.');
    return { ok: true, selfExclusion: result };
  });

  app.post('/api/me/password', async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    const body = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: passwordSchema }).strict(), request.body, 'body');
    const policy = checkPasswordPolicy(body.newPassword);
    if (!policy.ok) throw badRequest(policy.errors.join(' '));
    await changePassword(db, user.id, body.currentPassword, body.newPassword, request.sessionId ?? null);
    writeAudit(db, {
      adminId: user.id,
      adminUsername: user.username,
      action: 'SELF_PASSWORD_CHANGE',
      entity: 'users',
      entityId: user.id,
      metadata: { via: 'account-settings' },
      ip: request.ip,
    });
    return { ok: true, message: 'Password updated. Please sign in again on other devices.' };
  });

  app.post('/api/me/security/logout-all', async (request) => {
    const user = requireAuth(request);
    revokeAllSessions(getDb(), user.id);
    return { ok: true, message: 'You have been signed out everywhere.' };
  });

  /* --------------------------------- wallet --------------------------------- */

  app.get('/api/wallet', async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    return { wallet: getWallet(db, user.id), totals: playerTotals(db, user.id) };
  });

  app.get('/api/wallet/transactions', async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    const query = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), page: z.coerce.number().int().min(1).max(10_000).default(1), type: z.enum(['DEMO_CREDIT', 'BET', 'WIN', 'REFUND', 'ADMIN_ADJUSTMENT']).optional() }).strict(),
      request.query,
      'query',
    );
    const result = listTransactions(db, user.id, { limit: query.limit, offset: (query.page - 1) * query.limit, type: query.type });
    return { ...result, page: query.page, pageSize: query.limit };
  });

  /* ------------------------------ history/records ------------------------------ */

  app.get('/api/history', async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    const query = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(200).default(30), page: z.coerce.number().int().min(1).max(10_000).default(1), roomId: z.string().trim().max(64).optional() }).strict(),
      request.query,
      'query',
    );
    const result = listHistory(db, user.id, { limit: query.limit, offset: (query.page - 1) * query.limit, roomId: query.roomId });
    return { ...result, page: query.page, pageSize: query.limit };
  });

  app.get('/api/sessions', async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    return { items: listSessions(db, user.id, 12) };
  });

  app.get('/api/rooms/:roomKey/bets', async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    const params = parse(z.object({ roomKey: z.string().trim().min(1).max(32) }).strict(), request.params, 'params');
    const room = db.get<any>('SELECT * FROM game_rooms WHERE key = ? OR id = ?', params.roomKey, params.roomKey);
    if (!room) throw badRequest('Unknown room.');
    const session = db.get<any>("SELECT cannon_id FROM game_sessions WHERE user_id = ? AND status = 'ACTIVE' ORDER BY started_at DESC LIMIT 1", user.id);
    const preferred = session?.cannon_id ? db.get<{ key: string }>('SELECT key FROM cannons WHERE id = ?', session.cannon_id)?.key : undefined;
    return betOptionsFor(db, room.id, preferred ?? null);
  });

  /* ------------------------------- leaderboard ------------------------------- */

  app.get('/api/leaderboard', async (request) => {
    const db = getDb();
    const query = parse(z.object({ window: z.enum(WINDOWS).default('daily'), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict(), request.query, 'query');
    const window = query.window as LeaderboardWindow;
    const items = leaderboard(db, window, query.limit);
    const me = request.user ? personalRank(db, request.user.id, window) : null;
    return { window, items, me };
  });
}
