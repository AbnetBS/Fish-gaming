import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db/index.js';
import { parse, keySchema } from '../validate.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { requireAdmin } from '../auth.js';
import {
  configMeta,
  readWorkingSettings,
  createCannon,
  createFish,
  createRoom,
  deleteFish,
  getSystemSettings,
  listConfigVersions,
  publish,
  setSystemSetting,
  updateCannon,
  updateFish,
  updateRoom,
  updateSettings,
  getFish,
  getCannons,
  getRooms,
} from '../../modules/config/service.js';
import { readAudit } from '../../lib/audit.js';
import { computeAdminStats, roundAudit, roundReport } from '../../modules/reports/service.js';
import { getProfile, listUsers, setAccountStatus, toProfileDto, toPublicUser } from '../../modules/users/service.js';
import { liftSelfExclusion, readPlayLimits } from '../../modules/game/limits.js';
import { adminAdjustDemoCoins } from '../../modules/game/service.js';
import {
  cancelTournament,
  createTournament,
  getTournamentDetail,
  houseRakeTotal,
  listAllTournaments,
  startTournament,
} from '../../modules/game/tournaments.js';
import { verifyLedgerIntegrity } from '../../modules/wallet/ledger.js';
import { revokeAllSessions } from '../../modules/auth/service.js';
import type { RoundManager } from '../../sim/round-manager.js';
import { logger } from '../../lib/logger.js';

/**
 * Admin API.
 *
 * Every route declares the *capability* it needs. The capability set is
 * resolved from the role stored in the database for the authenticated user —
 * nothing the browser sends participates in that decision. Each mutation
 * writes an audit row containing the before/after values.
 */

const fishPatchSchema = z
  .object({
    name: z.string().trim().min(2).max(48).optional(),
    category: z.enum(['COMMON', 'MEDIUM', 'LARGE', 'RARE', 'BOSS', 'SPECIAL_GOLDEN', 'SPECIAL_TREASURE', 'SPECIAL_SPEED', 'SPECIAL_BOMB']).optional(),
    health: z.number().int().min(1).max(100_000).optional(),
    reward: z.number().int().min(0).max(1_000_000).optional(),
    speed: z.number().min(1).max(4000).optional(),
    size: z.number().min(4).max(400).optional(),
    rarity: z.number().min(0).max(1000).optional(),
    spawnWeight: z.number().min(0).max(1000).optional(),
    movementPattern: z.enum(['STRAIGHT', 'DIAGONAL', 'SINE', 'CIRCULAR', 'CURVED', 'WANDER', 'BOSS']).optional(),
    palette: z.number().int().min(0).max(24).optional(),
    minSpawnIntervalMs: z.number().int().min(0).max(600_000).optional(),
    special: z.enum(['golden', 'treasure', 'speed', 'bomb', 'boss']).nullable().optional(),
    enabled: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  })
  .strict();

