import type { Database } from '../../db/index.js';
import { getActiveConfiguration } from '../config/service.js';
import { newRoundId } from '../../lib/ids.js';

/**
 * Round lifecycle helpers shared by the REST join path and the live simulation.
 *
 * A room always has exactly one ACTIVE round. Creating it here (rather than
 * only inside the round manager) means a durable session can never be written
 * with a dangling `round_id`, and it means two players entering through
 * different transports — one over HTTP, one over the socket — land in the *same*
 * round with the same seed and the same configuration version.
 */

export interface ActiveRound {
  roundId: string;
  configVersion: string;
  seed: number;
  startedAt: string;
  created: boolean;
}

let sequence = 1;

/** Next round id for the current year. Ids are unique per process; the primary
 *  key makes collisions impossible across restarts because the id also carries
 *  the timestamp-free year and we continue from any existing maximum. */
export function nextRoundSequence(db: Database): number {
  const currentYear = new Date().getUTCFullYear();
  const max =
    db.scalar<number>(
      `SELECT COALESCE(MAX(CAST(substr(id, -6) AS INTEGER)), 0) FROM game_rounds WHERE id LIKE ?`,
      `RND-${currentYear}-%`,
    ) ?? 0;
  sequence = Math.max(sequence, max + 1);
  return sequence;
}

export function ensureActiveRound(db: Database, roomId: string): ActiveRound {
  const existing = db.get<{ id: string; config_version: string; seed: number; started_at: string }>(
    "SELECT id, config_version, seed, started_at FROM game_rounds WHERE room_id = ? AND status = 'ACTIVE' ORDER BY started_at DESC LIMIT 1",
    roomId,
  );
  if (existing) {
    return {
      roundId: existing.id,
      configVersion: existing.config_version,
      seed: existing.seed,
      startedAt: existing.started_at,
      created: false,
    };
  }

  const config = getActiveConfiguration(db);
  const roundId = newRoundId(nextRoundSequence(db) + 1, new Date().getUTCFullYear());
  const seed = ((Date.now() % 2147483647) ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
  const timestamp = new Date().toISOString();
  db.run(
    `INSERT INTO game_rounds (id, room_id, status, seed, config_version, started_at, total_shots, total_wagered, total_rewarded)
     VALUES (?,?, 'ACTIVE', ?,?,?,0,0,0)`,
    roundId,
    roomId,
    seed,
    config.version,
    timestamp,
  );
  db.run(
    'INSERT INTO game_events (id, round_id, room_id, user_id, event_type, config_version, metadata, created_at) VALUES (?,?,?,NULL,?,?,?,?,?)',
    `ev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    roundId,
    roomId,
    'ROUND_STARTED',
    config.version,
    JSON.stringify({ seed, configVersion: config.version, origin: 'ensureActiveRound' }),
    timestamp,
  );
  return { roundId, configVersion: config.version, seed, startedAt: timestamp, created: true };
}

/** Close the room's active round (used by maintenance, room deactivation and shutdown). */
export function closeActiveRound(db: Database, roomId: string, reason: string, totals?: { shots: number; wagered: number; rewarded: number }): void {
  const active = db.get<{ id: string }>("SELECT id FROM game_rounds WHERE room_id = ? AND status = 'ACTIVE'", roomId);
  if (!active) return;
  const timestamp = new Date().toISOString();
  db.run(
    `UPDATE game_rounds SET status = 'ENDED', ended_at = ?, total_shots = COALESCE(?, total_shots), total_wagered = COALESCE(?, total_wagered),
            total_rewarded = COALESCE(?, total_rewarded) WHERE id = ?`,
    timestamp,
    totals?.shots ?? null,
    totals?.wagered ?? null,
    totals?.rewarded ?? null,
    active.id,
  );
  db.run(
    'INSERT INTO game_events (id, round_id, room_id, user_id, event_type, config_version, metadata, created_at) VALUES (?,?,?,NULL,?,?,?,?,?)',
    `ev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    active.id,
    roomId,
    'ROUND_ENDED',
    db.get<{ config_version: string }>('SELECT config_version FROM game_rounds WHERE id = ?', active.id)?.config_version ?? null,
    JSON.stringify({ reason, totals: totals ?? null }),
    timestamp,
  );
  db.run("UPDATE game_sessions SET status = 'ENDED', ended_at = ? WHERE round_id = ? AND status = 'ACTIVE'", timestamp, active.id);
}

export function openRoundCount(db: Database): number {
  return db.scalar<number>("SELECT COUNT(*) FROM game_rounds WHERE status = 'ACTIVE'") ?? 0;
}
