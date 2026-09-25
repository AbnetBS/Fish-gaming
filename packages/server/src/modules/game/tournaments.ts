import type { Database } from '../../db/index.js';
import { AppError, badRequest, insufficientFunds, notFound } from '../../lib/errors.js';
import { uid } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { writeAudit } from '../../lib/audit.js';
import { getActiveConfiguration, isMaintenanceMode } from '../config/service.js';
import { ensureActiveRound, closeActiveRound } from './round.js';
import { credit, getWallet } from '../wallet/ledger.js';
import type { TournamentDetail, TournamentEntryView, TournamentStatus, TournamentSummary } from '@reef/shared';

/**
 * ---------------------------------------------------------------------------
 * TOURNAMENTS — entry-fee matches, winner takes the pot minus operator rake
 * ---------------------------------------------------------------------------
 *
 * A tournament is a fixed-size, fixed-duration match:
 *  1. LOBBY — seats fill up; each seat pays `entry_fee` into `prize_pool`.
 *     The lobby auto-starts when full, or when `lobby_ends_at` passes with at
 *     least `min_players` seated (otherwise everybody is refunded).
 *  2. RUNNING — entrants play in a private arena with free shots and one fixed
 *     cannon (same weapon for everybody, so the entry fee is the only stake).
 *     Kills score points instead of paying the wallet.
 *  3. SETTLED — highest score wins `prize_pool − rake`; the operator keeps
 *     `rake` (whole-percent `rake_bps`, snapshotted at creation).
 *
 * Money invariants (all DEMO COINS, like the rest of the platform):
 *  - entry fees are BET debits, prizes are WIN credits, lobby refunds are
 *    REFUND credits — every coin movement is a ledger row, so the admin
 *    reconciliation (`verifyLedgerIntegrity`) keeps passing;
 *  - every ledger write carries a deterministic idempotency key, so joining,
 *    settling or sweeping twice can never move money twice;
 *  - settlement is one transaction guarded by `status = 'RUNNING'`, so the
 *    tick loop, the sweep and an admin retry cannot pay the prize twice.
 */

export interface CreateTournamentInput {
  name: string;
  entryFee: number;
  minPlayers: number;
  maxPlayers: number;
  durationS: number;
  /** Operator rake in whole percent (0-90). */
  rakePct: number;
  cannonKey: string;
  /** Minutes the lobby stays open before it starts-or-refunds. */
  lobbyMinutes: number;
  spawnRateMultiplier?: number;
}

export interface SettlementResult {
  tournamentId: string;
  status: TournamentStatus;
  winnerUserId: string | null;
  winnerUsername: string | null;
  pot: number;
  rake: number;
  prize: number;
  standings: TournamentEntryView[];
}

const HOUSE_BALANCE_KEY = 'house_demo_balance';

function nowIso(): string {
  return new Date().toISOString();
}

function cannonName(db: Database, key: string): string {
  return db.get<{ name: string }>('SELECT name FROM cannons WHERE key = ?', key)?.name ?? key;
}

function entryCount(db: Database, tournamentId: string): number {
  return db.scalar<number>('SELECT COUNT(*) FROM tournament_entries WHERE tournament_id = ?', tournamentId) ?? 0;
}

/** Live ranking: score first, then kills, then efficiency, then earliest seat. */
export function standingsFor(db: Database, tournamentId: string, meId?: string | null): TournamentEntryView[] {
  const rows = db.all<any>(
    `SELECT e.*, u.username, u.avatar_seed
     FROM tournament_entries e JOIN users u ON u.id = e.user_id
     WHERE e.tournament_id = ?
     ORDER BY e.score DESC, e.kills DESC, e.shots ASC, e.joined_at ASC, e.user_id ASC`,
    tournamentId,
  );
  return rows.map((r, i) => ({
    userId: r.user_id,
    username: r.username,
    avatarSeed: r.avatar_seed,
    score: r.score,
    kills: r.kills,
    shots: r.shots,
    prize: r.prize,
    rank: r.rank ?? i + 1,
    joinedAt: r.joined_at,
    me: meId != null && r.user_id === meId,
  }));
}

