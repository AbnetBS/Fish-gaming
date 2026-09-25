import { uid } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import { getActiveConfiguration, getConfigurationVersion } from '../modules/config/service.js';
import { closeActiveRound, ensureActiveRound } from '../modules/game/round.js';
import {
  recordTournamentKill,
  recordTournamentShot,
  settleTournament,
  standingsFor,
  sweepTournaments,
} from '../modules/game/tournaments.js';
import { assertPlayAllowed, playDeadlineFor, readPlayLimits } from '../modules/game/limits.js';
import { RoomSimulation, type SimPlayer } from './room-simulation.js';
import type { Database } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import type { GameConfiguration, RoomSnapshot, ServerMessage } from '@reef/shared';

/**
 * ---------------------------------------------------------------------------
 * ROUND MANAGER
 * ---------------------------------------------------------------------------
 * Owns one {@link RoomSimulation} per live room plus the authoritative
 * transaction boundary for every action that touches the wallet.
 *
 * Security invariants enforced here (never delegated to the client):
 *  1. A shot requires an ACTIVE session in the room the socket is attached to.
 *  2. Cost, damage and reward always come from the *server-side* configuration,
 *     keyed by the round's pinned config version — never from the request body.
 *  3. `player_shots (user_id, client_ref)` is UNIQUE, so a retried fire request
 *     is answered with the original result instead of charging twice.
 *  4. Every reward is idempotent on the killing shot id (`win:<shotId>:<fishKey>`).
 *  5. The wallet debit and the shot row are written in one IMMEDIATE
 *     transaction, so a crash cannot leave a paid-for-but-unrecorded shot.
 */

export interface ClientConnection {
  ws: {
    readyState: number;
    send: (data: string) => void;
    close?: (code?: number, reason?: string) => void;
  };
  userId: string;
  username: string;
  avatarSeed: string;
  roomId: string | null;
  lastAngle: number;
  cannonKey: string;
  alive: boolean;
  lastBalance: number;
  pendingRefs: Map<string, number>;
  /**
   * Epoch ms at which this player's configured daily play allowance runs out
   * (`null`/`undefined` = no limit). Set when they attach, checked on every
   * shot so the limit is real even if the client ignores it.
   */
  playDeadlineMs?: number | null;
}

interface RoomRuntime {
  roomId: string;
  roomKey: string;
  roundId: string;
  config: GameConfiguration;
  sim: RoomSimulation;
  members: Set<ClientConnection>;
  startedAt: number;
  roundDurationMs: number;
  seed: number;
  eventBuffer: EventRow[];
  lastActivityAt: number;
  /** Guards the player-protection sweep so it runs at most every 2 s. */
  lastLimitSweepAt: number;
  totals: { shots: number; wagered: number; rewarded: number };
  /** Set when this runtime is a tournament arena (free shots + point scoring). */
  tournamentId: string | null;
  /** Frozen match end (epoch ms); null for normal rooms. */
  tournamentEndsAtMs: number | null;
}

interface EventRow {
  type: string;
  playerId: string | null;
  metadata: Record<string, unknown>;
}

export interface RoundManagerOptions {
  db: Database;
  tickMs: number;
  snapshotMs: number;
  roundDurationS: number;
  /** Freeze + close a room this many ms after its last spectator leaves. */
  idleFreezeMs?: number;
  /**
   * Clock handed to every room simulation. Production leaves this unset (wall
   * time); the test-suite injects a virtual clock so many seconds of simulation
   * can be stepped deterministically in a few milliseconds.
   */
  clock?: () => number;
}

interface ShotResolution {
  shotId: string;
  playerId: string;
  result: 'MISSED' | 'HIT' | 'KILL';
  reward: number;
  fishKey: string | null;
  fishName: string | null;
  roundId: string;
}

export interface RoomStatusView {
  roomId: string;
  roundId: string;
  configVersion: string;
  players: number;
  fish: number;
  projectiles: number;
  roundAgeMs: number;
  totals: { shots: number; wagered: number; rewarded: number };
}

export class RoundManager {
  private rooms = new Map<string, RoomRuntime>();
  private timer: NodeJS.Timeout | null = null;
  private lastBroadcastAt = new Map<string, number>();

  constructor(private readonly opts: RoundManagerOptions) {}

