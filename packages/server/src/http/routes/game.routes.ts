import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { parse, angleSchema, coordSchema } from '../validate.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { requireAuth } from '../auth.js';
import { getActiveConfiguration, isMaintenanceMode } from '../../modules/config/service.js';
import {
  activeSession,
  betOptionsFor,
  grantDemoTopup,
  joinRoom,
  leaveRoom,
  listRooms,
  setSessionCannon,
} from '../../modules/game/service.js';
import { getWallet } from '../../modules/wallet/ledger.js';
import { assertPlayAllowed, readPlayLimits } from '../../modules/game/limits.js';
import { DEMO_TOPUP_PLANS, getPaymentProvider } from '../../modules/payments/provider.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import type { RoundManager } from '../../sim/round-manager.js';
import { CURRENCY_LABEL } from '@reef/shared';

/**
 * Player-facing game routes: room list, join/leave, state, and an HTTP
 * fallback for shooting.
 *
 * `POST /api/game/fire` is not a weaker path: it runs the exact same
 * server-authoritative `RoundManager.fire()` as the WebSocket transport, so a
 * client cannot gain anything by avoiding the socket.
 */
export function registerGameRoutes(app: FastifyInstance, rounds: () => RoundManager): void {
  app.get('/api/game/rooms', async () => {
    const db = getDb();
    const manager = rounds();
    return {
      rooms: listRooms(
        db,
        {
          playerCount: (roomId) => manager.roomPlayerCount(roomId),
          roundIdOf: (roomId) => manager.currentRoundId(roomId),
        },
        false,
      ).map((room) => ({
        ...room,
        playersInRoom: room.playersInRoom || db.scalar<number>('SELECT COUNT(*) FROM game_sessions WHERE room_id = ? AND status = ?', room.id, 'ACTIVE') || 0,
      })),
      maintenance: isMaintenanceMode(db),
      currency: CURRENCY_LABEL,
    };
  });

  app.post('/api/game/join', async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    const body = parse(z.object({ roomKey: z.string().trim().min(1).max(32), cannonKey: z.string().trim().max(32).optional() }).strict(), request.body, 'body');
    if (isMaintenanceMode(db)) throw new AppError(409, 'MAINTENANCE', 'The game is under maintenance. Please try again shortly.');

    const room = db.get<any>("SELECT * FROM game_rooms WHERE key = ? AND status = 'ACTIVE'", body.roomKey);
    if (!room) throw new AppError(404, 'ROOM_UNAVAILABLE', 'That game room does not exist or is closed.');

    // Player-protection gate: daily play limit and self-exclusion are read here
    // so a blocked player gets a reason, not an empty room.
    const limits = assertPlayAllowed(db, user.id);

    const capacity = room.max_players as number;
    const live = rounds().roomPlayerCount(room.id);
    const dbActive =
      db.scalar<number>("SELECT COUNT(*) FROM game_sessions WHERE room_id = ? AND status = 'ACTIVE'", room.id) ?? 0;
    if (Math.max(live, dbActive) >= capacity) {
      throw new AppError(409, 'ROOM_FULL', 'Room is full. Try another room.');
    }

    const preferred = activeSession(db, user.id);
    const preferredCannon = preferred
      ? db.get<{ key: string }>('SELECT key FROM cannons WHERE id = ?', preferred.cannonId ?? '')?.key
      : undefined;
    const result = joinRoom(db, user.id, room.id, preferredCannon ?? body.cannonKey);
    logger.debug('Player joined room', { user: user.id, room: room.key, round: result.session.roundId });
    return {
      roomId: result.room.id,
      roomKey: result.room.key,
      roundId: result.session.roundId,
      sessionId: result.session.id,
      wallet: { balance: result.balance, currency: 'DEMO' as const },
      cannonKey: result.cannonKey,
      betOptions: result.betOptions,
      limits: {
        limitMin: limits.limitMin,
        minutesPlayedToday: limits.minutesPlayedToday,
        minutesRemaining: Number.isFinite(limits.minutesRemaining) ? limits.minutesRemaining : null,
      },
    };
  });

  app.post('/api/game/leave', async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    const { summary } = leaveRoom(db, user.id);
    return { ok: true, summary, wallet: getWallet(db, user.id) };
  });

  app.get('/api/game/session', async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    const session = activeSession(db, user.id);
    if (!session) return { session: null };
    const limits = readPlayLimits(db, user.id);
    return {
      session,
      betOptions: betOptionsFor(db, session.roomId, db.get<{ key: string }>('SELECT key FROM cannons WHERE id = ?', session.cannonId ?? '')?.key ?? null).options,
      wallet: getWallet(db, user.id),
      snapshot: rounds().snapshotFor(session.roomId),
      limits: {
        limitMin: limits.limitMin,
        minutesPlayedToday: limits.minutesPlayedToday,
        minutesRemaining: Number.isFinite(limits.minutesRemaining) ? limits.minutesRemaining : null,
        selfExcludedUntil: limits.selfExcludedUntil,
      },
    };
  });

  /**
   * HTTP shot path used when the WebSocket channel is unavailable (and by the
   * automated end-to-end test). Same authority checks as the socket path.
   */
  app.post('/api/game/fire', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    const body = parse(
      z
        .object({
          clientRef: z.string().trim().min(8).max(64),
          roomId: z.string().trim().min(1).max(64).optional(),
          cannonKey: z.string().trim().min(1).max(32),
          angle: angleSchema,
          originX: coordSchema,
          originY: coordSchema,
        })
        .strict(),
      request.body,
      'body',
    );
    const result = rounds().fireViaHttp(db, user.id, body);
    if (!result.ok) {
      const status =
        result.code === 'INSUFFICIENT_FUNDS' ? 402
        : result.code === 'RATE_LIMITED' ? 429
        : result.code === 'INVALID_SESSION' || result.code === 'NO_ACTIVE_SESSION' ? 409
        : result.code === 'MAINTENANCE' || result.code === 'ROOM_UNAVAILABLE' ? 409
        : result.code === 'INTERNAL' ? 500
        : 400;
      throw new AppError(status, result.code ?? 'GAME_UNAVAILABLE', result.message ?? 'That shot was not accepted.', {
        waitMs: (result as { waitMs?: number }).waitMs,
      });
    }
    return result;
  });

  app.post('/api/game/cannon', async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    const body = parse(z.object({ cannonKey: z.string().trim().min(1).max(32) }).strict(), request.body, 'body');
    const result = setSessionCannon(db, user.id, body.cannonKey);
    if (!result.ok) throw badRequest(result.message ?? 'That cannon is not available here.');
    const session = activeSession(db, user.id);
    return {
      ok: true,
      cannonKey: body.cannonKey,
      betOptions: session ? betOptionsFor(db, session.roomId, body.cannonKey).options : [],
    };
  });

  /* ------------------------------- demo top-ups ------------------------------- */

  /**
   * Free demo-coin grants for testers. There is no price, no provider call and
   * no cash value in either direction.
   */
  app.get('/api/payments/plans', async () => ({
    realMoneyEnabled: false,
    currency: CURRENCY_LABEL,
    plans: DEMO_TOPUP_PLANS.map((p) => ({ id: p.id, label: p.label, demoCoins: p.demoCoins, price: null, currency: CURRENCY_LABEL })),
  }));

  app.post('/api/payments/demo-topup', { config: { rateLimit: { max: 6, timeWindow: '1 hour' } } }, async (request) => {
    const db = getDb();
    const user = requireAuth(request);
    const body = parse(z.object({ planId: z.string().trim().min(1).max(32) }).strict(), request.body, 'body');
    const plan = DEMO_TOPUP_PLANS.find((p) => p.id === body.planId);
    if (!plan) throw badRequest('Unknown demo pack.');
    const result = grantDemoTopup(db, user.id, plan);
    return { ok: true, credited: result.credited, wallet: getWallet(db, user.id), currency: CURRENCY_LABEL };
  });

  /** Explicit dead ends, so nothing here can ever be mistaken for real money. */
  for (const path of ['/api/payments/deposit', '/api/payments/withdraw']) {
    app.post(path, async () => {
      const provider = getPaymentProvider();
      if (provider.settlesRealMoney) throw new AppError(403, 'REAL_MONEY_DISABLED', 'Real-money transactions are disabled in this deployment.');
      throw new AppError(403, 'REAL_MONEY_DISABLED', 'This platform runs on virtual demo coins only. Deposits and withdrawals are not available.');
    });
  }

  app.get('/api/game/status', async () => ({
    serverTime: Date.now(),
    tickMs: env().simTickMs,
    snapshotMs: env().snapshotMs,
    rooms: rounds().statusView(),
    online: rounds().onlineCount(),
    maintenance: isMaintenanceMode(getDb()),
    realMoneyEnabled: false,
  }));
}