function mapSummary(db: Database, row: any, meId?: string | null): TournamentSummary {
  const standings = standingsFor(db, row.id, meId);
  return {
    id: row.id,
    name: row.name,
    status: row.status as TournamentStatus,
    entryFee: row.entry_fee,
    minPlayers: row.min_players,
    maxPlayers: row.max_players,
    seatsTaken: standings.length,
    durationS: row.duration_s,
    rakePct: Math.round(row.rake_bps / 100),
    prizePool: row.prize_pool,
    cannonKey: row.cannon_key,
    cannonName: cannonName(db, row.cannon_key),
    lobbyEndsAt: row.lobby_ends_at,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    winnerUsername: row.winner_username ?? null,
    myEntry: meId ? (standings.find((s) => s.userId === meId) ?? null) : null,
  };
}

function winnerName(db: Database, winnerId: string | null): string | null {
  if (!winnerId) return null;
  return db.get<{ username: string }>('SELECT username FROM users WHERE id = ?', winnerId)?.username ?? null;
}

/* --------------------------------- create --------------------------------- */

export function createTournament(
  db: Database,
  admin: { id: string; username: string | null; ip?: string | null },
  input: CreateTournamentInput,
): TournamentSummary {
  const name = input.name?.trim() ?? '';
  if (name.length < 3 || name.length > 48) throw badRequest('Tournament name must be 3-48 characters.');
  if (!Number.isInteger(input.entryFee) || input.entryFee < 1 || input.entryFee > 1_000_000) {
    throw badRequest('Entry fee must be 1-1,000,000 whole demo coins.');
  }
  if (!Number.isInteger(input.minPlayers) || input.minPlayers < 2 || input.minPlayers > 8) {
    throw badRequest('Minimum players must be 2-8.');
  }
  if (!Number.isInteger(input.maxPlayers) || input.maxPlayers < input.minPlayers || input.maxPlayers > 8) {
    throw badRequest('Maximum players must be between the minimum and 8.');
  }
  if (!Number.isInteger(input.durationS) || input.durationS < 60 || input.durationS > 3600) {
    throw badRequest('Duration must be 60-3600 seconds.');
  }
  if (!Number.isInteger(input.rakePct) || input.rakePct < 0 || input.rakePct > 90) {
    throw badRequest('Operator rake must be 0-90 percent.');
  }
  const cannon = db.get<{ key: string; enabled: number }>('SELECT key, enabled FROM cannons WHERE key = ?', input.cannonKey);
  if (!cannon || !cannon.enabled) throw badRequest('That tournament cannon is not available.');
  if (!Number.isInteger(input.lobbyMinutes) || input.lobbyMinutes < 1 || input.lobbyMinutes > 180) {
    throw badRequest('Lobby time must be 1-180 minutes.');
  }
  const spawn = input.spawnRateMultiplier ?? 1.15;
  if (!Number.isFinite(spawn) || spawn < 0.5 || spawn > 3) throw badRequest('Spawn multiplier must be 0.5-3.');

  const timestamp = nowIso();
  const id = uid('tny');
  const arenaId = uid('rm');

  return db.transaction(() => {
    // The arena is a real room row (sessions/rounds/shots reference it), but it
    // is hidden from every room list by the tournaments join — players only
    // ever see the tournament, never the arena.
    db.run(
      `INSERT INTO game_rooms (id, key, name, description, min_bet, max_bet, max_players, fish_pool, spawn_rate_multiplier, status, created_at, updated_at)
       VALUES (?,?,?,? ,1,1000000,?, '[]', ?, 'ACTIVE', ?, ?)`,
      arenaId,
      `arena_${id}`,
      `Arena · ${name}`.slice(0, 80),
      `Private arena for tournament ${name}`.slice(0, 200),
      input.maxPlayers,
      spawn,
      timestamp,
      timestamp,
    );
    db.run(
      `INSERT INTO tournaments (id, name, status, arena_room_id, entry_fee, min_players, max_players, duration_s, rake_bps,
        cannon_key, config_version, prize_pool, rake_amount, lobby_ends_at, created_by, created_at)
       VALUES (?,?, 'LOBBY', ?,?,?,?,?,?,?,'',0,0,?,?,?)`,
      id,
      name,
      arenaId,
      input.entryFee,
      input.minPlayers,
      input.maxPlayers,
      input.durationS,
      input.rakePct * 100,
      input.cannonKey,
      new Date(Date.now() + input.lobbyMinutes * 60_000).toISOString(),
      admin.id,
      timestamp,
    );
    writeAudit(db, {
      adminId: admin.id,
      adminUsername: admin.username,
      action: 'TOURNAMENT_CREATE',
      entity: 'tournaments',
      entityId: id,
      newValue: { ...input, name },
      ip: admin.ip ?? null,
    });
    const row = db.get<any>('SELECT * FROM tournaments WHERE id = ?', id)!;
    return mapSummary(db, row);
  });
}

