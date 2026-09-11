import type { Database } from '../../db/index.js';
import type { AdminStats } from '@reef/shared';

/**
 * Aggregated, clearly-labelled DEMO statistics for the admin dashboard.
 * Everything here is derived from the ledger and the event tables — no
 * client-supplied counters.
 */

const DAY_START = "strftime('%Y-%m-%d','now') || 'T00:00:00.000Z'";

export function computeAdminStats(db: Database, onlinePlayers = 0, activeRooms = 0): AdminStats {
  const totalUsers = db.scalar<number>('SELECT COUNT(*) FROM users') ?? 0;
  const activeUsers = db.scalar<number>("SELECT COUNT(*) FROM users WHERE status = 'ACTIVE'") ?? 0;
  const gamesToday =
    db.scalar<number>('SELECT COUNT(*) FROM game_sessions WHERE started_at >= ' + DAY_START) ?? 0;
  const shotsToday = db.scalar<number>('SELECT COUNT(*) FROM player_shots WHERE created_at >= ' + DAY_START) ?? 0;
  const wageredToday =
    db.scalar<number>(`SELECT COALESCE(SUM(-amount),0) FROM wallet_transactions WHERE type='BET' AND created_at >= ${DAY_START}`) ?? 0;
  const rewardedToday =
    db.scalar<number>(`SELECT COALESCE(SUM(amount),0) FROM wallet_transactions WHERE type='WIN' AND created_at >= ${DAY_START}`) ?? 0;

  const usersOverTime = db
    .all<{ d: string; c: number }>(
      `SELECT substr(created_at,1,10) AS d, COUNT(*) AS c FROM users
       WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-13 days')
       GROUP BY d ORDER BY d`,
    )
    .map((r) => ({ date: r.d, count: r.c }));

  const shotsOverTime = db
    .all<{ d: string; c: number }>(
      `SELECT substr(created_at,1,10) AS d, COUNT(*) AS c FROM player_shots
       WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-13 days')
       GROUP BY d ORDER BY d`,
    )
    .map((r) => ({ date: r.d, count: r.c }));

  const popularRooms = db
    .all<{ name: string; c: number }>(
      `SELECT r.name AS name, COUNT(*) AS c FROM game_sessions s JOIN game_rooms r ON r.id = s.room_id
       GROUP BY r.id ORDER BY c DESC LIMIT 6`,
    )
    .map((r) => ({ name: r.name, count: r.c }));

  const popularFish = db
    .all<{ name: string; c: number }>(
      `SELECT COALESCE(fish_name, fish_key, 'Unknown') AS name, COUNT(*) AS c FROM game_history
       WHERE result = 'KILL' AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days')
       GROUP BY name ORDER BY c DESC LIMIT 8`,
    )
    .map((r) => ({ name: r.name, count: r.c }));

  const activityByHour = db
    .all<{ h: number; c: number }>(
      `SELECT CAST(substr(created_at,12,2) AS INTEGER) AS h, COUNT(*) AS c FROM player_shots
       WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')
       GROUP BY h ORDER BY h`,
    )
    .map((r) => ({ hour: r.h, shots: r.c }));

  return {
    totalUsers,
    activeUsers,
    activeRooms,
    gamesToday,
    shotsToday,
    demoCoinsWageredToday: wageredToday,
    demoCoinsRewardedToday: rewardedToday,
    rtpToday: wageredToday > 0 ? rewardedToday / wageredToday : null,
    onlinePlayers,
    usersOverTime,
    shotsOverTime,
    popularRooms,
    popularFish,
    activityByHour,
  };
}

export interface RoundReportRow {
  roundId: string;
  roomName: string;
  status: string;
  configVersion: string;
  startedAt: string;
  endedAt: string | null;
  players: number;
  shots: number;
  wagered: number;
  rewarded: number;
  rtp: number | null;
}

export function roundReport(db: Database, params: { limit?: number; roomId?: string; from?: string; to?: string }): { items: RoundReportRow[]; total: number } {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 200);
  const where: string[] = [];
  const args: unknown[] = [];
  if (params.roomId) {
    where.push('g.room_id = ?');
    args.push(params.roomId);
  }
  if (params.from) {
    where.push('g.started_at >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('g.started_at <= ?');
    args.push(params.to);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.scalar<number>(`SELECT COUNT(*) FROM game_rounds g ${clause}`, ...args) ?? 0;
  const items = db
    .all<any>(
      `SELECT g.*, r.name AS room_name,
              (SELECT COUNT(DISTINCT user_id) FROM game_sessions s WHERE s.round_id = g.id) AS players
       FROM game_rounds g LEFT JOIN game_rooms r ON r.id = g.room_id
       ${clause} ORDER BY g.started_at DESC LIMIT ?`,
      ...args,
      limit,
    )
    .map((r) => ({
      roundId: r.id,
      roomName: r.room_name ?? 'Unknown',
      status: r.status,
      configVersion: r.config_version,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      players: r.players ?? 0,
      shots: r.total_shots,
      wagered: r.total_wagered,
      rewarded: r.total_rewarded,
      rtp: r.total_wagered > 0 ? r.total_rewarded / r.total_wagered : null,
    }));
  return { items, total };
}

/**
 * Per-round RTP reconciliation. This is what an auditor asks for: for a given
 * round, the exact configuration used and the money in / money out.
 */
export function roundAudit(db: Database, roundId: string) {
  const round = db.get<any>('SELECT * FROM game_rounds WHERE id = ?', roundId);
  if (!round) return null;
  const config = db.get<{ payload: string }>('SELECT payload FROM game_configs WHERE version = ?', round.config_version);
  const perPlayer = db.all<any>(
    `SELECT u.username,
            COUNT(s.id) AS shots,
            COALESCE(SUM(s.cost),0) AS wagered,
            COALESCE(SUM(s.reward),0) AS rewarded,
            SUM(CASE WHEN s.result='KILL' THEN 1 ELSE 0 END) AS kills
     FROM player_shots s JOIN users u ON u.id = s.user_id
     WHERE s.round_id = ? GROUP BY s.user_id ORDER BY wagered DESC`,
    roundId,
  ).map((r) => ({
    username: r.username,
    shots: r.shots,
    wagered: r.wagered,
    rewarded: r.rewarded,
    kills: r.kills ?? 0,
    net: r.rewarded - r.wagered,
  }));
  return {
    roundId: round.id,
    roomId: round.room_id,
    status: round.status,
    seed: round.seed,
    configVersion: round.config_version,
    startedAt: round.started_at,
    endedAt: round.ended_at,
    totals: { shots: round.total_shots, wagered: round.total_wagered, rewarded: round.total_rewarded },
    rtp: round.total_wagered > 0 ? round.total_rewarded / round.total_wagered : null,
    perPlayer,
    configuration: config ? JSON.parse(config.payload) : null,
  };
}

export function leaderboardSnapshot(db: Database, window: 'daily' | 'weekly' | 'alltime', limit = 10) {
  const clause =
    window === 'daily'
      ? `AND created_at >= ${DAY_START}`
      : window === 'weekly'
        ? "AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days')"
        : '';
  return db
    .all<any>(
      `SELECT u.username, COALESCE(SUM(t.amount),0) AS earned, COUNT(DISTINCT t.game_round_id) AS rounds
       FROM wallet_transactions t JOIN users u ON u.id = t.user_id
       WHERE t.type='WIN' ${clause} GROUP BY t.user_id ORDER BY earned DESC LIMIT ?`,
      limit,
    )
    .map((r, i) => ({ rank: i + 1, username: r.username, earned: r.earned, rounds: r.rounds }));
}