const cannonPatchSchema = z
  .object({
    name: z.string().trim().min(2).max(48).optional(),
    level: z.number().int().min(1).max(20).optional(),
    power: z.number().int().min(1).max(1000).optional(),
    shotCost: z.number().int().min(1).max(100_000).optional(),
    fireRate: z.number().min(0.2).max(20).optional(),
    projectileSpeed: z.number().min(100).max(8000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const roomPatchSchema = z
  .object({
    name: z.string().trim().min(2).max(48).optional(),
    description: z.string().trim().max(240).optional(),
    minBet: z.number().int().min(1).max(100_000).optional(),
    maxBet: z.number().int().min(1).max(1_000_000).optional(),
    maxPlayers: z.number().int().min(1).max(32).optional(),
    fishPool: z.array(z.string().trim().max(64)).max(64).optional(),
    spawnRateMultiplier: z.number().min(0.1).max(5).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .strict();

const settingsPatchSchema = z
  .object({
    maxActiveFish: z.number().int().min(1).max(400).optional(),
    fishSpawnRate: z.number().min(0.1).max(40).optional(),
    maxProjectiles: z.number().int().min(5).max(500).optional(),
    roundDurationS: z.number().int().min(30).max(86_400).optional(),
    gameSpeed: z.number().min(0.2).max(4).optional(),
    waveIntervalS: z.number().int().min(5).max(3600).optional(),
    waveSize: z.number().int().min(1).max(60).optional(),
    minShotValue: z.number().int().min(1).max(100_000).optional(),
    maxShotValue: z.number().int().min(1).max(1_000_000).optional(),
    fishLifetimeS: z.number().int().min(4).max(600).optional(),
    specialFishEnabled: z.boolean().optional(),
    rtpTarget: z.number().min(0.01).max(1).optional(),
  })
  .strict();

export function registerAdminRoutes(app: FastifyInstance, rounds: () => RoundManager): void {
  const ctx = (request: any, permission: any) => {
    const admin = requireAdmin(request, permission);
    return { db: getDb(), adminId: admin.id, adminUsername: admin.username, ip: request.ip };
  };

  /* ------------------------------- dashboard ------------------------------- */

  app.get('/api/admin/dashboard', async (request) => {
    const admin = requireAdmin(request, 'admin:panel');
    const db = getDb();
    void admin;
    const stats = computeAdminStats(db, rounds().onlineCount(), rounds().activeRoomCount());
    return {
      ...stats,
      configuration: configMeta(db),
      ledgerIntegrity: verifyLedgerIntegrity(db),
      note: 'All figures are DEMO statistics derived from the virtual demo-coin ledger. No real money exists in this system.',
    };
  });

  /* --------------------------------- users --------------------------------- */

  app.get('/api/admin/users', async (request) => {
    requireAdmin(request, 'users:read');
    const query = parse(
      z.object({
        search: z.string().trim().max(80).optional(),
        status: z.enum(['ACTIVE', 'PENDING_VERIFICATION', 'SUSPENDED', 'CLOSED']).optional(),
        page: z.coerce.number().int().min(1).max(10_000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      }),
      request.query,
      'query',
    );
    const result = listUsers(getDb(), { search: query.search, status: query.status, limit: query.limit, offset: (query.page - 1) * query.limit });
    return { ...result, page: query.page, pageSize: query.limit };
  });

  app.get('/api/admin/users/:id', async (request) => {
    requireAdmin(request, 'users:read');
    const db = getDb();
    const params = parse(z.object({ id: z.string().trim().min(1).max(64) }), request.params, 'params');
    const row = db.get<any>('SELECT u.*, a.admin_role FROM users u LEFT JOIN admin_accounts a ON a.user_id = u.id WHERE u.id = ?', params.id);
    if (!row) throw new AppError(404, 'NOT_FOUND', 'User not found.');
    const wallet = db.get<any>('SELECT * FROM wallets WHERE user_id = ?', params.id);
    const totals = db.get<any>(
      `SELECT COALESCE(SUM(CASE WHEN type='BET' THEN -amount ELSE 0 END),0) AS wagered,
              COALESCE(SUM(CASE WHEN type='WIN' THEN amount ELSE 0 END),0) AS rewarded,
              COUNT(*) AS txCount FROM wallet_transactions WHERE user_id = ?`,
      params.id,
    );
    return {
      user: toPublicUser(row),
      adminRole: row.admin_role ?? null,
      // Protection state the console may act on: usage today + any exclusion.
      profile: toProfileDto(getProfile(db, params.id)),
      limits: readPlayLimits(db, params.id),
      wallet: wallet ? { id: wallet.id, balance: wallet.balance, currency: 'DEMO', updatedAt: wallet.updated_at } : null,
      totals,
      recentTransactions: db
        .all<any>('SELECT id, type, amount, balance_after, description, created_at FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 12', params.id)
        .map((t) => ({ id: t.id, type: t.type, amount: t.amount, balanceAfter: t.balance_after, description: t.description, createdAt: t.created_at })),
      recentSessions: db
        .all<any>(
          `SELECT s.id, s.round_id, s.started_at, s.ended_at, s.total_shots, s.total_wagered, s.total_rewarded, r.name AS room_name
           FROM game_sessions s LEFT JOIN game_rooms r ON r.id = s.room_id WHERE s.user_id = ? ORDER BY s.started_at DESC LIMIT 10`,
          params.id,
        )
        .map((s) => ({
          id: s.id,
          roundId: s.round_id,
          roomName: s.room_name,
          startedAt: s.started_at,
          endedAt: s.ended_at,
          shots: s.total_shots,
          wagered: s.total_wagered,
          rewarded: s.total_rewarded,
        })),
    };
  });

  app.post('/api/admin/users/:id/status', async (request, reply) => {
    const admin = requireAdmin(request, 'users:write');
    const db = getDb();
    const params = parse(z.object({ id: z.string().trim().min(1).max(64) }), request.params, 'params');
    const body = parse(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']), reason: z.string().trim().min(3).max(240) }).strict(), request.body, 'body');
    if (params.id === admin.id) throw badRequest('You cannot change the status of your own account.');
    const before = db.get<any>('SELECT status FROM users WHERE id = ?', params.id);
    if (!before) throw new AppError(404, 'NOT_FOUND', 'User not found.');
    const user = setAccountStatus(db, params.id, body.status);
    if (body.status !== 'ACTIVE') revokeAllSessions(db, params.id);
    db.run(
      `INSERT INTO audit_logs (id, admin_id, admin_username, action, entity, entity_id, previous_value, new_value, metadata, ip_address, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      `aud_${Date.now().toString(36)}`,
      admin.id,
      admin.username,
      `USER_${body.status}`,
      'users',
      params.id,
      JSON.stringify({ status: before.status }),
      JSON.stringify({ status: body.status }),
      JSON.stringify({ reason: body.reason }),
      request.ip,
      new Date().toISOString(),
    );
    logger.info('Account status changed', { by: admin.username, target: params.id, status: body.status });
    // A suspension must stop live play, not just future logins.
    if (body.status !== 'ACTIVE') {
      rounds().suspendPlayer(params.id, 'ACCOUNT_BLOCKED', 'This account has been suspended. Contact support.');
    }
    return reply.send({ ok: true, user });
  });

  /**
   * Lift a player-initiated self-exclusion. This is the only path that can
   * shorten an exclusion, it requires the user-write capability, and it refuses
   * to pretend when nothing is running. Every use is audited with a reason.
   */
  app.post('/api/admin/users/:id/limits/lift', async (request, reply) => {
    const admin = requireAdmin(request, 'users:write');
    const db = getDb();
    const params = parse(z.object({ id: z.string().trim().min(1).max(64) }), request.params, 'params');
    const body = parse(z.object({ reason: z.string().trim().min(5).max(240) }).strict(), request.body, 'body');
    liftSelfExclusion(db, params.id, { id: admin.id, username: admin.username }, body.reason);
    logger.info('Self-exclusion lifted', { by: admin.username, target: params.id });
    return reply.send({ ok: true, profile: toProfileDto(getProfile(db, params.id)) });
  });

  /** Read a player's protection state (limit usage + exclusion) for support. */
  app.get('/api/admin/users/:id/limits', async (request) => {
    requireAdmin(request, 'users:read');
    const db = getDb();
    const params = parse(z.object({ id: z.string().trim().min(1).max(64) }), request.params, 'params');
    return readPlayLimits(db, params.id);
  });

  app.post('/api/admin/users/:id/demo-coins', async (request) => {
    const admin = requireAdmin(request, 'transactions:write');
    const db = getDb();
    const params = parse(z.object({ id: z.string().trim().min(1).max(64) }), request.params, 'params');
    const body = parse(z.object({ amount: z.number().int().min(-10_000_000).max(10_000_000), reason: z.string().trim().min(3).max(240) }).strict(), request.body, 'body');
    if (body.amount === 0) throw badRequest('Adjustment amount cannot be zero.');
    const result = adminAdjustDemoCoins(db, {
      adminId: admin.id,
      adminUsername: admin.username,
      userId: params.id,
      amount: body.amount,
      reason: body.reason,
      ip: request.ip,
    });
    return { ok: true, balance: result.balance, currency: 'DEMO' };
  });

  /* --------------------------------- fish --------------------------------- */

  app.get('/api/admin/fish', async (request) => {
    requireAdmin(request, 'fish:read');
    return { items: getFish(getDb()) };
  });

  app.post('/api/admin/fish', async (request, reply) => {
    const context = ctx(request, 'fish:write');
    const body = parse(fishPatchSchema.extend({ key: keySchema, name: z.string().trim().min(2).max(48) }).strict(), request.body, 'body');
    const fish = createFish(context, body);
    return reply.code(201).send({ fish });
  });

  app.patch('/api/admin/fish/:id', async (request) => {
    const context = ctx(request, 'fish:write');
    const params = parse(z.object({ id: z.string().trim().min(1).max(64) }), request.params, 'params');
    const body = parse(fishPatchSchema.partial().extend({ key: keySchema.optional() }).strict(), request.body, 'body');
    const { key: _key, ...patch } = body;
    const result = updateFish(context, params.id, patch);
    return { ok: true, fish: result.fish, changed: result.changed, config: configMeta(context.db) };
  });

  app.delete('/api/admin/fish/:id', async (request) => {
    const context = ctx(request, 'fish:write');
    const params = parse(z.object({ id: z.string().trim().min(1).max(64) }), request.params, 'params');
    deleteFish(context, params.id);
    return { ok: true };
  });

  /* -------------------------------- cannons -------------------------------- */

  app.get('/api/admin/cannons', async (request) => {
    requireAdmin(request, 'cannons:read');
    return { items: getCannons(getDb()) };
  });

  app.post('/api/admin/cannons', async (request, reply) => {
    const context = ctx(request, 'cannons:write');
    const body = parse(cannonPatchSchema.extend({ key: keySchema, name: z.string().trim().min(2).max(48) }).strict(), request.body, 'body');
    return reply.code(201).send({ cannon: createCannon(context, body) });
  });

  app.patch('/api/admin/cannons/:id', async (request) => {
    const context = ctx(request, 'cannons:write');
    const params = parse(z.object({ id: z.string().trim().min(1).max(64) }), request.params, 'params');
    const body = parse(cannonPatchSchema, request.body, 'body');
    return { ok: true, cannon: updateCannon(context, params.id, body), config: configMeta(context.db) };
  });

  /* --------------------------------- rooms --------------------------------- */

  app.get('/api/admin/rooms', async (request) => {
    requireAdmin(request, 'rooms:read');
    const db = getDb();
    return {
      items: getRooms(db).map((room) => ({
        ...room,
        playersInRoom: rounds().roomPlayerCount(room.id),
        activeRounds: db.scalar<number>('SELECT COUNT(*) FROM game_rounds WHERE room_id = ? AND status = ?', room.id, 'ACTIVE') ?? 0,
        sessionsToday: db.scalar<number>('SELECT COUNT(*) FROM game_sessions WHERE room_id = ? AND started_at >= ?', room.id, startOfToday()) ?? 0,
      })),
    };
  });

  app.post('/api/admin/rooms', async (request, reply) => {
    const context = ctx(request, 'rooms:write');
    const body = parse(roomPatchSchema.extend({ key: keySchema, name: z.string().trim().min(2).max(48) }).strict(), request.body, 'body');
    return reply.code(201).send({ room: createRoom(context, body) });
  });

  app.patch('/api/admin/rooms/:id', async (request) => {
    const context = ctx(request, 'rooms:write');
    const params = parse(z.object({ id: z.string().trim().min(1).max(64) }), request.params, 'params');
    const body = parse(roomPatchSchema, request.body, 'body');
    const room = updateRoom(context, params.id, body);
    if (body.status === 'INACTIVE') rounds().closeRoomRounds(params.id);
    return { ok: true, room, config: configMeta(context.db) };
  });

  /* -------------------------------- tournaments -------------------------------- */

  app.get('/api/admin/tournaments', async (request) => {
    requireAdmin(request, 'tournaments:read');
    const query = parse(
      z.object({ status: z.enum(['ALL', 'LOBBY', 'RUNNING', 'SETTLED', 'CANCELLED']).optional() }).strict(),
      request.query,
      'query',
    );
    return { items: listAllTournaments(getDb(), query.status ?? 'ALL'), house: houseRakeTotal(getDb()) };
  });

  app.post('/api/admin/tournaments', async (request, reply) => {
    const context = ctx(request, 'tournaments:write');
    const body = parse(
      z
        .object({
          name: z.string().trim().min(3).max(48),
          entryFee: z.number().int().min(1).max(1_000_000),
          minPlayers: z.number().int().min(2).max(8),
          maxPlayers: z.number().int().min(2).max(8),
          durationS: z.number().int().min(60).max(3600),
          rakePct: z.number().int().min(0).max(90),
          cannonKey: z.string().trim().min(1).max(32),
          lobbyMinutes: z.number().int().min(1).max(180),
          spawnRateMultiplier: z.number().min(0.5).max(3).optional(),
        })
        .strict(),
      request.body,
      'body',
    );
    const tournament = createTournament(context.db, { id: context.adminId, username: context.adminUsername, ip: context.ip }, body);
    return reply.code(201).send({ tournament });
  });

  app.get('/api/admin/tournaments/:id', async (request) => {
    requireAdmin(request, 'tournaments:read');
    const params = parse(z.object({ id: z.string().trim().min(1).max(64) }), request.params, 'params');
    return getTournamentDetail(getDb(), params.id);
  });

  app.post('/api/admin/tournaments/:id/start', async (request) => {
    const context = ctx(request, 'tournaments:write');
    const params = parse(z.object({ id: z.string().trim().min(1).max(64) }), request.params, 'params');
    return { tournament: startTournament(context.db, params.id, { admin: { id: context.adminId, username: context.adminUsername, ip: context.ip } }) };
  });

  app.post('/api/admin/tournaments/:id/cancel', async (request) => {
    const context = ctx(request, 'tournaments:write');
    const params = parse(z.object({ id: z.string().trim().min(1).max(64) }), request.params, 'params');
    const body = parse(z.object({ reason: z.string().trim().max(240).optional() }).strict(), request.body ?? {}, 'body');
    const result = cancelTournament(
      context.db,
      params.id,
      { id: context.adminId, username: context.adminUsername, ip: context.ip, reason: body.reason },
    );
    return { ok: true, ...result };
  });

  /* ------------------------------ game settings ------------------------------ */

  app.get('/api/admin/settings', async (request) => {
    requireAdmin(request, 'config:read');
    const db = getDb();
    return { settings: readWorkingSettings(db), system: getSystemSettings(db), meta: configMeta(db) };
  });

  app.patch('/api/admin/settings', async (request) => {
    const context = ctx(request, 'config:write');
    const body = parse(settingsPatchSchema, request.body, 'body');
    const settings = updateSettings(context, body);
    return { ok: true, settings, meta: configMeta(context.db) };
  });

  /* --------------------------- configuration versions --------------------------- */

  app.get('/api/admin/config/versions', async (request) => {
    requireAdmin(request, 'config:read');
    return { items: listConfigVersions(getDb(), 30) };
  });

  app.post('/api/admin/config/publish', async (request) => {
    const context = ctx(request, 'config:write');
    const body = parse(z.object({ notes: z.string().trim().max(240).optional() }).strict(), request.body ?? {}, 'body');
    const config = publish({ db: context.db, adminId: context.adminId, adminUsername: context.adminUsername, ip: context.ip }, body.notes ?? null);
    logger.info('Configuration published', { admin: context.adminUsername, version: config.version });
    return { ok: true, version: config.version, meta: configMeta(context.db) };
  });

  app.get('/api/admin/config/versions/:version', async (request) => {
    requireAdmin(request, 'config:read');
    const params = parse(z.object({ version: z.string().trim().min(1).max(32) }), request.params, 'params');
    const row = getDb().get<{ payload: string; published_at: string; notes: string }>('SELECT payload, published_at, notes FROM game_configs WHERE version = ?', params.version);
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Configuration version not found.');
    return { version: params.version, publishedAt: row.published_at, notes: row.notes, config: JSON.parse(row.payload) };
  });

  /* ---------------------------- history + ledger ---------------------------- */

  app.get('/api/admin/history', async (request) => {
    requireAdmin(request, 'history:read');
    const query = parse(
      z.object({
        page: z.coerce.number().int().min(1).max(10_000).default(1),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        roomId: z.string().trim().max(64).optional(),
        result: z.enum(['MISSED', 'HIT', 'KILL']).optional(),
      }),
      request.query,
      'query',
    );
    const db = getDb();
    const where: string[] = [];
    const args: unknown[] = [];
    if (query.roomId) {
      where.push('h.room_id = ?');
      args.push(query.roomId);
    }
    if (query.result) {
      where.push('h.result = ?');
      args.push(query.result);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.scalar<number>(`SELECT COUNT(*) FROM game_history h ${clause}`, ...args) ?? 0;
    const items = db
      .all<any>(
        `SELECT h.*, u.username, r.name AS room_name, c.name AS cannon_name
         FROM game_history h JOIN users u ON u.id = h.user_id
         LEFT JOIN game_rooms r ON r.id = h.room_id LEFT JOIN cannons c ON c.id = h.cannon_id
         ${clause} ORDER BY h.created_at DESC LIMIT ? OFFSET ?`,
        ...args,
        query.limit,
        (query.page - 1) * query.limit,
      )
      .map((r) => ({
        id: r.id,
        username: r.username,
        roomName: r.room_name,
        roundId: r.round_id,
        cannonName: r.cannon_name,
        shotCost: r.shot_cost,
        fishName: r.fish_name,
        reward: r.reward,
        result: r.result,
        createdAt: r.created_at,
      }));
    return { items, total, page: query.page, pageSize: query.limit };
  });

  app.get('/api/admin/rounds', async (request) => {
    requireAdmin(request, 'reports:read');
    const query = parse(
      z.object({ limit: z.coerce.number().int().min(1).max(200).default(25), roomId: z.string().trim().max(64).optional(), from: z.string().trim().max(40).optional(), to: z.string().trim().max(40).optional() }),
      request.query,
      'query',
    );
    return roundReport(getDb(), query);
  });

  app.get('/api/admin/rounds/:roundId/audit', async (request) => {
    requireAdmin(request, 'reports:read');
    const params = parse(z.object({ roundId: z.string().trim().min(1).max(64) }), request.params, 'params');
    const result = roundAudit(getDb(), decodeURIComponent(params.roundId));
    if (!result) throw new AppError(404, 'NOT_FOUND', 'Round not found.');
    return result;
  });

  app.get('/api/admin/transactions', async (request) => {
    requireAdmin(request, 'transactions:read');
    const query = parse(
      z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1), limit: z.coerce.number().int().min(1).max(200).default(50), type: z.enum(['DEMO_CREDIT', 'BET', 'WIN', 'REFUND', 'ADMIN_ADJUSTMENT']).optional(), userId: z.string().trim().max(64).optional() }),
      request.query,
      'query',
    );
    const db = getDb();
    const where: string[] = [];
    const args: unknown[] = [];
    if (query.type) {
      where.push('t.type = ?');
      args.push(query.type);
    }
    if (query.userId) {
      where.push('t.user_id = ?');
      args.push(query.userId);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.scalar<number>(`SELECT COUNT(*) FROM wallet_transactions t ${clause}`, ...args) ?? 0;
    const items = db
      .all<any>(
        `SELECT t.*, u.username FROM wallet_transactions t JOIN users u ON u.id = t.user_id
         ${clause} ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`,
        ...args,
        query.limit,
        (query.page - 1) * query.limit,
      )
      .map((t) => ({
        id: t.id,
        username: t.username,
        type: t.type,
        amount: t.amount,
        balanceBefore: t.balance_before,
        balanceAfter: t.balance_after,
        roundId: t.game_round_id,
        status: t.status,
        description: t.description,
        createdAt: t.created_at,
      }));
    return { items, total, page: query.page, pageSize: query.limit, integrity: verifyLedgerIntegrity(db) };
  });

  /* --------------------------------- reports --------------------------------- */

  app.get('/api/admin/reports/overview', async (request) => {
    requireAdmin(request, 'reports:read');
    const db = getDb();
    return {
      demo: computeAdminStats(db, rounds().onlineCount(), rounds().activeRoomCount()),
      disclaimer: 'All statistics describe virtual DEMO COINS. This deployment holds no real-money balances.',
      liveRooms: rounds().statusView(),
    };
  });

  app.get('/api/admin/reports/export.csv', async (request, reply) => {
    requireAdmin(request, 'reports:read');
    const query = parse(z.object({ kind: z.enum(['rounds', 'history', 'transactions']).default('rounds') }), request.query, 'query');
    const db = getDb();
    let csv = '';
    if (query.kind === 'rounds') {
      const rows = roundReport(db, { limit: 500 }).items;
      csv = toCsv(['roundId', 'room', 'status', 'configVersion', 'players', 'shots', 'demoWagered', 'demoRewarded', 'rtp'], rows.map((r) => [r.roundId, r.roomName, r.status, r.configVersion, r.players, r.shots, r.wagered, r.rewarded, r.rtp === null ? '' : r.rtp.toFixed(4)]));
    } else if (query.kind === 'history') {
      const rows = db.all<any>('SELECT h.*, u.username, r.name AS room FROM game_history h JOIN users u ON u.id=h.user_id LEFT JOIN game_rooms r ON r.id=h.room_id ORDER BY h.created_at DESC LIMIT 5000');
      csv = toCsv(['createdAt', 'username', 'room', 'round', 'cannon', 'shotCost', 'fish', 'reward', 'result'], rows.map((r) => [r.created_at, r.username, r.room, r.round_id, r.cannon_id, r.shot_cost, r.fish_name ?? '', r.reward, r.result]));
    } else {
      const rows = db.all<any>('SELECT t.*, u.username FROM wallet_transactions t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 5000');
      csv = toCsv(['createdAt', 'username', 'type', 'amount', 'balanceBefore', 'balanceAfter', 'roundId', 'status', 'description'], rows.map((t) => [t.created_at, t.username, t.type, t.amount, t.balance_before, t.balance_after, t.game_round_id ?? '', t.status, t.description ?? '']));
    }
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="reef-${query.kind}.csv"`);
    return reply.send(csv);
  });

  /* --------------------------------- audit --------------------------------- */

  app.get('/api/admin/audit', async (request) => {
    requireAdmin(request, 'audit:read');
    const query = parse(
      z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1), limit: z.coerce.number().int().min(1).max(200).default(50), entity: z.string().trim().max(40).optional(), action: z.string().trim().max(40).optional(), adminId: z.string().trim().max(64).optional() }),
      request.query,
      'query',
    );
    const result = readAudit(getDb(), { limit: query.limit, offset: (query.page - 1) * query.limit, entity: query.entity, action: query.action, adminId: query.adminId });
    return { ...result, page: query.page, pageSize: query.limit };
  });

  /* ----------------------------- system settings ----------------------------- */

  app.patch('/api/admin/system-settings', async (request) => {
    const context = ctx(request, 'settings:write');
    const body = parse(z.object({ key: z.string().trim().min(2).max(64), value: z.string().trim().max(4000), description: z.string().trim().max(240).optional() }).strict(), request.body, 'body');
    if (body.key === 'maintenance_mode') {
      const on = body.value === 'true';
      setSystemSetting(context, 'maintenance_mode', on ? 'true' : 'false', 'When true, gameplay endpoints are closed to players');
      if (on) rounds().closeAllRounds();
      logger.warn(`Maintenance mode ${on ? 'enabled' : 'disabled'}`, { admin: context.adminUsername });
      return { ok: true, maintenance: on };
    }
    if (body.key.startsWith('real_money') || body.key.includes('payment_secret')) {
      throw badRequest('Real-money configuration cannot be changed through the admin panel. It is controlled by deployment environment flags and compliance sign-off.');
    }
    setSystemSetting(context, body.key, body.value, body.description);
    return { ok: true };
  });

  app.post('/api/admin/maintenance', async (request) => {
    const context = ctx(request, 'maintenance:write');
    const body = parse(z.object({ enabled: z.boolean(), reason: z.string().trim().max(240).optional() }).strict(), request.body, 'body');
    setSystemSetting(context, 'maintenance_mode', body.enabled ? 'true' : 'false', 'When true, gameplay endpoints are closed to players');
    if (body.enabled) {
      rounds().closeAllRounds();
      rounds().broadcastMaintenanceNotice('The game is entering maintenance. You will be returned to the dashboard.');
    } else {
      rounds().broadcastMaintenanceNotice('Maintenance finished. Rooms are open again.');
    }
    return { ok: true, maintenance: body.enabled };
  });
}

/* --------------------------------- helpers --------------------------------- */

function startOfToday(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  const escape = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => r.map(escape).join(','))].join('\n');
}
