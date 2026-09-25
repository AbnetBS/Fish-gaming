import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setEnv, loadEnv, type Env } from '../src/config/env.js';
import { Database, setDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';
import { createUser, findUserByEmail } from '../src/modules/users/service.js';
import { ensureWallet, getWallet, verifyLedgerIntegrity, credit } from '../src/modules/wallet/ledger.js';
import { AppError } from '../src/lib/errors.js';
import { joinRoom } from '../src/modules/game/service.js';
import { RoundManager, type ClientConnection } from '../src/sim/round-manager.js';
import {
  cancelTournament,
  createTournament,
  getTournamentDetail,
  joinTournament,
  leaveTournament,
  settleTournament,
  startTournament,
  standingsFor,
  sweepTournaments,
} from '../src/modules/game/tournaments.js';

/**
 * Tournament tests: entry fees, lobby fill, fair-arena scoring, rake math,
 * refunds and settlement — all against a real database, because the money
 * properties only hold if the actual transactions behave.
 */

let tmpDir: string;
let db: Database;
let file: string;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { ...loadEnv(), nodeEnv: 'test', isProduction: false, dbFile: file, startingDemoCoins: 10_000, ...overrides };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reef-tny-test-'));
  file = path.join(tmpDir, 'test.db');
  db = new Database(file);
  migrate(db);
  setDb(db);
  setEnv(makeEnv());
  await seed(db, { admin: { email: 'admin@test.local', username: 'admin', password: 'Adm1n!pass' } });
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let userCounter = 0;

function makeUser(balance = 10_000): { id: string; username: string } {
  userCounter += 1;
  const username = `tnyplayer${userCounter}`;
  const email = `${username}@example.com`;
  createUser(db, { username, email, password: 'Passw0rd!23', acceptTerms: true });
  const id = findUserByEmail(db, email)!.id;
  ensureWallet(db, id, 0);
  if (balance > 0) {
    credit(db, {
      userId: id,
      amount: balance,
      type: 'DEMO_CREDIT',
      referenceId: `test:${username}:${Date.now()}`,
      idempotencyKey: `test-credit:${id}:${userCounter}`,
    });
  }
  return { id, username };
}

function adminActor(): { id: string; username: string; ip: string } {
  const admin = findUserByEmail(db, 'admin@test.local')!;
  return { id: admin.id, username: admin.username, ip: '127.0.0.1' };
}

function makeTournament(overrides: Record<string, unknown> = {}) {
  return createTournament(db, adminActor(), {
    name: 'Test Hunt',
    entryFee: 100,
    minPlayers: 2,
    maxPlayers: 2,
    durationS: 300,
    rakePct: 25,
    cannonKey: 'reef_breaker',
    lobbyMinutes: 15,
    ...overrides,
  });
}

function fakeConnection(user: { id: string; username: string }): { connection: ClientConnection; messages: string[] } {
  const messages: string[] = [];
  const connection: ClientConnection = {
    ws: {
      readyState: 1,
      send: (data: string) => {
        messages.push(data);
      },
    },
    userId: user.id,
    username: user.username,
    avatarSeed: user.username,
    roomId: null,
    lastAngle: -Math.PI / 2,
    cannonKey: 'tidecaster',
    alive: true,
    lastBalance: getWallet(db, user.id).balance,
    pendingRefs: new Map(),
  };
  return { connection, messages };
}

function arenaIdFor(tournamentId: string): string {
  return db.get<{ arena_room_id: string }>('SELECT arena_room_id FROM tournaments WHERE id = ?', tournamentId)!.arena_room_id;
}

describe('tournament lobbies', () => {
  it('fills seats, charges entry fees into the pot, and auto-starts when full', () => {
    const tournament = makeTournament();
    expect(tournament.status).toBe('LOBBY');
    const a = makeUser();
    const b = makeUser();

    const first = joinTournament(db, a.id, tournament.id);
    expect(first.started).toBe(false);
    expect(first.tournament.seatsTaken).toBe(1);
    expect(getWallet(db, a.id).balance).toBe(10_000 - 100);

    const second = joinTournament(db, b.id, tournament.id);
    expect(second.started).toBe(true);
    expect(second.tournament.status).toBe('RUNNING');
    expect(second.tournament.prizePool).toBe(200);
    expect(second.tournament.endsAt).not.toBeNull();
    // Arenas stay out of the public room list.
    const listed = db.all<{ id: string }>(
      `SELECT * FROM game_rooms WHERE NOT EXISTS (SELECT 1 FROM tournaments t WHERE t.arena_room_id = game_rooms.id)`,
    );
    expect(listed.find((r) => r.id === arenaIdFor(tournament.id))).toBeUndefined();
  });

  it('rejects double entry, busy players and poor players', () => {
    const tournament = makeTournament();
    const a = makeUser();
    joinTournament(db, a.id, tournament.id);
    expect(() => joinTournament(db, a.id, tournament.id)).toThrowError(AppError);

    const other = makeTournament({ name: 'Second Hunt' });
    expect(() => joinTournament(db, a.id, other.id)).toThrowError(/current tournament/);

    const broke = makeUser(50);
    expect(() => joinTournament(db, broke.id, other.id)).toThrowError(/need 100 demo coins/);
  });

  it('refunds lobby leavers and locks entries once running', () => {
    const tournament = makeTournament({ maxPlayers: 4 });
    const a = makeUser();
    joinTournament(db, a.id, tournament.id);
    const left = leaveTournament(db, a.id, tournament.id);
    expect(left.refunded).toBe(100);
    expect(getWallet(db, a.id).balance).toBe(10_000);
    expect(getTournamentDetail(db, tournament.id).prizePool).toBe(0);

    // Fill it: running entries cannot leave.
    const players = [makeUser(), makeUser(), makeUser(), makeUser()];
    for (const p of players) joinTournament(db, p.id, tournament.id);
    expect(getTournamentDetail(db, tournament.id).status).toBe('RUNNING');
    expect(() => leaveTournament(db, players[0]!.id, tournament.id)).toThrowError(/locked/);
  });

  it('validates operator input', () => {
    expect(() => makeTournament({ rakePct: 95 })).toThrowError(/rake/);
    expect(() => makeTournament({ minPlayers: 1 })).toThrowError(/Minimum players/);
    expect(() => makeTournament({ maxPlayers: 9 })).toThrowError(/Maximum players/);
    expect(() => makeTournament({ entryFee: 0 })).toThrowError(/Entry fee/);
    expect(() => makeTournament({ cannonKey: 'nope' })).toThrowError(/cannon/);
    expect(() => makeTournament({ name: 'x' })).toThrowError(/name/);
  });

  it('supports admin early start and cancel-with-refund', () => {
    const tournament = makeTournament({ maxPlayers: 4 });
    const a = makeUser();
    const b = makeUser();
    joinTournament(db, a.id, tournament.id);
    // Below minimum: cannot start.
    expect(() => startTournament(db, tournament.id, { admin: adminActor() })).toThrowError(/at least 2/);
    joinTournament(db, b.id, tournament.id);
    const started = startTournament(db, tournament.id, { admin: adminActor() });
    expect(started.status).toBe('RUNNING');

    const lobby = makeTournament({ name: 'Doomed Lobby' });
    const c = makeUser();
    joinTournament(db, c.id, lobby.id);
    const cancelled = cancelTournament(db, lobby.id, { ...adminActor(), reason: 'test' });
    expect(cancelled).toEqual({ refunded: 100, players: 1 });
    expect(getWallet(db, c.id).balance).toBe(10_000);
    expect(getTournamentDetail(db, lobby.id).status).toBe('CANCELLED');
  });
});

describe('tournament settlement', () => {
  it('pays the winner pot-minus-rake, banks the rake, and is idempotent', () => {
    const tournament = makeTournament({ rakePct: 25 });
    const a = makeUser();
    const b = makeUser();
    joinTournament(db, a.id, tournament.id);
    joinTournament(db, b.id, tournament.id);

    db.run('UPDATE tournament_entries SET score = 500, kills = 9, shots = 40 WHERE tournament_id = ? AND user_id = ?', tournament.id, a.id);
    db.run('UPDATE tournament_entries SET score = 120, kills = 3, shots = 30 WHERE tournament_id = ? AND user_id = ?', tournament.id, b.id);

    const first = settleTournament(db, tournament.id);
    expect(first.status).toBe('SETTLED');
    expect(first.winnerUserId).toBe(a.id);
    expect(first.pot).toBe(200);
    expect(first.rake).toBe(50);
    expect(first.prize).toBe(150);
    // Winner paid exactly once even though settle runs again below.
    const second = settleTournament(db, tournament.id);
    expect(second.prize).toBe(150);
    expect(getWallet(db, a.id).balance).toBe(10_000 - 100 + 150);
    expect(getWallet(db, b.id).balance).toBe(10_000 - 100);
    const prizeTxns =
      db.scalar<number>('SELECT COUNT(*) FROM wallet_transactions WHERE idempotency_key = ?', `tny-prize:${tournament.id}`) ?? 0;
    expect(prizeTxns).toBe(1);
    expect(db.scalar<string>("SELECT value FROM system_settings WHERE key = 'house_demo_balance'")).toBe('50');
    // Arena retired, ledger still reconciles.
    expect(db.get<{ status: string }>('SELECT status FROM game_rooms WHERE id = ?', arenaIdFor(tournament.id))!.status).toBe('INACTIVE');
    expect(verifyLedgerIntegrity(db).mismatches).toEqual([]);
  });

  it('ranks by score, then kills, then efficiency, then earliest seat', () => {
    const tournament = makeTournament({ maxPlayers: 4, minPlayers: 2 });
    const [a, b, c, d] = [makeUser(), makeUser(), makeUser(), makeUser()];
    // Short lobby: start early with all four seated.
    const wide = makeTournament({ name: 'Rank Hunt', maxPlayers: 4 });
    for (const p of [a, b, c, d]) joinTournament(db, p.id, wide.id);
    void tournament;
    db.run('UPDATE tournament_entries SET score = 100, kills = 5, shots = 10, joined_at = ? WHERE tournament_id = ? AND user_id = ?', '2026-01-01T00:00:03.000Z', wide.id, a.id);
    db.run('UPDATE tournament_entries SET score = 100, kills = 7, shots = 20, joined_at = ? WHERE tournament_id = ? AND user_id = ?', '2026-01-01T00:00:02.000Z', wide.id, b.id);
    db.run('UPDATE tournament_entries SET score = 100, kills = 7, shots = 8, joined_at = ? WHERE tournament_id = ? AND user_id = ?', '2026-01-01T00:00:04.000Z', wide.id, c.id);
    db.run('UPDATE tournament_entries SET score = 90, kills = 9, shots = 5, joined_at = ? WHERE tournament_id = ? AND user_id = ?', '2026-01-01T00:00:01.000Z', wide.id, d.id);
    const order = standingsFor(db, wide.id).map((s) => s.userId);
    // c: same top score, most kills, fewest shots. b: same kills, more shots. a: fewer kills. d: lowest score.
    expect(order).toEqual([c.id, b.id, a.id, d.id]);
    const result = settleTournament(db, wide.id);
    expect(result.winnerUserId).toBe(c.id);
  });
});

describe('tournament sweep', () => {
  it('starts expired lobbies with enough seats and refunds short ones', () => {
    const full = makeTournament({ name: 'Full Lobby' });
    const a = makeUser();
    const b = makeUser();
    joinTournament(db, a.id, full.id);
    // Second seat would auto-start; expire the lobby first with one seat short... instead use a 4-max lobby.
    const roomy = makeTournament({ name: 'Roomy Lobby', maxPlayers: 4 });
    const c = makeUser();
    const d = makeUser();
    joinTournament(db, c.id, roomy.id);
    joinTournament(db, d.id, roomy.id);
    db.run(`UPDATE tournaments SET lobby_ends_at = '2020-01-01T00:00:00.000Z' WHERE id IN (?, ?)`, full.id, roomy.id);
    const outcome = sweepTournaments(db, new Set());
    expect(outcome.cancelled).toContain(full.id); // 1 seat < min 2 → refund
    expect(outcome.started).toContain(roomy.id); // 2 seats >= min 2 → start
    expect(getWallet(db, a.id).balance).toBe(10_000);
    expect(getTournamentDetail(db, roomy.id).status).toBe('RUNNING');
  });

  it('settles orphaned running tournaments past their end', () => {
    const tournament = makeTournament();
    const a = makeUser();
    const b = makeUser();
    joinTournament(db, a.id, tournament.id);
    joinTournament(db, b.id, tournament.id);
    db.run('UPDATE tournament_entries SET score = 300 WHERE tournament_id = ? AND user_id = ?', tournament.id, b.id);
    db.run(`UPDATE tournaments SET ends_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`, tournament.id);
    const outcome = sweepTournaments(db, new Set());
    expect(outcome.settled).toContain(tournament.id);
    expect(getWallet(db, b.id).balance).toBe(10_000 - 100 + 150);
  });
});

describe('tournament arena (RoundManager integration)', () => {
  it('plays a full match: free fixed-cannon shots, point scoring, terminal settle', () => {
    const tournament = makeTournament({ rakePct: 40 });
    const a = makeUser();
    const b = makeUser();
    joinTournament(db, a.id, tournament.id);
    joinTournament(db, b.id, tournament.id);
    const arenaId = arenaIdFor(tournament.id);

    const manager = new RoundManager({ db, tickMs: 50, snapshotMs: 50, roundDurationS: 1800 });
    joinRoom(db, a.id, arenaId, 'reef_breaker');
    const seatA = fakeConnection(a);
    const { runtime } = manager.attach(seatA.connection, arenaId);
    expect(runtime.tournamentId).toBe(tournament.id);

    // Strangers cannot enter a private arena.
    const stranger = fakeConnection(makeUser());
    expect(() => manager.attach(stranger.connection, arenaId)).toThrowError(/private/);

    // Tournament shots are free but still validated.
    const fired = manager.fire(seatA.connection, {
      clientRef: 'tny-shot-0001',
      cannonKey: 'reef_breaker',
      angle: -Math.PI / 2,
      originX: 960,
      originY: 984,
    });
    expect(fired.ok).toBe(true);
    expect((fired.ack as { cost: number }).cost).toBe(0);
    expect(getWallet(db, a.id).balance).toBe(10_000 - 100);
    const betRows = db.scalar<number>(`SELECT COUNT(*) FROM wallet_transactions WHERE user_id = ? AND type = 'BET'`, a.id) ?? 0;
    expect(betRows).toBe(1); // only the entry fee
    expect(db.scalar<number>('SELECT shots FROM tournament_entries WHERE tournament_id = ? AND user_id = ?', tournament.id, a.id)).toBe(1);

    // Wrong cannon is rejected: one fixed weapon for everybody.
    const wrong = manager.fire(seatA.connection, {
      clientRef: 'tny-shot-0002',
      cannonKey: 'tidecaster',
      angle: -Math.PI / 2,
      originX: 960,
      originY: 984,
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.code).toBe('WEAPON_UNAVAILABLE');

    // Kills score points (and broadcast standings), never paying the wallet.
    const credited = (manager as any).creditReward(runtime, {
      playerId: a.id,
      amount: 20,
      shotId: 'tny-shot-0001',
      fishKey: 'blue_darter',
      roundId: runtime.roundId,
    });
    expect(credited.ok).toBe(true);
    expect(db.scalar<number>('SELECT score FROM tournament_entries WHERE tournament_id = ? AND user_id = ?', tournament.id, a.id)).toBe(20);
    expect(getWallet(db, a.id).balance).toBe(10_000 - 100);
    const kinds = seatA.messages.map((raw) => (JSON.parse(raw) as { type: string }).type);
    expect(kinds).toContain('standings');

    // Time expires → terminal settle with a results broadcast (no rollover).
    (runtime as any).tournamentEndsAtMs = Date.now() - 1;
    manager.tickOnce(50);
    expect(getTournamentDetail(db, tournament.id).status).toBe('SETTLED');
    // Pot 200, rake 40% = 80, winner (a: 20 pts vs b: 0) takes 120.
    expect(getWallet(db, a.id).balance).toBe(10_000 - 100 + 120);
    const endMessage = seatA.messages.map((raw) => JSON.parse(raw)).find((m: { type: string }) => m.type === 'tournamentEnd');
    expect(endMessage).toBeDefined();
    expect(endMessage.winnerUsername).toBe(a.username);
    expect(endMessage.prize).toBe(120);
    expect(endMessage.rake).toBe(80);
    expect(manager.runtimeFor(arenaId)).toBeUndefined();
    expect(verifyLedgerIntegrity(db).mismatches).toEqual([]);
    manager.stop();
  });
});
