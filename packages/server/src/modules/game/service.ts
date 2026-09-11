import type { Database } from '../../db/index.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { uid } from '../../lib/ids.js';
import { getActiveConfiguration, isMaintenanceMode } from '../config/service.js';
import { ensureActiveRound } from './round.js';
import { credit, debit, getWallet } from '../wallet/ledger.js';
import { writeAudit } from '../../lib/audit.js';
import type { GameHistoryEntry, GameSession, LeaderboardEntry, LeaderboardWindow, RoomSummary } from '@reef/shared';

/**
 * Sessions, rooms (REST view), history and leaderboards.
 *
 * The REST surface exists so the platform works even if the WebSocket channel
 * is unavailable, and so joining/leaving is a durable, auditable operation.
 */

export function listRooms(
  db: Database,
  view: { playerCount: (roomId: string) => number; roundIdOf: (roomId: string) => string | null },
  includeInactive = false,
): RoomSummary[] {
  const rows = db.all<any>(`SELECT * FROM game_rooms ${includeInactive ? '' : "WHERE status = 'ACTIVE'"} ORDER BY min_bet, key`);
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    minBet: r.min_bet,
    maxBet: r.max_bet,
    maxPlayers: r.max_players,
    status: r.status,
    playersInRoom: view.playerCount(r.id),
    currentRoundId: view.roundIdOf(r.id),
  }));
}

export interface JoinResult {
  session: GameSession;
  room: RoomSummary;
  balance: number;
  cannonKey: string;
  betOptions: BetOption[];
}

export interface BetOption {
  key: string;
  name: string;
  level: number;
  power: number;
  shotCost: number;
  fireRate: number;
  legal: boolean;
  reason?: string;
}

export function betOptionsFor(db: Database, roomId: string, preferredCannon?: string | null): { options: BetOption[]; cannonKey: string } {
  const room = db.get<any>('SELECT * FROM game_rooms WHERE id = ?', roomId);
  if (!room) throw notFound('Game room not found.');
  const config = getActiveConfiguration(db);
  const options = config.cannons
    .filter((c) => c.enabled)
    .map((c) => {
      const tooCheap = c.shotCost < room.min_bet;
      const tooDear = c.shotCost > room.max_bet;
      return {
        key: c.key,
        name: c.name,
        level: c.level,
        power: c.power,
        shotCost: c.shotCost,
        fireRate: c.fireRate,
        legal: !tooCheap && !tooDear,
        reason: tooCheap ? `Below this room's minimum bet of ${room.min_bet}` : tooDear ? `Above this room's maximum bet of ${room.max_bet}` : undefined,
      };
    })
    .sort((a, b) => a.level - b.level);

  const requested = preferredCannon ? options.find((o) => o.key === preferredCannon && o.legal) : undefined;
  const fallback = options.find((o) => o.legal);
  if (!fallback) {
    throw new AppError(409, 'BET_OUT_OF_RANGE', `No cannon in your inventory fits this room (bet range ${room.min_bet}-${room.max_bet} demo coins).`);
  }
  return { options, cannonKey: (requested ?? fallback).key };
}