/* ---------------------------------- read ---------------------------------- */

export function listPublicTournaments(db: Database, meId?: string | null): TournamentSummary[] {
  const rows = db.all<any>(
    `SELECT * FROM tournaments WHERE status IN ('LOBBY','RUNNING') ORDER BY
       CASE status WHEN 'LOBBY' THEN 0 ELSE 1 END, created_at DESC LIMIT 50`,
  );
  return rows.map((r) => mapSummary(db, { ...r, winner_username: winnerName(db, r.winner_user_id) }, meId));
}

export function listAllTournaments(db: Database, status?: TournamentStatus | 'ALL'): TournamentSummary[] {
  const rows =
    status && status !== 'ALL'
      ? db.all<any>('SELECT * FROM tournaments WHERE status = ? ORDER BY created_at DESC LIMIT 100', status)
      : db.all<any>('SELECT * FROM tournaments ORDER BY created_at DESC LIMIT 100');
  return rows.map((r) => mapSummary(db, { ...r, winner_username: winnerName(db, r.winner_user_id) }));
}

export function getTournamentDetail(db: Database, id: string, meId?: string | null): TournamentDetail {
  const row = db.get<any>('SELECT * FROM tournaments WHERE id = ?', id);
  if (!row) throw notFound('Tournament not found.');
  const summary = mapSummary(db, { ...row, winner_username: winnerName(db, row.winner_user_id) }, meId);
  return {
    ...summary,
    standings: standingsFor(db, id, meId),
    rakeAmount: row.rake_amount,
    createdAt: row.created_at,
  };
}

export function myTournaments(db: Database, userId: string): TournamentSummary[] {
  const rows = db.all<any>(
    `SELECT t.* FROM tournaments t
     JOIN tournament_entries e ON e.tournament_id = t.id
     WHERE e.user_id = ? ORDER BY t.created_at DESC LIMIT 50`,
    userId,
  );
  return rows.map((r) => mapSummary(db, { ...r, winner_username: winnerName(db, r.winner_user_id) }, userId));
}

/** Resolve the live tournament (if any) that owns an arena room. */
export function tournamentForArena(db: Database, arenaRoomId: string): { id: string; status: TournamentStatus } | null {
  const row = db.get<{ id: string; status: TournamentStatus }>('SELECT id, status FROM tournaments WHERE arena_room_id = ?', arenaRoomId);
  return row ?? null;
}

export function arenaRoomIdFor(db: Database, tournamentId: string): string {
  const row = db.get<{ arena_room_id: string }>('SELECT arena_room_id FROM tournaments WHERE id = ?', tournamentId);
  if (!row) throw notFound('Tournament not found.');
  return row.arena_room_id;
}

