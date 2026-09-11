import type { Database } from '../../db/index.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { writeAudit } from '../../lib/audit.js';

/**
 * ---------------------------------------------------------------------------
 * PLAYER PROTECTION — the code behind the responsible-gaming promises
 * ---------------------------------------------------------------------------
 * `profiles.session_limit_min` and `profiles.self_excluded_until` are not
 * display fields: they are read on the join path *and* on the shot path, so
 * the numbers a player chooses actually stop play. Nothing here depends on the
 * client co-operating — a client that never shows a countdown still cannot
 * fire past its limit.
 *
 * Two mechanisms:
 *
 *  1. **Daily play limit** (minutes). Time is summed from the player's
 *     `game_sessions` rows for the current UTC day plus the session they are in
 *     right now. When the allowance runs out the server closes the session and
 *     refuses further shots; the allowance resets at 00:00 UTC.
 *  2. **Self-exclusion** (24 h / 7 d / 30 d / 90 d). A player can start one at
 *     any time but cannot shorten it — only an admin holding `users:update` can
 *     lift it, and that write is audited. While it is active, joining a room
 *     and firing are both refused with an explicit reason instead of a silent
 *     failure.
 */

export type SelfExclusionDuration = '24h' | '7d' | '30d' | '90d';

export const SELF_EXCLUSION_MS: Record<SelfExclusionDuration, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

const MINUTE = 60_000;

export interface PlayLimits {
  /** 0 when the player has configured no limit. */
  limitMin: number;
  /** Whole minutes played today (rounded up, so a limit is never overshot). */
  minutesPlayedToday: number;
  /** Minutes of allowance left right now; `Infinity` when unlimited. */
  minutesRemaining: number;
  /** ISO timestamp while an exclusion is live, otherwise `null`. */
  selfExcludedUntil: string | null;
  accountStatus: string;
}

interface LimitRow {
  status: string;
  session_limit_min: number | null;
  self_excluded_until: string | null;
}

function readLimits(db: Database, userId: string): LimitRow | undefined {
  return db.get<LimitRow>(
    `SELECT u.status AS status,
            p.session_limit_min AS session_limit_min,
            p.self_excluded_until AS self_excluded_until
       FROM users u
       LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.id = ?`,
    userId,
  );
}

/**
 * Milliseconds played in the current UTC day. Sessions still open count up to
 * `now`. Summed in JS rather than with SQLite date functions so an injected
 * test clock drives it the same way it drives the simulation.
 */
export function msPlayedToday(db: Database, userId: string, nowMs = Date.now()): number {
  const dayStart = new Date(nowMs);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();
  const rows = db.all<{ started_at: string; ended_at: string | null }>(
    'SELECT started_at, ended_at FROM game_sessions WHERE user_id = ? AND started_at >= ? ORDER BY started_at',
    userId,
    dayStart.toISOString(),
  );
  let total = 0;
  for (const row of rows) {
    const from = Date.parse(row.started_at);
    if (!Number.isFinite(from)) continue;
    const to = row.ended_at ? Date.parse(row.ended_at) : nowMs;
    total += Math.max(0, Math.min(Number.isFinite(to) ? to : nowMs, nowMs) - Math.max(from, dayStartMs));
  }
  return total;
}

export function readPlayLimits(db: Database, userId: string, nowMs = Date.now()): PlayLimits {
  const row = readLimits(db, userId);
  const limitMin = Math.max(0, row?.session_limit_min ?? 0);
  const minutesPlayedToday = Math.ceil(msPlayedToday(db, userId, nowMs) / MINUTE);
  const raw = row?.self_excluded_until ?? null;
  return {
    limitMin,
    minutesPlayedToday,
    minutesRemaining: limitMin > 0 ? Math.max(0, limitMin - minutesPlayedToday) : Infinity,
    selfExcludedUntil: raw && Date.parse(raw) > nowMs ? raw : null,
    accountStatus: row?.status ?? 'ACTIVE',
  };
}

/**
 * Epoch ms at which this player's remaining daily allowance runs out, or `null`
 * when they have no limit. Computed once on join and then checked against the
 * in-memory deadline, so the shot path costs no extra queries.
 */