export function joinRoom(db: Database, userId: string, roomId: string, preferredCannon?: string): JoinResult {
  const room = db.get<any>('SELECT * FROM game_rooms WHERE id = ? OR key = ?', roomId, roomId);
  if (!room) throw notFound('Game room not found.');
  if (isMaintenanceMode(db)) throw new AppError(409, 'MAINTENANCE', 'The game is under maintenance. Please try again shortly.');
  if (room.status !== 'ACTIVE') throw new AppError(409, 'ROOM_UNAVAILABLE', 'This room is currently closed. Please pick another room.');

  const account = db.get<{ status: string }>('SELECT status FROM users WHERE id = ?', userId);
  if (account?.status === 'SUSPENDED') throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');

  const config = getActiveConfiguration(db);
  const { options, cannonKey } = betOptionsFor(db, room.id, preferredCannon);
  const cannon = config.cannons.find((c) => c.key === cannonKey)!;
  // Creating/joining a room is what starts a round; the same helper the
  // simulation uses, so both views of the room always agree.
  const round = ensureActiveRound(db, room.id);

  const timestamp = new Date().toISOString();
  const sessionId = uid('ses');
  const wallet = getWallet(db, userId);

  return db.transaction(() => {
    // One active session per player: leave cleanly before joining elsewhere.
    db.run("UPDATE game_sessions SET status = 'ENDED', ended_at = ? WHERE user_id = ? AND status = 'ACTIVE'", timestamp, userId);
    db.run(
      `INSERT INTO game_sessions (id, user_id, room_id, round_id, cannon_id, status, started_at, total_shots, total_wagered, total_rewarded)
       VALUES (?,?,?,?,?, 'ACTIVE', ?,0,0,0)`,
      sessionId,
      userId,
      room.id,
      round.roundId,
      cannon.id,
      timestamp,
    );
    const sessionRow = db.get<any>('SELECT * FROM game_sessions WHERE id = ?', sessionId)!;
    return {
      session: mapSession(sessionRow),
      room: {
        id: room.id,
        key: room.key,
        name: room.name,
        description: room.description,
        minBet: room.min_bet,
        maxBet: room.max_bet,
        maxPlayers: room.max_players,
        status: room.status,
        playersInRoom: 0,
        currentRoundId: round.roundId,
      },
      balance: wallet.balance,
      cannonKey,
      betOptions: options,
    };
  });
}

export function leaveRoom(db: Database, userId: string): { summary: SessionSummary | null } {
  const session = db.get<any>("SELECT * FROM game_sessions WHERE user_id = ? AND status = 'ACTIVE' ORDER BY started_at DESC LIMIT 1", userId);
  if (!session) return { summary: null };
  const timestamp = new Date().toISOString();
  db.run("UPDATE game_sessions SET status = 'ENDED', ended_at = ? WHERE id = ?", timestamp, session.id);
  return { summary: sessionSummary(session) };
}

export interface SessionSummary {
  sessionId: string;
  roundId: string;
  roomId: string;
  shots: number;
  wagered: number;
  rewarded: number;
  net: number;
  startedAt: string;
  endedAt: string;
}

function sessionSummary(row: any): SessionSummary {
  return {
    sessionId: row.id,
    roundId: row.round_id,
    roomId: row.room_id,
    shots: row.total_shots,
    wagered: row.total_wagered,
    rewarded: row.total_rewarded,
    net: row.total_rewarded - row.total_wagered,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? new Date().toISOString(),
  };
}

function mapSession(row: any): GameSession {
  return {
    id: row.id,
    userId: row.user_id,
    roomId: row.room_id,
    roundId: row.round_id,
    cannonId: row.cannon_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    totalShots: row.total_shots,
    totalWagered: row.total_wagered,
    totalRewarded: row.total_rewarded,
  };
}

export function activeSession(db: Database, userId: string): GameSession | null {
  const row = db.get<any>("SELECT * FROM game_sessions WHERE user_id = ? AND status = 'ACTIVE' ORDER BY started_at DESC LIMIT 1", userId);
  return row ? mapSession(row) : null;
}

export function setSessionCannon(db: Database, userId: string, cannonKey: string): { ok: boolean; message?: string } {
  const session = db.get<any>("SELECT id, room_id FROM game_sessions WHERE user_id = ? AND status = 'ACTIVE' ORDER BY started_at DESC LIMIT 1", userId);
  if (!session) return { ok: false, message: 'You are not in a game room.' };
  const room = db.get<any>('SELECT * FROM game_rooms WHERE id = ?', session.room_id);
  const config = getActiveConfiguration(db);
  const cannon = config.cannons.find((c) => c.key === cannonKey);
  if (!cannon || !cannon.enabled) return { ok: false, message: 'That cannon is not available.' };
  if (room && (cannon.shotCost < room.min_bet || cannon.shotCost > room.max_bet)) {
    return { ok: false, message: `${room.name} accepts bets of ${room.min_bet}-${room.max_bet} demo coins.` };
  }
  db.run('UPDATE game_sessions SET cannon_id = ? WHERE id = ?', cannon.id, session.id);
  return { ok: true };
}

/* --------------------------------- history --------------------------------- */