export function houseRakeTotal(db: Database): { settled: number; rake: number; houseBalance: number } {
  const row = db.get<{ n: number; rake: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(rake_amount),0) AS rake FROM tournaments WHERE status = 'SETTLED'`,
  );
  const house =
    db.scalar<string>(`SELECT value FROM system_settings WHERE key = '${HOUSE_BALANCE_KEY}'`) ?? '0';
  return { settled: row?.n ?? 0, rake: row?.rake ?? 0, houseBalance: Number.parseInt(house, 10) || 0 };
}

/* ---------------------------------- join ---------------------------------- */

export interface JoinOutcome {
  tournament: TournamentSummary;
  balance: number;
  /** True when this seat filled the lobby and the match started immediately. */
  started: boolean;
}

export function joinTournament(db: Database, userId: string, tournamentId: string): JoinOutcome {
  if (isMaintenanceMode(db)) throw new AppError(409, 'MAINTENANCE', 'The game is under maintenance. Please try again shortly.');
  const account = db.get<{ status: string }>('SELECT status FROM users WHERE id = ?', userId);
  if (!account) throw notFound('Account not found.');
  if (account.status === 'SUSPENDED') throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');

  const row = db.get<any>('SELECT * FROM tournaments WHERE id = ?', tournamentId);
  if (!row) throw notFound('Tournament not found.');
  if (row.status !== 'LOBBY') {
    throw new AppError(
      409,
      row.status === 'RUNNING' ? 'TOURNAMENT_STARTED' : 'TOURNAMENT_CLOSED',
      row.status === 'RUNNING' ? 'That tournament has already started.' : 'That tournament is no longer open.',
    );
  }

  const outcome = db.transaction(() => {
    const fresh = db.get<any>('SELECT * FROM tournaments WHERE id = ?', tournamentId)!;
    if (fresh.status !== 'LOBBY') {
      throw new AppError(409, 'TOURNAMENT_CLOSED', 'That tournament is no longer open.');
    }
    const existing = db.get('SELECT 1 FROM tournament_entries WHERE tournament_id = ? AND user_id = ?', tournamentId, userId);
    if (existing) throw new AppError(409, 'ALREADY_ENTERED', 'You already hold a seat in this tournament.');
    // One live tournament at a time: a player cannot be in two arenas at once.
    const busy = db.scalar<number>(
      `SELECT COUNT(*) FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id
       WHERE e.user_id = ? AND t.status IN ('LOBBY','RUNNING')`,
      userId,
    );
    if ((busy ?? 0) > 0) throw new AppError(409, 'TOURNAMENT_BUSY', 'Finish your current tournament before entering another.');
    const seats = entryCount(db, tournamentId);
    if (seats >= fresh.max_players) throw new AppError(409, 'TOURNAMENT_FULL', 'That tournament is full.');

    const wallet = getWallet(db, userId);
    if (wallet.balance < fresh.entry_fee) {
      throw insufficientFunds(`You need ${fresh.entry_fee} demo coins to enter — your balance is ${wallet.balance}.`);
    }
    // Entry fee: a BET debit with a deterministic key, so a retried join can
    // never charge twice (nested savepoint joins this transaction).
    const charged = credit(db, {
      userId,
      amount: -fresh.entry_fee,
      type: 'BET',
      referenceId: `tny-entry:${tournamentId}`,
      idempotencyKey: `tny-entry:${tournamentId}:${userId}`,
      description: `Tournament entry: ${fresh.name}`,
    });
    if (charged.replayed) {
      // Paid before but the seat write was lost: repair by seating now.
      logger.warn('Tournament entry payment replayed; reseating player', { tournament: tournamentId, user: userId });
    }
    const timestamp = nowIso();
    db.run(
      `INSERT INTO tournament_entries (id, tournament_id, user_id, score, kills, shots, prize, joined_at)
       VALUES (?,?,?,0,0,0,0,?)`,
      uid('tne'),
      tournamentId,
      userId,
      timestamp,
    );
    db.run('UPDATE tournaments SET prize_pool = prize_pool + ? WHERE id = ?', fresh.entry_fee, tournamentId);
    return { seatsTaken: seats + 1, balance: charged.wallet.balance };
  });

  // A full lobby starts immediately — no waiting on a timer.
  let started = false;
  if (outcome.seatsTaken >= row.max_players) {
    startTournament(db, tournamentId, { auto: true });
    started = true;
  }
  const detail = getTournamentDetail(db, tournamentId, userId);
  return { tournament: detail, balance: outcome.balance, started };
}

export function leaveTournament(db: Database, userId: string, tournamentId: string): { refunded: number; balance: number } {
  const row = db.get<any>('SELECT * FROM tournaments WHERE id = ?', tournamentId);
  if (!row) throw notFound('Tournament not found.');
  const entry = db.get('SELECT id FROM tournament_entries WHERE tournament_id = ? AND user_id = ?', tournamentId, userId);
  if (!entry) throw new AppError(409, 'NOT_ENTERED', 'You do not hold a seat in this tournament.');
  if (row.status !== 'LOBBY') {
    throw new AppError(409, 'TOURNAMENT_STARTED', 'The tournament has started — your entry is locked in the prize pool.');
  }
  return db.transaction(() => {
    const fresh = db.get<any>('SELECT * FROM tournaments WHERE id = ?', tournamentId)!;
    if (fresh.status !== 'LOBBY') throw new AppError(409, 'TOURNAMENT_STARTED', 'The tournament has started — your entry is locked.');
    const refunded = credit(db, {
      userId,
      amount: fresh.entry_fee,
      type: 'REFUND',
      referenceId: `tny-refund:${tournamentId}`,
      idempotencyKey: `tny-refund:${tournamentId}:${userId}`,
      description: `Tournament entry refund: ${fresh.name}`,
    });
    db.run('DELETE FROM tournament_entries WHERE tournament_id = ? AND user_id = ?', tournamentId, userId);
    db.run('UPDATE tournaments SET prize_pool = MAX(0, prize_pool - ?) WHERE id = ?', fresh.entry_fee, tournamentId);
    return { refunded: refunded.replayed ? 0 : fresh.entry_fee, balance: refunded.wallet.balance };
  });
}

/* ------------------------------ start / cancel ------------------------------ */

export function startTournament(db: Database, tournamentId: string, opts: { auto?: boolean; admin?: { id: string; username: string | null; ip?: string | null } } = {}): TournamentSummary {
  const started = db.transaction(() => {
    const row = db.get<any>('SELECT * FROM tournaments WHERE id = ?', tournamentId);
    if (!row) throw notFound('Tournament not found.');
    if (row.status === 'RUNNING') return { already: true as const };
    if (row.status !== 'LOBBY') throw new AppError(409, 'TOURNAMENT_CLOSED', 'Only a lobby can be started.');
    const seats = entryCount(db, tournamentId);
    if (seats < row.min_players) {
      throw new AppError(409, 'TOURNAMENT_SHORT', `Need at least ${row.min_players} players to start (seated: ${seats}).`);
    }
    const timestamp = nowIso();
    const endsAt = new Date(Date.now() + row.duration_s * 1000).toISOString();
    const config = getActiveConfiguration(db);
    db.run(`UPDATE tournaments SET status = 'RUNNING', starts_at = ?, ends_at = ?, config_version = ? WHERE id = ?`, timestamp, endsAt, config.version, tournamentId);
    // Pin the round + configuration at start time, so a publish mid-match can
    // never change the arena under the players.
    ensureActiveRound(db, row.arena_room_id);
    if (opts.admin) {
      writeAudit(db, {
        adminId: opts.admin.id,
        adminUsername: opts.admin.username,
        action: 'TOURNAMENT_START',
        entity: 'tournaments',
        entityId: tournamentId,
        newValue: { seats, auto: false },
        ip: opts.admin.ip ?? null,
      });
    }
    logger.info('Tournament started', { tournament: tournamentId, seats, auto: opts.auto === true });
    return { already: false as const };
  });
  void started;
  return getTournamentDetail(db, tournamentId);
}

export function cancelTournament(
  db: Database,
  tournamentId: string,
  actor: { id: string | null; username: string | null; ip?: string | null; reason?: string },
): { refunded: number; players: number } {
  return db.transaction(() => {
    const row = db.get<any>('SELECT * FROM tournaments WHERE id = ?', tournamentId);
    if (!row) throw notFound('Tournament not found.');
    if (row.status !== 'LOBBY') throw new AppError(409, 'TOURNAMENT_CLOSED', 'Only a lobby can be cancelled.');
    const entries = db.all<{ user_id: string }>('SELECT user_id FROM tournament_entries WHERE tournament_id = ?', tournamentId);
    let refunded = 0;
    for (const entry of entries) {
      const result = credit(db, {
        userId: entry.user_id,
        amount: row.entry_fee,
        type: 'REFUND',
        referenceId: `tny-refund:${tournamentId}`,
        idempotencyKey: `tny-refund:${tournamentId}:${entry.user_id}`,
        description: `Tournament cancelled — entry refund: ${row.name}`,
      });
      if (!result.replayed) refunded += row.entry_fee;
    }
    db.run(`UPDATE tournaments SET status = 'CANCELLED', prize_pool = 0 WHERE id = ?`, tournamentId);
    db.run(`UPDATE game_rooms SET status = 'INACTIVE' WHERE id = ?`, row.arena_room_id);
    writeAudit(db, {
      adminId: actor.id,
      adminUsername: actor.username,
      action: 'TOURNAMENT_CANCEL',
      entity: 'tournaments',
      entityId: tournamentId,
      newValue: { players: entries.length, refunded, reason: actor.reason ?? null },
      ip: actor.ip ?? null,
    });
    logger.info('Tournament cancelled', { tournament: tournamentId, players: entries.length, refunded });
    return { refunded, players: entries.length };
  });
}

/* --------------------------------- settle --------------------------------- */

export function settleTournament(db: Database, tournamentId: string): SettlementResult {
  return db.transaction(() => {
    const row = db.get<any>('SELECT * FROM tournaments WHERE id = ?', tournamentId);
    if (!row) throw notFound('Tournament not found.');
    if (row.status === 'SETTLED') {
      const standings = standingsFor(db, tournamentId);
      const winner = standings.find((s) => s.userId === row.winner_user_id) ?? standings[0];
      return {
        tournamentId,
        status: 'SETTLED',
        winnerUserId: row.winner_user_id,
        winnerUsername: winner?.username ?? null,
        pot: row.prize_pool + row.rake_amount,
        rake: row.rake_amount,
        prize: winner?.prize ?? 0,
        standings,
      };
    }
    if (row.status !== 'RUNNING') {
      throw new AppError(409, 'TOURNAMENT_CLOSED', 'Only a running tournament can be settled.');
    }
    const standings = standingsFor(db, tournamentId);
    if (!standings.length) {
      // Defensive: a started tournament always has seats, but never pay a prize
      // into the void if the data disagrees.
      db.run(`UPDATE tournaments SET status = 'CANCELLED' WHERE id = ?`, tournamentId);
      db.run(`UPDATE game_rooms SET status = 'INACTIVE' WHERE id = ?`, row.arena_room_id);
      return { tournamentId, status: 'CANCELLED', winnerUserId: null, winnerUsername: null, pot: 0, rake: 0, prize: 0, standings: [] };
    }
    const pot = row.prize_pool;
    const rake = Math.floor((pot * row.rake_bps) / 10_000);
    const prize = pot - rake;
    const winner = standings[0]!;

    if (prize > 0) {
      // Deterministic key: settling twice pays once.
      credit(db, {
        userId: winner.userId,
        amount: prize,
        type: 'WIN',
        referenceId: `tny-prize:${tournamentId}`,
        gameRoundId: null,
        idempotencyKey: `tny-prize:${tournamentId}`,
        description: `Tournament win: ${row.name}`,
      });
    }
    standings.forEach((entry, index) => {
      db.run('UPDATE tournament_entries SET rank = ?, prize = ? WHERE tournament_id = ? AND user_id = ?', index + 1, entry.userId === winner.userId ? prize : 0, tournamentId, entry.userId);
      entry.rank = index + 1;
      entry.prize = entry.userId === winner.userId ? prize : 0;
    });
    const timestamp = nowIso();
    db.run(
      `UPDATE tournaments SET status = 'SETTLED', winner_user_id = ?, rake_amount = ?, settled_at = ? WHERE id = ?`,
      winner.userId,
      rake,
      timestamp,
      tournamentId,
    );
    if (rake > 0) {
      db.run(
        `INSERT INTO system_settings (key, value, description, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?, updated_at = ?`,
        HOUSE_BALANCE_KEY,
        String(rake),
        'Accumulated operator rake from settled tournaments (demo coins)',
        timestamp,
        rake,
        timestamp,
      );
    }
    closeActiveRound(db, row.arena_room_id, 'TOURNAMENT_COMPLETE', undefined, { endSessions: true });
    db.run(`UPDATE game_rooms SET status = 'INACTIVE' WHERE id = ?`, row.arena_room_id);
    logger.info('Tournament settled', { tournament: tournamentId, winner: winner.username, pot, rake, prize });
    return { tournamentId, status: 'SETTLED', winnerUserId: winner.userId, winnerUsername: winner.username, pot, rake, prize, standings };
  });
}

/* ----------------------------- scoring + sweep ----------------------------- */

/** A kill inside an arena scores points instead of paying the wallet. */
export function recordTournamentKill(db: Database, tournamentId: string, userId: string, points: number): void {
  db.run('UPDATE tournament_entries SET score = score + ?, kills = kills + 1 WHERE tournament_id = ? AND user_id = ?', points, tournamentId, userId);
}

/** Every arena shot counts toward the efficiency tie-break. */
export function recordTournamentShot(db: Database, tournamentId: string, userId: string): void {
  db.run('UPDATE tournament_entries SET shots = shots + 1 WHERE tournament_id = ? AND user_id = ?', tournamentId, userId);
}

export interface SweepOutcome {
  started: string[];
  cancelled: string[];
  settled: string[];
}

/**
 * Periodic maintenance, called from the tick loop:
 *  - expired lobbies start (enough seats) or refund everybody (too few);
 *  - expired RUNNING tournaments with no live arena (e.g. after a restart)
 *    are settled from the frozen scores so prizes are never stuck.
 */
export function sweepTournaments(db: Database, liveTournamentIds: Set<string>): SweepOutcome {
  const outcome: SweepOutcome = { started: [], cancelled: [], settled: [] };
  const timestamp = nowIso();
  const expiredLobbies = db.all<{ id: string }>(`SELECT id FROM tournaments WHERE status = 'LOBBY' AND lobby_ends_at <= ?`, timestamp);
  for (const lobby of expiredLobbies) {
    try {
      const row = db.get<any>('SELECT min_players FROM tournaments WHERE id = ?', lobby.id)!;
      if (entryCount(db, lobby.id) >= row.min_players) {
        startTournament(db, lobby.id, { auto: true });
        outcome.started.push(lobby.id);
      } else {
        cancelTournament(db, lobby.id, { id: null, username: null, reason: 'Lobby expired without enough players.' });
        outcome.cancelled.push(lobby.id);
      }
    } catch (err) {
      logger.warn('Tournament lobby sweep failed', { tournament: lobby.id, err: String(err) });
    }
  }
  const orphans = db.all<{ id: string }>(`SELECT id FROM tournaments WHERE status = 'RUNNING' AND ends_at <= ?`, timestamp);
  for (const orphan of orphans) {
    if (liveTournamentIds.has(orphan.id)) continue; // the arena tick settles live matches with a broadcast
    try {
      settleTournament(db, orphan.id);
      outcome.settled.push(orphan.id);
    } catch (err) {
      logger.warn('Tournament orphan settle failed', { tournament: orphan.id, err: String(err) });
    }
  }
  return outcome;
}
