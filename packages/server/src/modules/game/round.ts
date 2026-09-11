import type { Database } from '../../db/index.js';
import { getActiveConfiguration, getConfigurationVersion } from '../config/service.js';
import { newRoundId } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import type { GameConfiguration } from '@reef/shared';

/**
 * Round lifecycle, shared by the REST join path and the live simulation.
 *
 * Invariant: a room has at most one round in state ACTIVE. Both entry points go
 * through {@link ensureActiveRound}, so a durable `game_sessions` row can never
 * point at a round that does not exist, and a player joining over HTTP and a
 * player joining over the socket land in the *same* round — same id, same seed,
 * same configuration version.
 *
 * A round's configuration version is chosen once, at creation, and never
 * rewritten: publishing a new configuration cannot change a round in progress.
 */

export interface ActiveRound {
  roundId: string;
  configVersion: string;
  seed: number;
  startedAt: string;
  config: GameConfiguration;
  created: boolean;
}

function roundIdFor(db: Database): string {
  const year = new Date().getUTCFullYear();
  const max =
    db.scalar<number>(
      `SELECT COALESCE(MAX(CAST(substr(id, -6) AS INTEGER)), 0) FROM game_rounds WHERE id LIKE ?`,
      `RND-${year}-%`,
    ) ?? 0;
  return newRoundId(max + 1, year);
}

export function ensureActiveRound(db: Database, roomId: string): ActiveRound {
  const existing = db.get<{ id: string; config_version: string; seed: number; started_at: string }>(
    `SELECT id, config_version, seed, started_at FROM game_rounds
     WHERE room_id = ? AND status = 'ACTIVE' ORDER BY started_at DESC LIMIT 1`,
    roomId,
  );
  if (existing) {
    const pinned = getConfigurationVersion(db, existing.config_version) ?? getActiveConfiguration(db);
    return {
      roundId: existing.id,
      configVersion: existing.config_version,
      seed: existing.seed,
      startedAt: existing.started_at,
      config: pinned,
      created: false,
    };
  }

  const config = getActiveConfiguration(db);
  const roundId = roundIdFor(db);
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
    `INSERT INTO game_events (id, round_id, room_id, user_id, event_type, config_version, metadata, created_at)
     VALUES (?,?,?,NULL, 'ROUND_STARTED', ?,?,?)`,
    `ev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    roundId,
    roomId,
    config.version,
    JSON.stringify({ seed, configVersion: config.version, species: config.fish.filter((f) => f.enabled).length }),
    timestamp,
  );
  logger.debug('Round created', { roomId, roundId, config: config.version, seed });
  return { roundId, configVersion: config.version, seed, startedAt: timestamp, config, created: true };
}

/**
 * End the room's active round. Used by rollover, maintenance, room shutdown and
 * process exit. Also closes any sessions still attached to that round so no
 * session can point at a dead round.
 */
export function closeActiveRound(
  db: Database,
  roomId: string,
  reason: string,
  totals?: { shots: number; wagered: number; rewarded: number },
  options: { endSessions?: boolean } = {},
): string | null {
  const active = db.get<{ id: string; config_version: string; total_shots: number; total_wagered: number; total_rewarded: number }>(
    "SELECT id, config_version, total_shots, total_wagered, total_rewarded FROM game_rounds WHERE room_id = ? AND status = 'ACTIVE' ORDER BY started_at DESC LIMIT 1",
    roomId,
  );
  if (!active) return null;
  const timestamp = new Date().toISOString();
  db.run(
    `UPDATE game_rounds SET status = 'ENDED', ended_at = ?, total_shots = ?, total_wagered = ?, total_rewarded = ? WHERE id = ?`,
    timestamp,
    totals?.shots ?? active.total_shots,
    totals?.wagered ?? active.total_wagered,
    totals?.rewarded ?? active.total_rewarded,
    active.id,
  );
  db.run(
    `INSERT INTO game_events (id, round_id, room_id, user_id, event_type, config_version, metadata, created_at)
     VALUES (?,?,?,NULL, 'ROUND_ENDED', ?,?,?)`,
    `ev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    active.id,
    roomId,
    active.config_version,
    JSON.stringify({ reason, shots: totals?.shots ?? active.total_shots, wagered: totals?.wagered ?? active.total_wagered, rewarded: totals?.rewarded ?? active.total_rewarded }),
    timestamp,
  );
  if (options.endSessions !== false) {
    db.run("UPDATE game_sessions SET status = 'ENDED', ended_at = ? WHERE round_id = ? AND status = 'ACTIVE'", timestamp, active.id);
  }
  return active.id;
}

export function activeRoundCount(db: Database): number {
  return db.scalar<number>("SELECT COUNT(*) FROM game_rounds WHERE status = 'ACTIVE'") ?? 0;
}