  /* --------------------------------- start --------------------------------- */

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tickAll();
      } catch (err) {
        logger.error('Tick loop error', { err: String(err) });
      }
    }, this.opts.tickMs);
    this.timer.unref?.();
    logger.info('Round manager started', { tickMs: this.opts.tickMs, snapshotMs: this.opts.snapshotMs });
  }

  /**
   * Advance every live room by one step. The interval loop calls this; tests
   * call it directly with a virtual clock.
   */
  tickOnce(dtMs = this.opts.tickMs): void {
    this.tickAll(dtMs);
  }

  /** Number of live rooms (used by monitoring and tests). */
  get roomCount(): number {
    return this.rooms.size;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const runtime of this.rooms.values()) this.endRound(runtime, 'SERVER_SHUTDOWN');
    this.rooms.clear();
  }

  /* ------------------------------ room lifecycle ------------------------------ */

  runtimeFor(roomId: string): RoomRuntime | undefined {
    return this.rooms.get(roomId);
  }

  /** Create (or fetch) the live runtime for a room, pinning the config version. */
  ensureRoom(roomId: string): RoomRuntime {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    const db = this.opts.db;
    const room = db.get<any>('SELECT * FROM game_rooms WHERE id = ?', roomId);
    if (!room) throw new AppError(404, 'NOT_FOUND', 'Game room not found.');
    if (room.status !== 'ACTIVE') throw new AppError(409, 'ROOM_UNAVAILABLE', 'This room is currently closed.');
    return this.openRuntime(room);
  }

  /**
   * Reconcile the in-memory runtimes with the database after a boot or a
   * configuration publish: rooms whose DB round ended are dropped, and rooms
   * with an ACTIVE round but no runtime get one lazily on next join.
   */
  reconcile(): void {
    const db = this.opts.db;
    for (const [roomId, runtime] of [...this.rooms.entries()]) {
      const stillOpen = db.scalar<number>("SELECT COUNT(*) FROM game_rounds WHERE id = ? AND status = 'ACTIVE'", runtime.roundId) ?? 0;
      if (!stillOpen && runtime.members.size === 0) {
        this.rooms.delete(roomId);
        this.lastBroadcastAt.delete(roomId);
      }
    }
  }

  /**
   * Open (or re-open) the runtime for a room on top of its ACTIVE round. The
   * round row itself is created by `ensureActiveRound`, which the REST join path
   * calls too, so a room never has two live rounds and a session can never point
   * at a round that does not exist.
   */
  private openRuntime(room: any): RoomRuntime {
    const db = this.opts.db;
    const round = ensureActiveRound(db, room.id);
    const config = round.config;

    const runtime: RoomRuntime = {
      roomId: room.id,
      roomKey: room.key,
      roundId: round.roundId,
      tournamentId: null,
      tournamentEndsAtMs: null,
      config,
      sim: null as unknown as RoomSimulation,
      members: new Set(),
      startedAt: Date.parse(round.startedAt) || Date.now(),
      roundDurationMs: Math.max(30, config.settings.roundDurationS ?? this.opts.roundDurationS) * 1000,
      seed: round.seed,
      eventBuffer: [],
      lastActivityAt: Date.now(),
      lastLimitSweepAt: 0,
      totals: round.created
        ? { shots: 0, wagered: 0, rewarded: 0 }
        : {
            shots: db.scalar<number>('SELECT total_shots FROM game_rounds WHERE id = ?', round.roundId) ?? 0,
            wagered: db.scalar<number>('SELECT total_wagered FROM game_rounds WHERE id = ?', round.roundId) ?? 0,
            rewarded: db.scalar<number>('SELECT total_rewarded FROM game_rounds WHERE id = ?', round.roundId) ?? 0,
          },
    };

    // Tournament arenas carry their match id so the shot/reward paths switch to
    // free shots + point scoring. The lookup is by arena room, so normal rooms
    // always resolve to null and behave exactly as before.
    const liveTny = db.get<{ id: string; ends_at: string }>(
      `SELECT id, ends_at FROM tournaments WHERE arena_room_id = ? AND status = 'RUNNING'`,
      room.id,
    );
    if (liveTny) {
      runtime.tournamentId = liveTny.id;
      runtime.tournamentEndsAtMs = Date.parse(liveTny.ends_at) || null;
      logger.info('Tournament arena opened', { tournament: liveTny.id, roundId: runtime.roundId });
    }

    const hooks = {
      reward: (args: { playerId: string; amount: number; shotId: string; fishKey: string; roundId: string }) =>
        this.creditReward(runtime, args),
      shotResolved: (args: ShotResolution) => this.resolveShot(runtime, args),
      logEvent: (type: string, payload: Record<string, unknown>, playerId?: string | null) => {
        const { playerId: pid, ...rest } = payload as { playerId?: string | null };
        runtime.eventBuffer.push({ type, playerId: playerId ?? pid ?? null, metadata: rest });
      },
    };

    runtime.sim = new RoomSimulation({
      roomId: room.id,
      roundId: runtime.roundId,
      config,
      seed: runtime.seed,
      spawnRateMultiplier: room.spawn_rate_multiplier ?? 1,
      seats: Math.min(Math.max(room.max_players ?? 4, 1), 32),
      allowedFishIds: parseJson<string[]>(room.fish_pool, []),
      hooks,
      clock: this.opts.clock,
    });

    this.rooms.set(room.id, runtime);
    logger.info('Room runtime opened', { room: room.key, roundId: runtime.roundId, config: config.version, seed: runtime.seed });
    return runtime;
  }

  /* --------------------------------- members --------------------------------- */

  attach(connection: ClientConnection, roomId: string): { runtime: RoomRuntime; player: SimPlayer; seat: { x: number; y: number } } {
    // Player protection is enforced here too, not only on the REST route, so a
    // socket that skips /api/game/join gets the same answer.
    assertPlayAllowed(this.opts.db, connection.userId, this.nowMs());
    const runtime = this.ensureRoom(roomId);
    // Tournament arenas are private: only seated entrants may attach.
    if (runtime.tournamentId) {
      const seat = this.opts.db.get(
        'SELECT 1 FROM tournament_entries WHERE tournament_id = ? AND user_id = ?',
        runtime.tournamentId,
        connection.userId,
      );
      if (!seat) throw new AppError(403, 'NOT_ENTERED', 'That match is private to its entered players.');
    }
    const capacity = this.capacityFor(roomId);
    if (!runtime.members.has(connection) && runtime.members.size >= capacity) {
      throw new AppError(409, 'ROOM_FULL', 'Room is full. Please try another room.');
    }
    connection.roomId = roomId;
    runtime.members.add(connection);
    runtime.lastActivityAt = Date.now();
    // Attaching binds the durable session to the live round. A session created
    // a moment earlier (before the round row existed) is pointed here so the
    // shot path can validate `session.round_id === runtime.roundId`.
    this.opts.db.run(
      "UPDATE game_sessions SET round_id = ?, cannon_id = COALESCE(cannon_id, (SELECT id FROM cannons WHERE key = ?)) WHERE user_id = ? AND status = 'ACTIVE'",
      runtime.roundId,
      connection.cannonKey,
      connection.userId,
    );
    const player = runtime.sim.addPlayer({
      id: connection.userId,
      username: connection.username,
      avatarSeed: connection.avatarSeed,
      cannonKey: connection.cannonKey,
    });
    connection.playDeadlineMs = playDeadlineFor(this.opts.db, connection.userId, this.nowMs());
    return { runtime, player, seat: { x: player.x, y: player.y } };
  }

  /**
   * Wall clock, or the injected virtual clock in tests. Used for the
   * player-protection deadline so the suite can step time forward.
   */
  private nowMs(): number {
    return this.opts.clock ? this.opts.clock() : Date.now();
  }

  /**
   * A player's daily allowance has run out (or they self-excluded mid-round):
   * close the session, take them out of the reef and tell them why. The client
   * cannot decline this — further shots are refused from then on.
   */
  private suspendForLimits(
    connection: ClientConnection,
    kind: 'SESSION_LIMIT' | 'SELF_EXCLUDED' | 'ACCOUNT_BLOCKED',
    message: string,
    nowMs = this.nowMs(),
  ): void {
    const roomId = connection.roomId;
    if (roomId) {
      const runtime = this.rooms.get(roomId);
      if (runtime && runtime.members.delete(connection)) {
        runtime.sim.removePlayer(connection.userId);
        this.broadcast(runtime, { type: 'playerLeft', playerId: connection.userId });
        runtime.lastActivityAt = this.nowMs();
        this.flushEvents(runtime);
      }
    }
    connection.roomId = null;
    connection.playDeadlineMs = null;
    this.endSession(connection.userId, 'ENDED');
    const limits = readPlayLimits(this.opts.db, connection.userId, nowMs);
    this.send(connection, {
      type: 'limit',
      kind,
      message,
      limitMin: limits.limitMin,
      minutesPlayedToday: limits.minutesPlayedToday,
      until: limits.selfExcludedUntil,
    });
    logger.info('Player suspended by protection limits', { user: connection.userId, kind, limitMin: limits.limitMin });
  }

  /**
   * Stop a user's live play right now — used when a self-exclusion or an admin
   * suspension lands while they are mid-round. Returns whether they were in a
   * room. Their durable session is closed either way.
   */
  suspendPlayer(
    userId: string,
    kind: 'SESSION_LIMIT' | 'SELF_EXCLUDED' | 'ACCOUNT_BLOCKED',
    message: string,
  ): boolean {
    let suspended = false;
    for (const runtime of this.rooms.values()) {
      for (const member of [...runtime.members]) {
        if (member.userId !== userId) continue;
        this.suspendForLimits(member, kind, message);
        suspended = true;
      }
    }
    if (!suspended) this.endSession(userId, 'ENDED');
    return suspended;
  }

  detach(connection: ClientConnection): void {
    const roomId = connection.roomId;
    connection.roomId = null;
    connection.playDeadlineMs = null;
    if (!roomId) return;
    const runtime = this.rooms.get(roomId);
    if (!runtime) return;
    if (runtime.members.delete(connection)) {
      runtime.sim.removePlayer(connection.userId);
      this.broadcast(runtime, { type: 'playerLeft', playerId: connection.userId });
      runtime.lastActivityAt = Date.now();
      this.flushEvents(runtime);
    }
    this.endSession(connection.userId, 'ENDED');
  }

  /** Close the player's active DB session (called on leave and on disconnect). */
  endSession(userId: string, status: 'ENDED' | 'ABANDONED' = 'ENDED'): void {
    const db = this.opts.db;
    const session = db.get<{ id: string }>("SELECT id FROM game_sessions WHERE user_id = ? AND status = 'ACTIVE' ORDER BY started_at DESC LIMIT 1", userId);
    if (!session) return;
    db.run("UPDATE game_sessions SET status = ?, ended_at = ? WHERE id = ?", status, new Date().toISOString(), session.id);
  }

  private capacityFor(roomId: string): number {
    const room = this.opts.db.get<{ max_players: number }>('SELECT max_players FROM game_rooms WHERE id = ?', roomId);
    return room?.max_players ?? 4;
  }

  /* ---------------------------------- ticking ---------------------------------- */

  private tickAll(forcedDt?: number): void {
    const now = Date.now();
    for (const runtime of this.rooms.values()) {
      if (runtime.members.size === 0) {
        // Nobody is watching: stop simulating and close the round so the next
        // player gets a fresh, correctly-versioned round. This keeps an idle
        // server at ~0 CPU instead of burning ticks on empty rooms.
        if (now - runtime.lastActivityAt > (this.opts.idleFreezeMs ?? 20_000)) {
          this.endRound(runtime, 'IDLE');
          this.rooms.delete(runtime.roomId);
          this.lastBroadcastAt.delete(runtime.roomId);
        }
        continue;
      }

      try {
        runtime.sim.tick(Math.min(150, forcedDt ?? this.opts.tickMs));
      } catch (err) {
        logger.error('Simulation tick failed', { room: runtime.roomKey, err: String(err) });
      }

      // Tournament arenas end terminally at match time — they never roll over
      // into a new round, because an arena lives for exactly one match.
      if (runtime.tournamentId && now >= (runtime.tournamentEndsAtMs ?? Number.MAX_SAFE_INTEGER)) {
        this.endTournamentRuntime(runtime);
        continue;
      }

      if (!runtime.tournamentId && now - runtime.startedAt >= runtime.roundDurationMs) {
        this.rollover(runtime);
        continue;
      }

      if (now - (this.lastBroadcastAt.get(runtime.roomId) ?? 0) >= this.opts.snapshotMs) {
        this.lastBroadcastAt.set(runtime.roomId, now);
        this.broadcastDelta(runtime);
      }
      this.sweepLimits(runtime, now);
      if (runtime.eventBuffer.length) this.flushEvents(runtime);
    }
    // Lobby expiry + orphan settlement (e.g. after a restart) run here so no
    // background worker is needed; throttled to once every few seconds.
    if (now - this.lastTournamentSweepAt >= 5000) {
      this.lastTournamentSweepAt = now;
      try {
        const live = new Set<string>();
        for (const r of this.rooms.values()) if (r.tournamentId) live.add(r.tournamentId);
        sweepTournaments(this.opts.db, live);
      } catch (err) {
        logger.error('Tournament sweep failed', { err: String(err) });
      }
    }
  }

  /**
   * Player protection during live play, not just at the door. Every ~2 s a room
   * re-reads its members' limits so that a self-exclusion a player just
   * triggered, an account an admin just suspended, or a daily allowance that
   * simply elapsed removes them from the reef within a couple of seconds.
   */
  private sweepLimits(runtime: RoomRuntime, now: number): void {
    if (now - runtime.lastLimitSweepAt < 2000) return;
    runtime.lastLimitSweepAt = now;
    const db = this.opts.db;
    for (const member of [...runtime.members]) {
      // The in-memory deadline is judged on the shot path (that is where money
      // moves). This sweep only catches state that changed in the database: an
      // exclusion the player just started, or an account an admin just froze.
      try {
        assertPlayAllowed(db, member.userId, now);
      } catch (err) {
        const code = err instanceof AppError ? err.code : '';
        if (code === 'SELF_EXCLUDED' || code === 'SESSION_LIMIT_REACHED' || code === 'ACCOUNT_SUSPENDED') {
          const message = err instanceof AppError ? err.message : 'Play stopped.';
          this.suspendForLimits(
            member,
            code === 'ACCOUNT_SUSPENDED' ? 'ACCOUNT_BLOCKED' : code === 'SELF_EXCLUDED' ? 'SELF_EXCLUDED' : 'SESSION_LIMIT',
            message,
            now,
          );
        }
      }
    }
    if (runtime.members.size === 0) runtime.lastActivityAt = now;
  }

  /** Push the live leaderboard to every spectator of a tournament arena. */
  private broadcastStandings(runtime: RoomRuntime): void {
    if (!runtime.tournamentId) return;
    const db = this.opts.db;
    const row = db.get<{ ends_at: string; prize_pool: number }>(
      'SELECT ends_at, prize_pool FROM tournaments WHERE id = ?',
      runtime.tournamentId,
    );
    if (!row) return;
    this.broadcast(runtime, {
      type: 'standings',
      tournamentId: runtime.tournamentId,
      endsAt: row.ends_at,
      prizePool: row.prize_pool,
      standings: standingsFor(db, runtime.tournamentId),
    });
  }

  /** Standings snapshot for the join path (so a player sees scores immediately). */
  standingsForRoom(roomId: string): { tournamentId: string; endsAt: string; prizePool: number; standings: ReturnType<typeof standingsFor> } | null {
    const runtime = this.rooms.get(roomId);
    if (!runtime?.tournamentId) return null;
    const row = this.opts.db.get<{ ends_at: string; prize_pool: number }>(
      'SELECT ends_at, prize_pool FROM tournaments WHERE id = ?',
      runtime.tournamentId,
    );
    if (!row) return null;
    return {
      tournamentId: runtime.tournamentId,
      endsAt: row.ends_at,
      prizePool: row.prize_pool,
      standings: standingsFor(this.opts.db, runtime.tournamentId),
    };
  }

  private broadcastDelta(runtime: RoomRuntime): void {
    const delta = runtime.sim.drainDelta();
    const messages = runtime.sim.drainBroadcasts() as unknown as ServerMessage[];
    const hasDelta = delta.add.length > 0 || delta.rm.length > 0 || delta.hp.length > 0;
    if (!hasDelta && messages.length === 0) return;

    if (hasDelta) this.broadcast(runtime, { type: 'delta', delta });

    for (const message of messages) {
      this.broadcast(runtime, message);
      // Balance is private: only the earning player receives the updated figure.
      const anyMsg = message as unknown as { type: string; event?: { ownerId?: string; balance?: number; reward?: number } };
      if (anyMsg.type === 'defeat' && anyMsg.event?.ownerId && typeof anyMsg.event.balance === 'number') {
        const owner = [...runtime.members].find((c) => c.userId === anyMsg.event!.ownerId);
        if (owner) this.send(owner, { type: 'balance', balance: anyMsg.event.balance });
      }
    }
  }

  private broadcast(runtime: RoomRuntime, message: ServerMessage): void {
    const text = JSON.stringify(message);
    for (const client of runtime.members) {
      if (client.ws.readyState !== 1) continue;
      try {
        client.ws.send(text);
      } catch {
        client.alive = false;
      }
    }
  }

  send(client: ClientConnection, message: ServerMessage): void {
    if (client.ws.readyState !== 1) return;
    try {
      client.ws.send(JSON.stringify(message));
    } catch {
      client.alive = false;
    }
  }

  broadcastToRoom(roomId: string, message: ServerMessage): void {
    const runtime = this.rooms.get(roomId);
    if (runtime) this.broadcast(runtime, message);
  }

  /** Announce a player's seat + aim to the rest of the room. */
  broadcastPlayerJoined(roomId: string, player: SimPlayer): void {
    const runtime = this.rooms.get(roomId);
    if (!runtime) return;
    const cannon = runtime.config.cannons.find((c) => c.key === player.cannonKey);
    this.broadcast(runtime, {
      type: 'playerJoined',
      player: {
        id: player.id,
        username: player.username,
        avatarSeed: player.avatarSeed,
        cannonKey: player.cannonKey,
        cannonLevel: cannon?.level ?? 1,
        angle: player.angle,
        x: player.x,
        y: player.y,
      },
    });
  }

  /* ---------------------------------- firing ---------------------------------- */

  fire(
    connection: ClientConnection,
    input: { clientRef: string; cannonKey: string; angle: number; originX: number; originY: number },
  ): { ok: boolean; code?: string; message?: string; waitMs?: number; ack?: Record<string, unknown> } {
    const db = this.opts.db;
    if (!connection.roomId) return { ok: false, code: 'NO_ACTIVE_SESSION', message: 'You are not in a game room.' };
    const runtime = this.rooms.get(connection.roomId);
    if (!runtime) return { ok: false, code: 'GAME_UNAVAILABLE', message: 'Game unavailable. Please rejoin the room.' };

    // Player protection first: an expired allowance refuses the shot before any
    // money moves, and closes the session so the room reflects it immediately.
    const deadline = connection.playDeadlineMs;
    if (typeof deadline === 'number' && this.nowMs() >= deadline) {
      const limits = readPlayLimits(db, connection.userId, this.nowMs());
      this.suspendForLimits(
        connection,
        'SESSION_LIMIT',
        `You have used your ${limits.limitMin}-minute daily play limit. Play unlocks again at 00:00 UTC.`,
      );
      return {
        ok: false,
        code: 'SESSION_LIMIT_REACHED',
        message: `Daily play limit reached (${limits.limitMin} minutes). Take a break — you can play again at 00:00 UTC.`,
      };
    }

    const room = db.get<any>('SELECT * FROM game_rooms WHERE id = ?', runtime.roomId);
    if (!room || room.status !== 'ACTIVE') {
      return { ok: false, code: 'ROOM_UNAVAILABLE', message: 'This room is currently closed. Please pick another room.' };
    }
    if (isMaintenance(db)) return { ok: false, code: 'MAINTENANCE', message: 'The game is under maintenance. Please try again shortly.' };

    // Tournament arenas: the match must be live, the shooter must hold a seat,
    // and everybody fires the same fixed cannon (same power, same fire rate —
    // the entry fee is the only stake, so no wallet buys an edge).
    const tnyId = runtime.tournamentId;
    let tnyCannonKey: string | null = null;
    if (tnyId) {
      const tny = db.get<{ status: string; cannon_key: string }>('SELECT status, cannon_key FROM tournaments WHERE id = ?', tnyId);
      if (!tny || tny.status !== 'RUNNING') {
        return { ok: false, code: 'GAME_UNAVAILABLE', message: 'That tournament has ended.' };
      }
      const seat = db.get('SELECT 1 FROM tournament_entries WHERE tournament_id = ? AND user_id = ?', tnyId, connection.userId);
      if (!seat) return { ok: false, code: 'NOT_ENTERED', message: 'You do not hold a seat in this tournament.' };
      tnyCannonKey = tny.cannon_key;
    }

    // Cannon comes from the round's pinned configuration — never from the client.
    const cannon = runtime.config.cannons.find((c) => c.key === input.cannonKey);
    if (!cannon || !cannon.enabled) {
      return { ok: false, code: 'WEAPON_UNAVAILABLE', message: 'That cannon is not available in this room.' };
    }
    if (tnyCannonKey && input.cannonKey !== tnyCannonKey) {
      return { ok: false, code: 'WEAPON_UNAVAILABLE', message: 'This tournament fixes one cannon for every player.' };
    }
    const cost = tnyId ? 0 : cannon.shotCost;
    if (!tnyId && (cost < room.min_bet || cost > room.max_bet)) {
      return {
        ok: false,
        code: 'BET_OUT_OF_RANGE',
        message: `${room.name} accepts bets of ${room.min_bet}-${room.max_bet} demo coins.`,
      };
    }

    const shotId = uid('sht');
    const angle = runtime.sim.settleAngle(input.angle);
    const originX = clamp(input.originX, 0, runtime.sim.width);
    const originY = clamp(input.originY, runtime.sim.height * 0.35, runtime.sim.height);
    let balance = connection.lastBalance;

    try {
      const outcome = db.transaction(() => {
        // 1. Replay guard first: a client that retries after a dropped response
        //    must get its original result, not a rate-limit or balance error.
        const prior = db.get<any>('SELECT id FROM player_shots WHERE user_id = ? AND client_ref = ? LIMIT 1', connection.userId, input.clientRef);
        if (prior) return { kind: 'replay' as const };

        // 2. Session must still be live and bound to this exact round.
        const session = db.get<{ id: string; round_id: string; room_id: string }>(
          `SELECT id, round_id, room_id FROM game_sessions WHERE user_id = ? AND status = 'ACTIVE' ORDER BY started_at DESC LIMIT 1`,
          connection.userId,
        );
        if (!session || session.room_id !== runtime.roomId || session.round_id !== runtime.roundId) {
          return { kind: 'invalid_session' as const };
        }

        // A player who joined over HTTP (or reconnected without re-attaching)
        // still needs a seat before cadence can be judged against it.
        if (!runtime.sim.hasPlayer(connection.userId)) {
          runtime.sim.addPlayer({
            id: connection.userId,
            username: connection.username || 'player',
            avatarSeed: connection.avatarSeed || connection.userId,
            cannonKey: connection.cannonKey || cannon.key,
          });
        }

        // 3. Cadence.
        const minInterval = Math.max(40, 1000 / Math.max(0.2, cannon.fireRate));
        const now = Date.now();
        const last = this.lastFireAt.get(connection.userId) ?? 0;
        if (now - last < minInterval) {
          return { kind: 'throttled' as const, waitMs: Math.ceil(minInterval - (now - last)) };
        }
        const gate = runtime.sim.canFire(connection.userId, cannon.fireRate);
        if (!gate.ok) return { kind: 'throttled' as const, waitMs: gate.waitMs };

        // 4. Wallet.
        const wallet = db.get<{ id: string; balance: number }>('SELECT id, balance FROM wallets WHERE user_id = ?', connection.userId);
        if (!wallet) return { kind: 'no_wallet' as const };
        if (wallet.balance < cost) return { kind: 'insufficient' as const, balance: wallet.balance };

        // Tournament shots are free but still pass through the same replay
        // guard, session binding and cadence checks as paid shots.
        const balanceAfter = tnyId
          ? (db.get<{ balance: number }>('SELECT balance FROM wallets WHERE user_id = ?', connection.userId)?.balance ?? 0)
          : applyBet(db, { userId: connection.userId, cost, shotId, roundId: runtime.roundId }).balanceAfter;
        const timestamp = new Date().toISOString();
        db.run(
          `INSERT INTO player_shots (id, session_id, round_id, room_id, user_id, cannon_id, client_ref, cost, damage, angle, origin_x, origin_y, result, reward, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'MISSED',0,?)`,
          shotId,
          session.id,
          runtime.roundId,
          runtime.roomId,
          connection.userId,
          cannon.id,
          input.clientRef,
          cost,
          cannon.power,
          angle,
          originX,
          originY,
          timestamp,
        );
        db.run('UPDATE game_rounds SET total_shots = total_shots + 1, total_wagered = total_wagered + ? WHERE id = ?', cost, runtime.roundId);
        db.run('UPDATE game_sessions SET total_wagered = total_wagered + ?, cannon_id = ? WHERE id = ?', cost, cannon.id, session.id);
        if (tnyId) recordTournamentShot(db, tnyId, connection.userId);
        runtime.totals.shots += 1;
        runtime.totals.wagered += cost;
        return { kind: 'ok' as const, balance: balanceAfter, sessionId: session.id };
      });

      if (outcome.kind === 'replay') {
        return {
          ok: true,
          ack: {
            ok: true,
            clientRef: input.clientRef,
            replayed: true,
            cost: 0,
            damage: 0,
            angle,
            speed: 0,
            originX,
            originY,
            balance: db.scalar<number>('SELECT balance FROM wallets WHERE user_id = ?', connection.userId) ?? balance,
          },
        };
      }
      if (outcome.kind === 'invalid_session') {
        return { ok: false, code: 'INVALID_SESSION', message: 'Your session has ended. Please rejoin the room.' };
      }
      if (outcome.kind === 'throttled') {
        return { ok: false, code: 'RATE_LIMITED', message: 'Slow down.', waitMs: outcome.waitMs };
      }
      if (outcome.kind === 'no_wallet') {
        return { ok: false, code: 'INTERNAL', message: 'Wallet unavailable. Please contact support.' };
      }
      if (outcome.kind === 'insufficient') {
        this.send(connection, { type: 'balance', balance: outcome.balance });
        connection.lastBalance = outcome.balance;
        return { ok: false, code: 'INSUFFICIENT_FUNDS', message: 'Not enough demo coins.', ack: { balance: outcome.balance } };
      }
      balance = outcome.balance;
    } catch (err) {
      const msg = String(err);
      // The UNIQUE index on (user_id, client_ref) is the final word on replays:
      // two requests that raced past the read above both land here, and only one
      // of them ever moves money.
      if (msg.includes('UNIQUE constraint failed: player_shots.user_id, player_shots.client_ref')) {
        return {
          ok: true,
          ack: { ok: true, clientRef: input.clientRef, replayed: true, cost: 0, damage: 0, angle, speed: 0, originX, originY, balance },
        };
      }
      logger.error('Shot transaction failed', { err: msg, user: connection.userId });
      return { ok: false, code: 'GAME_UNAVAILABLE', message: 'Game unavailable. Please try again.' };
    }

    const now = Date.now();
    this.lastFireAt.set(connection.userId, now);
    connection.lastBalance = balance;
    connection.cannonKey = cannon.key;
    runtime.lastActivityAt = now;

    const projectile = runtime.sim.fire({
      playerId: connection.userId,
      angle,
      originX,
      originY,
      damage: cannon.power,
      speed: cannon.projectileSpeed,
      cannonKey: cannon.key,
      cannonLevel: cannon.level,
      shotId,
    });
    runtime.sim.addWager(connection.userId, cost);
    runtime.eventBuffer.push({
      type: 'PLAYER_SHOT',
      playerId: connection.userId,
      metadata: { shotId, projectileId: projectile.id, cannonKey: cannon.key, cost, damage: cannon.power, angle: Number(angle.toFixed(4)) },
    });

    const ack = {
      ok: true,
      projectileId: String(projectile.id),
      clientRef: input.clientRef,
      cost,
      damage: cannon.power,
      angle,
      speed: cannon.projectileSpeed,
      originX: projectile.x,
      originY: projectile.y,
      balance,
    };

    this.send(connection, { type: 'shot', ack: ack as any });
    const projectileView = runtime.sim.toProjectileInstance(projectile);
    for (const other of runtime.members) {
      if (other === connection) continue;
      this.send(other, { type: 'shotBroadcast', projectile: projectileView });
    }
    return { ok: true, ack };
  }

  private lastFireAt = new Map<string, number>();
  private lastTournamentSweepAt = 0;

  setCannon(connection: ClientConnection, cannonKey: string): { ok: boolean; message?: string } {
    if (!connection.roomId) return { ok: false, message: 'You are not in a game room.' };
    const runtime = this.rooms.get(connection.roomId);
    if (!runtime) return { ok: false, message: 'Game unavailable.' };
    const room = this.opts.db.get<any>('SELECT * FROM game_rooms WHERE id = ?', runtime.roomId);
    if (runtime.tournamentId) return { ok: false, message: 'The tournament cannon is fixed for every player.' };
    const cannon = runtime.config.cannons.find((c) => c.key === cannonKey);
    if (!cannon || !cannon.enabled) return { ok: false, message: 'That cannon is not available.' };
    if (room && (cannon.shotCost < room.min_bet || cannon.shotCost > room.max_bet)) {
      return { ok: false, message: `${room.name} accepts bets of ${room.min_bet}-${room.max_bet} demo coins.` };
    }
    connection.cannonKey = cannonKey;
    runtime.sim.setPlayerAim(connection.userId, connection.lastAngle, cannonKey);
    this.broadcast(runtime, { type: 'playerMoved', playerId: connection.userId, angle: connection.lastAngle, cannonKey });
    return { ok: true };
  }

  setAim(connection: ClientConnection, angle: number): void {
    if (!Number.isFinite(angle)) return;
    connection.lastAngle = angle;
    const runtime = connection.roomId ? this.rooms.get(connection.roomId) : undefined;
    if (!runtime) return;
    runtime.sim.setPlayerAim(connection.userId, angle, connection.cannonKey);
    runtime.lastActivityAt = Date.now();
  }

  /* ---------------------------- wallet + history ---------------------------- */

  private creditReward(
    runtime: RoomRuntime,
    args: { playerId: string; amount: number; shotId: string; fishKey: string; roundId: string },
  ): { ok: boolean; balance?: number; message?: string } {
    if (!Number.isInteger(args.amount) || args.amount <= 0) return { ok: false, message: 'invalid_amount' };
    const db = this.opts.db;
    // Tournament arenas score points instead of paying the wallet.
    if (runtime.tournamentId) {
      const balance = db.transaction(() => {
        recordTournamentKill(db, runtime.tournamentId!, args.playerId, args.amount);
        return db.scalar<number>('SELECT balance FROM wallets WHERE user_id = ?', args.playerId) ?? 0;
      });
      runtime.sim.addReward(args.playerId, args.amount);
      this.broadcastStandings(runtime);
      const owner = [...runtime.members].find((c) => c.userId === args.playerId);
      if (owner) owner.lastBalance = balance;
      return { ok: true, balance };
    }
    const idempotencyKey = `win:${args.shotId}:${args.fishKey}`;
    try {
      const result = db.transaction(() => {
        const prior = db.get<{ id: string }>('SELECT id FROM wallet_transactions WHERE idempotency_key = ? LIMIT 1', idempotencyKey);
        if (prior) {
          // Duplicate reward attempt: never pay twice, and record the attempt.
          return { ok: false, replayed: true, balance: db.scalar<number>('SELECT balance FROM wallets WHERE user_id = ?', args.playerId) ?? 0 };
        }
        const wallet = db.get<{ id: string; balance: number }>('SELECT id, balance FROM wallets WHERE user_id = ?', args.playerId);
        if (!wallet) return { ok: false, replayed: false, balance: 0 };
        const before = wallet.balance;
        const after = before + args.amount;
        const timestamp = new Date().toISOString();
        db.run(
          `INSERT INTO wallet_transactions (id, user_id, wallet_id, type, amount, balance_before, balance_after, reference_id, game_round_id, idempotency_key, status, description, created_at)
           VALUES (?,?,?, 'WIN', ?,?,?,?,?,?, 'COMPLETED', ?, ?)`,
          uid('tx'),
          args.playerId,
          wallet.id,
          args.amount,
          before,
          after,
          args.shotId,
          args.roundId,
          idempotencyKey,
          `Reward for ${args.fishKey.replace(/_/g, ' ')}`,
          timestamp,
        );
        db.run('UPDATE wallets SET balance = ?, version = version + 1, updated_at = ? WHERE id = ?', after, timestamp, wallet.id);
        db.run('UPDATE game_rounds SET total_rewarded = total_rewarded + ? WHERE id = ?', args.amount, args.roundId);
        return { ok: true, replayed: false, balance: after };
      });

      if (!result.ok) return { ok: false, balance: result.balance, message: result.replayed ? 'duplicate' : 'no_wallet' };

      runtime.totals.rewarded += args.amount;
      runtime.sim.addReward(args.playerId, args.amount);
      const owner = [...runtime.members].find((c) => c.userId === args.playerId);
      if (owner) owner.lastBalance = result.balance;
      return { ok: true, balance: result.balance };
    } catch (err) {
      logger.error('Reward credit failed', { err: String(err), player: args.playerId });
      return { ok: false, message: 'reward_failed' };
    }
  }

  /** Finalises a shot's outcome: updates the shot row and appends history. */
  private resolveShot(
    runtime: RoomRuntime,
    args: { shotId: string; playerId: string; result: 'MISSED' | 'HIT' | 'KILL'; reward: number; fishKey: string | null; fishName: string | null; roundId: string },
  ): void {
    const db = this.opts.db;
    try {
      db.transaction(() => {
        const timestamp = new Date().toISOString();
        if (args.result === 'KILL') {
          db.run('UPDATE player_shots SET result = ?, reward = ? WHERE id = ? AND result <> ?', args.result, args.reward, args.shotId, 'KILL');
          db.run(
            'UPDATE game_sessions SET total_shots = total_shots, total_rewarded = total_rewarded + ? WHERE user_id = ? AND round_id = ?',
            args.reward,
            args.playerId,
            args.roundId,
          );
        } else if (args.result === 'HIT') {
          db.run("UPDATE player_shots SET result = 'HIT' WHERE id = ? AND result = 'MISSED'", args.shotId);
        }
        const shot = db.get<{ session_id: string; room_id: string; cannon_id: string; cost: number }>(
          'SELECT session_id, room_id, cannon_id, cost FROM player_shots WHERE id = ?',
          args.shotId,
        );
        if (!shot) return;
        db.run(
          `INSERT INTO game_history (id, session_id, round_id, room_id, user_id, cannon_id, shot_cost, fish_key, fish_name, reward, result, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          uid('hst'),
          shot.session_id,
          args.roundId,
          shot.room_id,
          args.playerId,
          shot.cannon_id,
          shot.cost,
          args.fishKey,
          args.fishName,
          args.reward,
          args.result,
          timestamp,
        );
        runtime.eventBuffer.push({
          type: args.result === 'KILL' ? 'FISH_DEFEATED' : 'FISH_HIT',
          playerId: args.playerId,
          metadata: { shotId: args.shotId, fishKey: args.fishKey, result: args.result, reward: args.reward },
        });
      });
    } catch (err) {
      logger.error('Shot resolution failed', { err: String(err), shot: args.shotId });
    }
  }

  private flushEvents(runtime: RoomRuntime): void {
    if (!runtime.eventBuffer.length) return;
    const batch = runtime.eventBuffer.splice(0, runtime.eventBuffer.length);
    const db = this.opts.db;
    try {
      db.transaction(() => {
        const timestamp = new Date().toISOString();
        for (const row of batch) {
          db.run(
            'INSERT INTO game_events (id, round_id, room_id, user_id, event_type, config_version, metadata, created_at) VALUES (?,?,?,?,?,?,?,?)',
            uid('ev'),
            runtime.roundId,
            runtime.roomId,
            row.playerId,
            row.type,
            runtime.config.version,
            JSON.stringify(row.metadata),
            timestamp,
          );
        }
      });
    } catch (err) {
      logger.warn('Event flush failed', { err: String(err) });
    }
  }

  /* ---------------------------------- rounds ---------------------------------- */

  /**
   * Terminal end of a tournament arena: settle the pot from the frozen scores,
   * announce the result to every spectator, and tear the runtime down.
   */
  private endTournamentRuntime(runtime: RoomRuntime): void {
    this.flushEvents(runtime);
    try {
      const result = settleTournament(this.opts.db, runtime.tournamentId!);
      this.broadcast(runtime, {
        type: 'tournamentEnd',
        tournamentId: runtime.tournamentId!,
        winnerUsername: result.winnerUsername,
        prize: result.prize,
        rake: result.rake,
        standings: result.standings,
      });
      logger.info('Tournament arena closed', { tournament: runtime.tournamentId, winner: result.winnerUsername });
    } catch (err) {
      logger.error('Tournament settlement failed', { tournament: runtime.tournamentId, err: String(err) });
      this.broadcast(runtime, { type: 'notice', level: 'warn', message: 'The tournament has ended. Results are being finalised.' });
    }
    this.rooms.delete(runtime.roomId);
    this.lastBroadcastAt.delete(runtime.roomId);
  }

  /** End the current round and start a new one, migrating spectators over. */
  rollover(runtime: RoomRuntime): void {
    // Defensive: tournament arenas always end terminally, never roll over.
    if (runtime.tournamentId) {
      this.endTournamentRuntime(runtime);
      return;
    }
    const db = this.opts.db;
    const members = [...runtime.members];
    // A rollover closes the round but must NOT end the players' sessions: they
    // are moved onto the new round in the same breath.
    this.endRound(runtime, 'ROUND_DURATION', true);
    this.rooms.delete(runtime.roomId);
    this.lastBroadcastAt.delete(runtime.roomId);

    const room = db.get<any>('SELECT * FROM game_rooms WHERE id = ?', runtime.roomId);
    if (!room) return;
    let fresh: RoomRuntime;
    try {
      fresh = this.openRuntime(room);
    } catch (err) {
      logger.error('Round rollover failed', { err: String(err) });
      for (const client of members) {
        this.send(client, { type: 'notice', level: 'error', message: 'Game unavailable. Please rejoin the room.' });
        client.roomId = null;
      }
      runtime.members.clear();
      return;
    }

    for (const client of members) {
      client.roomId = fresh.roomId;
      fresh.members.add(client);
      fresh.sim.addPlayer({ id: client.userId, username: client.username, avatarSeed: client.avatarSeed, cannonKey: client.cannonKey });
      db.run("UPDATE game_sessions SET round_id = ? WHERE user_id = ? AND status = 'ACTIVE'", fresh.roundId, client.userId);
      this.send(client, { type: 'round', roundId: fresh.roundId, configVersion: fresh.config.version });
      this.send(client, { type: 'snapshot', snapshot: fresh.sim.snapshot() as unknown as RoomSnapshot });
    }
    runtime.members.clear();
    logger.info('Round rolled over', { room: runtime.roomKey, next: fresh.roundId, config: fresh.config.version });
  }

  private endRound(runtime: RoomRuntime, reason: string, keepSessions = false): void {
    this.flushEvents(runtime);
    const totals = { ...runtime.totals };
    try {
      closeActiveRound(this.opts.db, runtime.roomId, reason, totals, { endSessions: !keepSessions });
    } catch (err) {
      logger.warn('Round close failed', { err: String(err), room: runtime.roomKey });
    }
  }

  /** Close every live round (used when maintenance mode is switched on). */
  closeAllRounds(reason = 'MAINTENANCE'): void {
    for (const runtime of this.rooms.values()) {
      for (const client of runtime.members) {
        this.send(client, { type: 'notice', level: 'warn', message: 'The game is entering maintenance. Please rejoin shortly.' });
      }
      this.endRound(runtime, reason);
      runtime.members.clear();
    }
    this.rooms.clear();
  }

  /** Close only one room's round (used when an admin deactivates a room). */
  closeRoomRounds(roomId: string): void {
    const runtime = this.rooms.get(roomId);
    if (!runtime) return;
    for (const client of runtime.members) {
      this.send(client, { type: 'notice', level: 'warn', message: 'This room has been closed by the operator. Please pick another room.' });
    }
    this.endRound(runtime, 'ROOM_CLOSED');
    runtime.members.clear();
    this.rooms.delete(roomId);
    this.lastBroadcastAt.delete(roomId);
  }

  /** Free-form operator notice to every connected player. */
  broadcastMaintenanceNotice(message: string): void {
    const text = JSON.stringify({ type: 'notice', level: 'warn', message } as ServerMessage);
    for (const runtime of this.rooms.values()) {
      for (const client of runtime.members) {
        if (client.ws.readyState !== 1) continue;
        try {
          client.ws.send(text);
        } catch {
          client.alive = false;
        }
      }
    }
  }

  /* --------------------------------- queries --------------------------------- */

  onlineCount(): number {
    let total = 0;
    for (const r of this.rooms.values()) total += r.members.size;
    return total;
  }

  roomPlayerCount(roomId: string): number {
    return this.rooms.get(roomId)?.members.size ?? 0;
  }

  activeRoomCount(): number {
    let n = 0;
    for (const r of this.rooms.values()) if (r.members.size > 0) n += 1;
    return n;
  }

  currentRoundId(roomId: string): string | null {
    return this.rooms.get(roomId)?.roundId ?? null;
  }

  statusView(): RoomStatusView[] {
    const out: RoomStatusView[] = [];
    for (const r of this.rooms.values()) {
      out.push({
        roomId: r.roomId,
        roundId: r.roundId,
        configVersion: r.config.version,
        players: r.members.size,
        fish: r.sim.stats.fish,
        projectiles: r.sim.stats.projectiles,
        roundAgeMs: Date.now() - r.startedAt,
        totals: { ...r.totals },
      });
    }
    return out;
  }

  /** Snapshot for the REST fallback / reconnect path. */
  snapshotFor(roomId: string): RoomSnapshot | null {
    const runtime = this.rooms.get(roomId);
    if (!runtime) return null;
    return runtime.sim.snapshot() as unknown as RoomSnapshot;
  }

  /** Look up the configuration a historical round was played with. */
  configForVersion(version: string): GameConfiguration | null {
    return getConfigurationVersion(this.opts.db, version);
  }

  /**
   * HTTP transport for a shot. Runs the identical authority checks as the
   * WebSocket path — only the delivery mechanism differs — so there is no
   * weaker route into the economy. Used by tests and by clients whose socket is
   * down but who still need to finish a session cleanly.
   */
  fireViaHttp(
    db: Database,
    userId: string,
    body: { clientRef: string; roomId?: string; cannonKey: string; angle: number; originX: number; originY: number },
  ): { ok: boolean; ack?: Record<string, unknown>; code?: string; message?: string } {
    const session = db.get<{ room_id: string; round_id: string }>(
      "SELECT room_id, round_id FROM game_sessions WHERE user_id = ? AND status = 'ACTIVE' ORDER BY started_at DESC LIMIT 1",
      userId,
    );
    if (!session) {
      return { ok: false, code: 'NO_ACTIVE_SESSION', message: 'Join a game room before shooting.' };
    }
    if (body.roomId && body.roomId !== session.room_id) {
      return { ok: false, code: 'INVALID_SESSION', message: 'You are playing in a different room. Rejoin to continue.' };
    }
    let runtime: RoomRuntime;
    try {
      runtime = this.rooms.get(session.room_id) ?? this.ensureRoom(session.room_id);
    } catch (err) {
      const appErr = err instanceof AppError ? err : null;
      return { ok: false, code: appErr?.code ?? 'GAME_UNAVAILABLE', message: appErr?.message ?? 'Game unavailable. Please try again.' };
    }
    const username = db.get<{ username: string; avatar_seed: string }>('SELECT username, avatar_seed FROM users WHERE id = ?', userId);
    const messages: string[] = [];
    const pseudoConnection: ClientConnection = {
      ws: {
        readyState: 1,
        send: (data: string) => {
          messages.push(data);
        },
      },
      userId,
      username: username?.username ?? 'player',
      avatarSeed: username?.avatar_seed ?? userId,
      roomId: runtime.roomId,
      lastAngle: body.angle,
      cannonKey: body.cannonKey,
      alive: true,
      lastBalance: db.scalar<number>('SELECT balance FROM wallets WHERE user_id = ?', userId) ?? 0,
      pendingRefs: new Map(),
      // The HTTP transport is not a weaker path: the daily allowance is applied
      // here exactly as it is on a socket.
      playDeadlineMs: playDeadlineFor(db, userId, this.nowMs()),
    };
    const result = this.fire(pseudoConnection, {
      clientRef: body.clientRef,
      cannonKey: body.cannonKey,
      angle: body.angle,
      originX: body.originX,
      originY: body.originY,
    });
    return { ...result, ack: result.ack ? { ...result.ack, transport: 'http' } : undefined };
  }
}

/* --------------------------------- helpers --------------------------------- */

function isMaintenance(db: Database): boolean {
  const row = db.get<{ value: string }>("SELECT value FROM system_settings WHERE key = 'maintenance_mode'");
  return row?.value === 'true';
}

function applyBet(db: Database, args: { userId: string; cost: number; shotId: string; roundId: string }): { balanceBefore: number; balanceAfter: number } {
  const wallet = db.get<{ id: string; balance: number }>('SELECT id, balance FROM wallets WHERE user_id = ?', args.userId);
  if (!wallet) throw new AppError(500, 'INTERNAL', 'Wallet unavailable.');
  if (wallet.balance < args.cost) throw new AppError(402, 'INSUFFICIENT_FUNDS', 'Not enough demo coins.');
  const before = wallet.balance;
  const after = before - args.cost;
  const timestamp = new Date().toISOString();
  db.run(
    `INSERT INTO wallet_transactions (id, user_id, wallet_id, type, amount, balance_before, balance_after, reference_id, game_round_id, idempotency_key, status, description, created_at)
     VALUES (?,?,?, 'BET', ?,?,?,?,?,?, 'COMPLETED', ?, ?)`,
    uid('tx'),
    args.userId,
    wallet.id,
    -args.cost,
    before,
    after,
    args.shotId,
    args.roundId,
    `bet:${args.shotId}`,
    'Cannon shot',
    timestamp,
  );
  db.run('UPDATE wallets SET balance = ?, version = version + 1, updated_at = ? WHERE id = ?', after, timestamp, wallet.id);
  return { balanceBefore: before, balanceAfter: after };
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') return fallback;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return !Number.isFinite(v) ? lo : v < lo ? lo : v > hi ? hi : v;
}