export function playDeadlineFor(db: Database, userId: string, nowMs = Date.now()): number | null {
  const limits = readPlayLimits(db, userId, nowMs);
  if (limits.limitMin <= 0 || !Number.isFinite(limits.minutesRemaining)) return null;
  const budgetMs = limits.limitMin * MINUTE;
  return nowMs + Math.max(0, budgetMs - msPlayedToday(db, userId, nowMs));
}

/** Throws unless this player may start (or continue) playing right now. */
export function assertPlayAllowed(db: Database, userId: string, nowMs = Date.now()): PlayLimits {
  const limits = readPlayLimits(db, userId, nowMs);
  if (limits.accountStatus !== 'ACTIVE') {
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account cannot play right now. Please contact support.');
  }
  if (limits.selfExcludedUntil) {
    throw new AppError(
      403,
      'SELF_EXCLUDED',
      `Self-exclusion is active until ${formatWhen(Date.parse(limits.selfExcludedUntil), nowMs)}. ` +
        'Only a support or compliance admin can lift it early.',
    );
  }
  if (limits.limitMin > 0 && limits.minutesRemaining <= 0) {
    throw new AppError(
      403,
      'SESSION_LIMIT_REACHED',
      `You have used your ${limits.limitMin}-minute daily play limit. Play unlocks again at 00:00 UTC.`,
    );
  }
  return limits;
}

/** Relative phrasing for the block card ("in 12 minutes", "in 3 hours", a date). */
export function formatWhen(epochMs: number, nowMs = Date.now()): string {
  const diff = Math.max(0, epochMs - nowMs);
  const minutes = Math.round(diff / MINUTE);
  if (minutes < 60) return `in ${Math.max(1, minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Player-initiated break. Always extends; a shorter request during an active
 * exclusion cannot cut it short, which is the whole point of the feature.
 */
export function requestSelfExclusion(
  db: Database,
  userId: string,
  duration: SelfExclusionDuration,
  actor: { id: string; username: string },
  nowMs = Date.now(),
): { until: string; duration: SelfExclusionDuration } {
  const span = SELF_EXCLUSION_MS[duration];
  if (!span) throw badRequest('Choose one of the offered break lengths.');
  const row = db.get<{ self_excluded_until: string | null }>('SELECT self_excluded_until FROM profiles WHERE user_id = ?', userId);
  if (!row) throw badRequest('Profile not found.');
  const existing = row.self_excluded_until ? Date.parse(row.self_excluded_until) : 0;
  const until = new Date(Math.max(Number.isFinite(existing) ? existing : 0, nowMs + span)).toISOString();
  const timestamp = new Date(nowMs).toISOString();
  db.transaction(() => {
    db.run('UPDATE profiles SET self_excluded_until = ?, updated_at = ? WHERE user_id = ?', until, timestamp, userId);
    writeAudit(db, {
      adminId: actor.id,
      adminUsername: actor.username,
      action: 'player.self_exclusion.start',
      entity: 'user',
      entityId: userId,
      previousValue: { selfExcludedUntil: row.self_excluded_until ?? null },
      newValue: { selfExcludedUntil: until },
      metadata: { duration, initiatedBy: 'player' },
    });
  });
  return { until, duration };
}

/** Admin/compliance lift. Refuses to pretend when nothing was excluded. */
export function liftSelfExclusion(
  db: Database,
  userId: string,
  actor: { id: string; username: string },
  reason: string,
  nowMs = Date.now(),
): void {
  const justification = reason.trim();
  if (justification.length < 5) {
    throw badRequest('A reason of at least 5 characters is required — it is written to the audit log.');
  }
  const row = db.get<{ self_excluded_until: string | null }>('SELECT self_excluded_until FROM profiles WHERE user_id = ?', userId);
  if (!row?.self_excluded_until) throw badRequest('That account is not self-excluded.');
  const timestamp = new Date(nowMs).toISOString();
  db.transaction(() => {
    db.run('UPDATE profiles SET self_excluded_until = NULL, updated_at = ? WHERE user_id = ?', timestamp, userId);
    writeAudit(db, {
      adminId: actor.id,
      adminUsername: actor.username,
      action: 'admin.self_exclusion.lift',
      entity: 'user',
      entityId: userId,
      previousValue: { selfExcludedUntil: row.self_excluded_until },
      newValue: { selfExcludedUntil: null },
      metadata: { reason: justification, initiatedBy: 'admin' },
    });
  });
}