export function listHistory(
  db: Database,
  userId: string,
  params: { limit?: number; offset?: number; roomId?: string },
): { items: GameHistoryEntry[]; total: number } {
  const limit = Math.min(Math.max(params.limit ?? 30, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);
  const args: unknown[] = [userId];
  let clause = 'WHERE h.user_id = ?';
  if (params.roomId) {
    clause += ' AND h.room_id = ?';
    args.push(params.roomId);
  }
  const total = db.scalar<number>(`SELECT COUNT(*) FROM game_history h ${clause}`, ...args) ?? 0;
  const items = db
    .all<any>(
      `SELECT h.*, r.name AS room_name, c.name AS cannon_name, c.key AS cannon_key
       FROM game_history h
       LEFT JOIN game_rooms r ON r.id = h.room_id
       LEFT JOIN cannons c ON c.id = h.cannon_id
       ${clause} ORDER BY h.created_at DESC, h.rowid DESC LIMIT ? OFFSET ?`,
      ...args,
      limit,
      offset,
    )
    .map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      roundId: r.round_id,
      roomId: r.room_id,
      roomName: r.room_name ?? 'Unknown room',
      cannonName: r.cannon_name ?? 'Cannon',
      cannonKey: r.cannon_key ?? 'unknown',
      shotCost: r.shot_cost,
      fishKey: r.fish_key,
      fishName: r.fish_name,
      reward: r.reward,
      result: r.result,
      createdAt: r.created_at,
    }));
  return { items, total };
}

export interface SessionAggregate {
  sessionId: string;
  roomId: string;
  roomName: string;
  roundId: string;
  configVersion: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  shots: number;
  wagered: number;
  rewarded: number;
  net: number;
  kills: number;
}

export function listSessions(db: Database, userId: string, limit = 10): SessionAggregate[] {
  return db
    .all<any>(
      `SELECT s.*, r.name AS room_name,
              (SELECT COUNT(*) FROM game_history h WHERE h.session_id = s.id AND h.result = 'KILL') AS kills,
              (SELECT COALESCE(MAX(config_version), '') FROM game_rounds g WHERE g.id = s.round_id) AS config_version
       FROM game_sessions s LEFT JOIN game_rooms r ON r.id = s.room_id
       WHERE s.user_id = ? ORDER BY s.started_at DESC, s.rowid DESC LIMIT ?`,
      userId,
      Math.min(Math.max(limit, 1), 50),
    )
    .map((r) => ({
      sessionId: r.id,
      roomId: r.room_id,
      roomName: r.room_name ?? 'Unknown room',
      roundId: r.round_id,
      configVersion: r.config_version ?? '',
      startedAt: r.started_at,
      endedAt: r.ended_at,
      status: r.status,
      shots: r.total_shots,
      wagered: r.total_wagered,
      rewarded: r.total_rewarded,
      net: r.total_rewarded - r.total_wagered,
      kills: r.kills ?? 0,
    }));
}

export function playerTotals(db: Database, userId: string) {
  const row = db.get<any>(
    `SELECT
       COALESCE(SUM(CASE WHEN type='BET' THEN -amount ELSE 0 END),0) AS wagered,
       COALESCE(SUM(CASE WHEN type='WIN' THEN amount ELSE 0 END),0) AS rewarded,
       COUNT(DISTINCT game_round_id) AS rounds
     FROM wallet_transactions WHERE user_id = ? AND type IN ('BET','WIN')`,
    userId,
  );
  return {
    wagered: row?.wagered ?? 0,
    rewarded: row?.rewarded ?? 0,
    rounds: row?.rounds ?? 0,
    net: (row?.rewarded ?? 0) - (row?.wagered ?? 0),
  };
}

/* ------------------------------- leaderboard ------------------------------- */

const WINDOW_SQL: Record<LeaderboardWindow, string> = {
  daily: "AND t.created_at >= strftime('%Y-%m-%d','now') || 'T00:00:00.000Z'",
  weekly: "AND t.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days')",
  alltime: '',
};

/**
 * Leaderboards are computed from the ledger, not from anything a client
 * reported, and expose only rank / username / demo coins earned.
 */
export function leaderboard(db: Database, window: LeaderboardWindow, limit = 20): LeaderboardEntry[] {
  const capped = Math.min(Math.max(limit, 1), 100);
  const rows = db.all<any>(
    `SELECT u.username, u.avatar_seed,
            COALESCE(SUM(t.amount),0) AS earned,
            COUNT(DISTINCT t.game_round_id) AS rounds
     FROM wallet_transactions t
     JOIN users u ON u.id = t.user_id AND u.status <> 'CLOSED'
     WHERE t.type = 'WIN' ${WINDOW_SQL[window] ?? ''}
     GROUP BY t.user_id
     ORDER BY earned DESC, rounds ASC, u.username ASC
     LIMIT ?`,
    capped,
  );
  return rows.map((r, i) => ({
    rank: i + 1,
    username: r.username,
    earned: r.earned,
    rounds: r.rounds,
    avatarSeed: r.avatar_seed,
  }));
}

export function personalRank(db: Database, userId: string, window: LeaderboardWindow): { rank: number | null; earned: number } {
  const list = leaderboard(db, window, 100);
  const me = db.get<{ username: string }>('SELECT username FROM users WHERE id = ?', userId);
  const earned =
    db.scalar<number>(
      `SELECT COALESCE(SUM(amount),0) FROM wallet_transactions WHERE user_id = ? AND type='WIN' ${WINDOW_SQL[window] ?? ''}`,
      userId,
    ) ?? 0;
  const found = list.find((e) => e.username === me?.username);
  return { rank: found?.rank ?? null, earned };
}

/* ------------------------------ demo top-ups ------------------------------ */

/**
 * Free, rate-limited demo-coin grant for testers who run out. Idempotent per
 * (user, plan, hour) so a retry cannot stack up credits.
 */
export function grantDemoTopup(db: Database, userId: string, plan: { id: string; label: string; demoCoins: number }): { credited: number; balance: number } {
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  const result = credit(db, {
    userId,
    amount: plan.demoCoins,
    type: 'DEMO_CREDIT',
    referenceId: `topup:${plan.id}`,
    idempotencyKey: `topup:${userId}:${plan.id}:${hourBucket}`,
    description: `${plan.label} demo pack`,
  });
  return { credited: result.replayed ? 0 : plan.demoCoins, balance: result.wallet.balance };
}

/* --------------------------- admin: transactions view --------------------------- */

export function adminAdjustDemoCoins(
  db: Database,
  params: { adminId: string; adminUsername: string | null; userId: string; amount: number; reason: string; ip?: string | null },
): { balance: number } {
  if (!Number.isInteger(params.amount) || params.amount === 0) throw badRequest('Adjustment must be a non-zero whole number of demo coins.');
  if (Math.abs(params.amount) > 10_000_000) throw badRequest('Adjustment is too large. Use a batch process.');
  if (!params.reason || params.reason.trim().length < 3) throw badRequest('A reason of at least 3 characters is required.');
  const user = db.get<any>('SELECT id, username FROM users WHERE id = ?', params.userId);
  if (!user) throw notFound('User not found.');

  const isCredit = params.amount > 0;
  // A demo debit must never push the balance negative: ledger enforces it, we
  // surface a friendly message first.
  if (!isCredit) {
    const wallet = getWallet(db, params.userId);
    if (wallet.balance + params.amount < 0) throw new AppError(402, 'INSUFFICIENT_FUNDS', 'That would take the account below zero demo coins.');
  }

  const result = isCredit
    ? credit(db, {
        userId: params.userId,
        amount: params.amount,
        type: 'ADMIN_ADJUSTMENT',
        referenceId: `admin:${params.adminId}`,
        idempotencyKey: null,
        description: params.reason.trim().slice(0, 200),
      })
    : debit(db, {
        userId: params.userId,
        amount: -params.amount,
        referenceId: `admin:${params.adminId}`,
        gameRoundId: '',
        description: params.reason.trim().slice(0, 200),
      });

  writeAudit(db, {
    adminId: params.adminId,
    adminUsername: params.adminUsername,
    action: 'DEMO_WALLET_ADJUST',
    entity: 'wallets',
    entityId: result.wallet.id,
    previousValue: result.transaction.balanceBefore,
    newValue: result.transaction.balanceAfter,
    metadata: { userId: params.userId, username: user.username, amount: params.amount, reason: params.reason },
    ip: params.ip ?? null,
  });
  return { balance: result.wallet.balance };
}
