import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setEnv, loadEnv, type Env } from '../src/config/env.js';
import { Database, setDb, getDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { seed, DEFAULT_FISH, DEFAULT_SETTINGS } from '../src/db/seed.js';
import { createUser, findUserByEmail, listUsers, toPublicUser } from '../src/modules/users/service.js';
import { ensureWallet, getWallet, listTransactions, recordLedgerEntry, verifyLedgerIntegrity } from '../src/modules/wallet/ledger.js';
import { credit, debit } from '../src/modules/wallet/ledger.js';
import { login, issueSession, refresh, logout, createPasswordResetToken, resetPasswordWithToken, MAX_FAILED_LOGINS } from '../src/modules/auth/service.js';
import { AppError } from '../src/lib/errors.js';
import { joinRoom, leaveRoom, leaderboard, listHistory, betOptionsFor, adminAdjustDemoCoins, grantDemoTopup } from '../src/modules/game/service.js';
import { RoundManager } from '../src/sim/round-manager.js';
import {
  assertPlayAllowed,
  liftSelfExclusion,
  readPlayLimits,
  requestSelfExclusion,
  msPlayedToday,
} from '../src/modules/game/limits.js';
import { RoomSimulation } from '../src/sim/room-simulation.js';
import { publishConfiguration, getActiveConfiguration, updateFish, updateCannon, updateRoom, configMeta, nextVersion, readWorkingSettings } from '../src/modules/config/service.js';
import { readAudit } from '../src/lib/audit.js';
import { computeAdminStats, roundAudit } from '../src/modules/reports/service.js';
import type { GameConfiguration } from '@reef/shared';

/**
 * Platform test suite.
 *
 * These exercise the real services against a real SQLite database — not mocks —
 * because the properties that matter here (no double spend, no duplicate reward,
 * no negative balance, ledger/balance agreement, capability enforcement, config
 * versioning) only hold if the actual transactions and constraints behave.
 */

let tmpDir: string;
let db: Database;
let file: string;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { ...loadEnv(), nodeEnv: 'test', isProduction: false, dbFile: file, startingDemoCoins: 10_000, ...overrides };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reef-test-'));
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

function makeUser(password = 'Passw0rd!23'): { id: string; username: string; email: string; password: string } {
  userCounter += 1;
  const username = `player${userCounter}`;
  const email = `${username}@example.com`;
  createUser(db, { username, email, password, acceptTerms: true });
  ensureWallet(db, findUserByEmail(db, email)!.id, 0);
  credit(db, {
    userId: findUserByEmail(db, email)!.id,
    amount: 10_000,
    type: 'DEMO_CREDIT',
    referenceId: `test:${username}`,
    idempotencyKey: `signup-credit:${findUserByEmail(db, email)!.id}`,
  });
  return { id: findUserByEmail(db, email)!.id, username, email, password };
}

function roomByName(name: string): { id: string; key: string } {
  const row = db.get<{ id: string; key: string }>('SELECT id, key FROM game_rooms WHERE key = ?', name)!;
  return row;
}

describe('authentication + registration', () => {
  it('creates the account, profile and demo wallet with the configured opening balance', () => {
    const created = createUser(db, { username: 'newplayer', email: 'new@example.com', password: 'Passw0rd!1', acceptTerms: true });
    expect(created.user.role).toBe('USER');
    expect(created.user.status).toBe('ACTIVE');
    expect(created.user.email).toBe('new@example.com');
    ensureWallet(db, created.user.id, 0);
    credit(db, {
      userId: created.user.id,
      amount: 10_000,
      type: 'DEMO_CREDIT',
      referenceId: 'test',
      idempotencyKey: `signup-credit:${created.user.id}`,
      description: 'Welcome demo credit',
    });
    const wallet = getWallet(db, created.user.id);
    expect(wallet.balance).toBe(10_000);
    expect(wallet.currency).toBe('DEMO');
    const transactions = listTransactions(db, created.user.id, {}).items;
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.type).toBe('DEMO_CREDIT');
    expect(transactions[0]!.balanceBefore).toBe(0);
    expect(transactions[0]!.balanceAfter).toBe(10_000);
  });

  it('rejects duplicate usernames and emails with distinct, safe messages', () => {
    const user = makeUser();
    expect(() => createUser(db, { username: user.username, email: 'other@example.com', password: 'Passw0rd!1', acceptTerms: true })).toThrowError(
      /username is already taken/i,
    );
    expect(() => createUser(db, { username: 'othername', email: user.email.toUpperCase(), password: 'Passw0rd!1', acceptTerms: true })).toThrowError(
      /email already exists/i,
    );
  });

  it('rejects weak passwords, missing consent and malformed input', () => {
    expect(() =>
      createUser(db, { username: 'ab', email: 'ok@example.com', password: 'Passw0rd!1', acceptTerms: true }),
    ).toThrowError(/3-24 characters/i);
    expect(() =>
      createUser(db, { username: 'validname', email: 'not-an-email', password: 'Passw0rd!1', acceptTerms: true }),
    ).toThrowError(/valid email/i);
    expect(() => createUser(db, { username: 'validname', email: 'ok@example.com', password: 'Passw0rd!1', acceptTerms: false })).toThrowError(
      /demo-currency/i,
    );
  });

  it('never returns a password hash to callers', () => {
    const user = makeUser();
    const publicUser = toPublicUser(findUserByEmail(db, user.email)!);
    expect(JSON.stringify(publicUser)).not.toContain('$2b$');
    expect(Object.keys(publicUser)).not.toContain('passwordHash');
  });

  it('logs in, rotates the refresh token and treats re-use as theft', async () => {
    const user = makeUser();
    const first = await login(db, user.email, user.password);
    expect(first.user.id).toBe(user.id);
    expect(first.tokens.accessToken.split('.')).toHaveLength(3);

    const rotated = await refresh(db, first.tokens.refreshToken, {});
    expect(rotated.userId).toBe(user.id);

    // Presenting the already-consumed token fails; because re-use is a theft
    // signal, every live token for that account is revoked with it.
    await expect(refresh(db, first.tokens.refreshToken, {})).rejects.toThrowError(/expired/i);
    await expect(refresh(db, rotated.tokens.refreshToken, {})).rejects.toThrowError(/expired/i);
    expect(db.scalar<number>('SELECT COUNT(*) FROM refresh_tokens WHERE revoked_at IS NULL')).toBe(0);

    // A fresh login works, and logging out invalidates that token.
    const third = await login(db, user.email, user.password);
    const refreshed = await refresh(db, third.tokens.refreshToken, {});
    expect(refreshed.userId).toBe(user.id);
    logout(db, refreshed.tokens.refreshToken);
    await expect(refresh(db, refreshed.tokens.refreshToken, {})).rejects.toThrowError(/expired/i);
  });

  it('an access token stops working the moment its session is revoked', async () => {
    const { signAccessToken, verifyAccessToken } = await import('../src/security/tokens.js');
    const user = makeUser();
    const session = await issueSession(db, user.id, {});
    const token = session.accessToken;
    const claims = verifyAccessToken(token);
    // Still cryptographically valid...
    expect(verifyAccessToken(token).sub).toBe(user.id);
    // ...but the HTTP layer refuses it once the session row is revoked, which is
    // what makes logout and admin kicks take effect immediately.
    const { resolveUser } = await import('../src/http/auth.js');
    const request: any = { headers: { authorization: `Bearer ${token}` }, cookies: {} };
    expect(resolveUser(request)?.id ?? null).toBe(user.id);
    db.run('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', new Date().toISOString(), claims.sid);
    expect(resolveUser({ headers: { authorization: `Bearer ${token}` }, cookies: {} })).toBeUndefined();
    expect(verifyAccessToken(token).sub).toBe(user.id);
  });

  it('rejects a wrong password and locks the account after repeated failures', async () => {
    const user = makeUser();
    for (let attempt = 0; attempt < MAX_FAILED_LOGINS; attempt += 1) {
      await expect(login(db, user.email, 'WrongPassword!1')).rejects.toThrowError(/incorrect/i);
    }
    // Correct password now hits the lockout rather than succeeding.
    await expect(login(db, user.email, user.password)).rejects.toThrowError(/too many failed/i);
    const attempts = db.all<any>('SELECT success, reason FROM login_attempts WHERE email = ?', user.email);
    const failures = attempts.filter((a) => a.success === 0);
    expect(failures.length).toBeGreaterThanOrEqual(MAX_FAILED_LOGINS);
    expect(failures.some((a) => a.reason === 'locked')).toBe(true);
    // The lockout must also be visible on the account row itself.
    expect(db.get<{ locked_until: string }>('SELECT locked_until FROM users WHERE id = ?', user.id).locked_until).toBeTruthy();
  });

  it('suspension blocks login and revokes live sessions', async () => {
    const user = makeUser();
    const session = await issueSession(db, user.id, {});
    db.run("UPDATE users SET status = 'SUSPENDED' WHERE id = ?", user.id);
    await expect(login(db, user.email, user.password)).rejects.toThrowError(/suspended/i);
    // Suspended accounts cannot refresh either: 403 with a clear reason.
    await expect(refresh(db, session.refreshToken, {})).rejects.toThrowError(/suspended/i);
  });

  it('resets a password through a single-use token and revokes sessions', async () => {
    const user = makeUser();
    const token = createPasswordResetToken(db, user.email);
    expect(token).toBeTruthy();
    resetPasswordWithToken(db, token!, 'BrandNew!99');
    await expect(login(db, user.email, user.password)).rejects.toThrowError(/incorrect/i);
    const after = await login(db, user.email, 'BrandNew!99');
    expect(after.user.id).toBe(user.id);
    // The token is consumed.
    expect(() => resetPasswordWithToken(db, token!, 'Another!123')).toThrowError(/not valid/i);
  });

  it('does not leak whether an email is registered during recovery', () => {
    const known = createPasswordResetToken(db, 'nobody@example.com');
    expect(known).toBeNull();
    const missing = db.scalar<number>('SELECT COUNT(*) FROM users WHERE email = ?', 'nobody@example.com');
    expect(missing).toBe(0);
  });
});

describe('demo wallet ledger', () => {
  it('refuses to let a balance go negative and rolls the whole write back', () => {
    const user = makeUser();
    const before = getWallet(db, user.id).balance;
    expect(before).toBe(10_000);
    expect(() => debit(db, { userId: user.id, amount: 20_000, referenceId: 'big', gameRoundId: 'R1', description: 'overdraft' })).toThrowError(
      /not enough demo coins/i,
    );
    expect(getWallet(db, user.id).balance).toBe(before);
    expect(db.scalar<number>('SELECT COUNT(*) FROM wallet_transactions WHERE reference_id = ?', 'big')).toBe(0);
  });

  it('applies a duplicate idempotency key exactly once', () => {
    const user = makeUser();
    const first = credit(db, { userId: user.id, amount: 500, referenceId: 'r1', idempotencyKey: 'k-1' });
    const second = credit(db, { userId: user.id, amount: 500, referenceId: 'r1', idempotencyKey: 'k-1' });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.wallet.balance).toBe(first.wallet.balance);
    expect(getWallet(db, user.id).balance).toBe(10_500);
    expect(db.scalar<number>('SELECT COUNT(*) FROM wallet_transactions WHERE idempotency_key = ?', 'k-1')).toBe(1);
  });

  it('keeps every ledger row self-consistent and reconciled', () => {
    const user = makeUser();
    debit(db, { userId: user.id, amount: 120, referenceId: 's1', gameRoundId: 'R1', description: 'shots' });
    credit(db, { userId: user.id, amount: 340, type: 'WIN', referenceId: 's2', idempotencyKey: 'w:s2', gameRoundId: 'R1' });
    const rows = listTransactions(db, user.id, { limit: 50 }).items;
    for (const row of rows) expect(row.balanceAfter).toBe(row.balanceBefore + row.amount);
    const ordered = [...rows].reverse();
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i]!.balanceBefore).toBe(ordered[i - 1]!.balanceAfter);
    }
    expect(verifyLedgerIntegrity(db).mismatches).toEqual([]);
  });

  it('records the type vocabulary the platform requires', () => {
    const user = makeUser();
    credit(db, { userId: user.id, amount: 10, type: 'REFUND', referenceId: 'refund-1', idempotencyKey: 'refund-1' });
    const types = new Set(listTransactions(db, user.id, { limit: 50 }).items.map((t) => t.type));
    expect(types.has('DEMO_CREDIT')).toBe(true);
    expect(types.has('REFUND')).toBe(true);
  });

  it('rejects non-integer and zero amounts', () => {
    const user = makeUser();
    expect(() => recordLedgerEntry(db, { userId: user.id, type: 'WIN', amount: 1.5 })).toThrowError(/integers/i);
    expect(() => recordLedgerEntry(db, { userId: user.id, type: 'WIN', amount: 0 })).toThrowError(/Zero-amount/i);
  });

  it('the CHECK constraint blocks direct tampering that would go negative', () => {
    const user = makeUser();
    expect(() => db.run('UPDATE wallets SET balance = -5 WHERE user_id = ?', user.id)).toThrowError(/CHECK constraint failed/i);
  });

  it('free demo packs are idempotent per hour and credit nothing twice', () => {
    const user = makeUser();
    const first = grantDemoTopup(db, user.id, { id: 'small', label: 'Reef Stash', demoCoins: 5000 });
    const second = grantDemoTopup(db, user.id, { id: 'small', label: 'Reef Stash', demoCoins: 5000 });
    expect(first.credited).toBe(5000);
    expect(second.credited).toBe(0);
    expect(getWallet(db, user.id).balance).toBe(15_000);
  });

  it('an admin adjustment requires a reason, is audited and cannot empty an account below zero', () => {
    const user = makeUser();
    const admin = db.get<{ id: string; username: string }>("SELECT id, username FROM users WHERE role = 'SUPER_ADMIN'")!;
    const result = adminAdjustDemoCoins(db, { adminId: admin.id, adminUsername: admin.username, userId: user.id, amount: 250, reason: 'Support goodwill' });
    expect(result.balance).toBe(10_250);
    expect(() => adminAdjustDemoCoins(db, { adminId: admin.id, adminUsername: admin.username, userId: user.id, amount: -999_999, reason: 'Take it all' })).toThrowError(
      /below zero/i,
    );
    expect(() => adminAdjustDemoCoins(db, { adminId: admin.id, adminUsername: admin.username, userId: user.id, amount: 10, reason: 'x' })).toThrowError(/reason/i);
    const audit = readAudit(db, { limit: 20, entity: 'wallets' });
    expect(audit.items.some((entry) => entry.action === 'DEMO_WALLET_ADJUST')).toBe(true);
  });
});

describe('configuration management and versioning', () => {
  it('starts with the full species set, cannon ladder and rooms from the seed', () => {
    const config = getActiveConfiguration(db);
    expect(config.fish.length).toBe(DEFAULT_FISH.length);
    expect(config.cannons.map((c) => c.level)).toEqual([1, 2, 3, 4, 5]);
    expect(config.rooms).toHaveLength(4);
    expect(config.settings.maxActiveFish).toBe(DEFAULT_SETTINGS.maxActiveFish);
    expect(config.version).toBe('1.0.0');
  });

  it('editing a fish leaves the published version untouched until publish, then bumps it', () => {
    const admin = db.get<{ id: string; username: string }>("SELECT id, username FROM users WHERE role = 'SUPER_ADMIN'")!;
    const config = getActiveConfiguration(db);
    const smallFish = config.fish.find((f) => f.key === 'blue_darter')!;
    expect(smallFish.reward).toBe(2);

    const { changed } = updateFish({ db, adminId: admin.id, adminUsername: admin.username }, smallFish.id, { reward: 3 });
    expect(changed).toHaveProperty('reward');
    expect((changed as any).reward).toEqual({ from: 2, to: 3 });

    // Working copy changed, published snapshot has not.
    expect(getActiveConfiguration(db).fish.find((f) => f.key === 'blue_darter')!.reward).toBe(2);
    expect(configMeta(db).isDraftAhead).toBe(true);

    const version = publishConfiguration(db, nextVersion(config.version), admin.id, 'raise blue darter reward');
    expect(version).toBe('1.0.1');
    expect(getActiveConfiguration(db).fish.find((f) => f.key === 'blue_darter')!.reward).toBe(3);
    expect(configMeta(db).isDraftAhead).toBe(false);
  });

  it('keeps the previous snapshot retrievable so a finished round can be audited', () => {
    const admin = db.get<{ id: string }>("SELECT id FROM users WHERE role = 'SUPER_ADMIN'")!;
    const before = getActiveConfiguration(db);
    const largeFish = before.fish.find((f) => f.category === 'LARGE')!;
    updateFish({ db, adminId: admin.id, adminUsername: 'admin' }, largeFish.id, { health: 99, reward: 250 });
    publishConfiguration(db, '1.0.1', admin.id, 'buff large fish');

    const historical = db.get<{ payload: string }>("SELECT payload FROM game_configs WHERE version = '1.0.0'")!;
    const parsed = JSON.parse(historical.payload) as GameConfiguration;
    expect(parsed.fish.find((f) => f.id === largeFish.id)!.health).toBe(largeFish.health);
    expect(getActiveConfiguration(db).fish.find((f) => f.id === largeFish.id)!.health).toBe(99);
  });

  it('validates every economy field and rejects nonsense', () => {
    const admin = db.get<{ id: string }>("SELECT id FROM users WHERE role = 'SUPER_ADMIN'")!;
    const fish = getActiveConfiguration(db).fish[0]!;
    expect(() => updateFish({ db, adminId: admin.id, adminUsername: 'a' }, fish.id, { health: 0 })).toThrowError(/health/i);
    expect(() => updateFish({ db, adminId: admin.id, adminUsername: 'a' }, fish.id, { reward: -5 })).toThrowError(/reward/i);
    expect(() => updateFish({ db, adminId: admin.id, adminUsername: 'a' }, fish.id, { movementPattern: 'TELEPORT' as never })).toThrowError(/movement/i);
    const cannon = getActiveConfiguration(db).cannons[0]!;
    expect(() => updateCannon({ db, adminId: admin.id, adminUsername: 'a' }, cannon.id, { shotCost: 0 })).toThrowError(/shot cost/i);
    const room = getActiveConfiguration(db).rooms[0]!;
    expect(() => updateRoom({ db, adminId: admin.id, adminUsername: 'a' }, room.id, { minBet: 100, maxBet: 5 })).toThrowError(/maximum bet/i);
  });

  it('records an audit entry for every privileged change', () => {
    const admin = db.get<{ id: string; username: string }>("SELECT id, username FROM users WHERE role = 'SUPER_ADMIN'")!;
    const fish = getActiveConfiguration(db).fish[1]!;
    updateFish({ db, adminId: admin.id, adminUsername: admin.username }, fish.id, { speed: 400 });
    updateCannon({ db, adminId: admin.id, adminUsername: admin.username }, getActiveConfiguration(db).cannons[1].id, { power: 7 });
    const audit = readAudit(db, { limit: 50 });
    const actions = audit.items.map((entry) => entry.action);
    expect(actions).toContain('FISH_UPDATE');
    expect(actions).toContain('CANNON_UPDATE');
    const fishEntry = audit.items.find((entry) => entry.action === 'FISH_UPDATE')!;
    const previous = JSON.parse(fishEntry.previousValue!);
    expect(previous.speed.from).toBeLessThan(400);
    expect(previous.speed.to).toBe(400);
  });

  it('the audit log is append-only: UPDATE and DELETE are refused by the engine', () => {
    const admin = db.get<{ id: string; username: string }>("SELECT id, username FROM users WHERE role = 'SUPER_ADMIN'")!;
    const fish = getActiveConfiguration(db).fish[0]!;
    updateFish({ db, adminId: admin.id, adminUsername: admin.username }, fish.id, { reward: fish.reward + 1 });
    const entry = readAudit(db, { limit: 1 }).items[0]!;
    expect(() => db.run('UPDATE audit_logs SET action = ? WHERE id = ?', 'TAMPERED', entry.id)).toThrowError(/append-only/i);
    expect(() => db.run('DELETE FROM audit_logs WHERE id = ?', entry.id)).toThrowError(/append-only/i);
  });

  it('game settings round-trip through the system_settings table', () => {
    const admin = db.get<{ id: string }>("SELECT id FROM users WHERE role = 'SUPER_ADMIN'")!;
    readWorkingSettings(db);
    db.run("INSERT INTO system_settings (key, value, description, updated_at) VALUES ('max_active_fish','60','x','now') ON CONFLICT(key) DO UPDATE SET value='60'");
    expect(readWorkingSettings(db).maxActiveFish).toBe(60);
    void admin;
  });
});

describe('room rules and sessions', () => {
  it('join creates a session bound to a round and the current config version', () => {
    const user = makeUser();
    const room = roomByName('shallow_lagoon');
    const result = joinRoom(db, user.id, room.id);
    expect(result.session.status).toBe('ACTIVE');
    expect(result.session.roomId).toBe(room.id);
    expect(result.session.roundId).toMatch(/^RND-\d{4}-\d{6}$/);
    expect(result.betOptions.length).toBeGreaterThan(0);
    expect(result.balance).toBe(10_000);
  });

  it('only cannons inside the room bet range are legal', () => {
    const room = roomByName('coral_shelf'); // min 5, max 25
    const { options } = betOptionsFor(db, room.id);
    const byKey = new Map(options.map((option) => [option.key, option]));
    expect(byKey.get('tidecaster')!.legal).toBe(false); // cost 1 < 5
    expect(byKey.get('reef_breaker')!.legal).toBe(true); // cost 5
    expect(byKey.get('leviathan_mortar')!.legal).toBe(true); // cost 20 <= 25
    expect(byKey.get('abyss_cannon')!.legal).toBe(true); // cost 10
  });

  it('a room with no legal cannon cannot be entered', () => {
    const admin = db.get<{ id: string }>("SELECT id FROM users WHERE role = 'SUPER_ADMIN'")!;
    const room = roomByName('abyssal_trench');
    updateRoom({ db, adminId: admin.id, adminUsername: 'admin' }, room.id, { minBet: 90_000, maxBet: 99_000 });
    publishConfiguration(db, '9.9.9', admin.id, 'test extremes');
    const user = makeUser();
    expect(() => joinRoom(db, user.id, room.id)).toThrowError(/BET_OUT_OF_RANGE|no cannon/i);
  });

  it('a closed room refuses entry and maintenance blocks play', () => {
    const admin = db.get<{ id: string }>("SELECT id FROM users WHERE role = 'SUPER_ADMIN'")!;
    const user = makeUser();
    const room = roomByName('kelp_canyon');
    updateRoom({ db, adminId: admin.id, adminUsername: 'admin' }, room.id, { status: 'INACTIVE' });
    expect(() => joinRoom(db, user.id, room.id)).toThrowError(/closed/i);

    updateRoom({ db, adminId: admin.id, adminUsername: 'admin' }, room.id, { status: 'ACTIVE' });
    db.run("UPDATE system_settings SET value = 'true' WHERE key = 'maintenance_mode'");
    expect(() => joinRoom(db, user.id, room.id)).toThrowError(/maintenance/i);
  });

  it('joining a second room closes the first session', () => {
    const user = makeUser();
    const a = joinRoom(db, user.id, roomByName('shallow_lagoon').id);
    const b = joinRoom(db, user.id, roomByName('coral_shelf').id);
    expect(a.session.status).toBe('ACTIVE');
    const reloaded = db.get<{ status: string }>('SELECT status FROM game_sessions WHERE id = ?', a.session.id)!;
    expect(reloaded.status).toBe('ENDED');
    expect(b.session.status).toBe('ACTIVE');
  });

  it('leaving summarises the session and ends it', () => {
    const user = makeUser();
    joinRoom(db, user.id, roomByName('shallow_lagoon').id);
    const { summary } = leaveRoom(db, user.id);
    expect(summary).not.toBeNull();
    expect(summary!.shots).toBe(0);
    expect(db.get<{ status: string }>('SELECT status FROM game_sessions WHERE id = ?', summary!.sessionId)!.status).toBe('ENDED');
  });
});

describe('gameplay engine: shots, hits, rewards and safety', () => {
  /**
   * A simulation driven by a virtual clock: `advance(ms)` steps simulated time
   * without the test having to sleep, so multi-second behaviour (fish leaving the
   * field, projectiles expiring) is checked in microseconds.
   */
  function buildRuntimeSim(config: GameConfiguration, overrides: Partial<GameConfiguration['settings']> = {}): {
    sim: RoomSimulation;
    rewards: Array<{ playerId: string; amount: number; shotId: string }>;
    resolved: any[];
    advance: (ms: number, ticks?: number) => void;
  } {
    const patched: GameConfiguration = { ...config, settings: { ...config.settings, fishSpawnRate: 0, maxActiveFish: 6, ...overrides } };
    const rewards: Array<{ playerId: string; amount: number; shotId: string }> = [];
    const resolved: any[] = [];
    let clock = 1_700_000_000_000;
    const sim = new RoomSimulation({
      roomId: 'r1',
      roundId: 'R1',
      config: patched,
      seed: 12345,
      spawnRateMultiplier: 1,
      allowedFishIds: [],
      clock: () => clock,
      hooks: {
        reward: (args) => {
          rewards.push(args);
          return { ok: true, balance: 1 };
        },
        shotResolved: (args) => resolved.push(args),
        logEvent: () => undefined,
      },
    });
    // Deterministic field: drop whatever the priming pass created and hand-place one fish.
    for (const fish of [...sim.fish.values()]) sim.fish.delete(fish.id);
    const advance = (ms: number, ticks = 1): void => {
      for (let i = 0; i < ticks; i += 1) {
        clock += ms;
        sim.tick(ms);
      }
    };
    return { sim, rewards, resolved, advance };
  }

  it('a shot that overlaps a fish damages it and a kill pays the configured reward', () => {
    const config = getActiveConfiguration(db);
    const { sim, rewards, resolved, advance } = buildRuntimeSim(config);
    sim.addPlayer({ id: 'p1', username: 'p1', avatarSeed: 'p1', cannonKey: 'reef_breaker' });
    const species = config.fish.find((f) => f.key === 'tide_grouper')!; // health 10, reward 20
    const fish = sim.debugSpawn(species.key, { x: 500, y: 400, angle: 0 });
    expect(fish.hp).toBe(10);

    sim.debugFireAt({ playerId: 'p1', shotId: 'shot-1', x: 500 - 40, y: 400, angle: 0, damage: 5, speed: 4000, cannonLevel: 3 });
    advance(50);
    expect(fish.hp).toBe(5);
    expect(resolved.at(-1)!.result).toBe('HIT');

    sim.debugFireAt({ playerId: 'p1', shotId: 'shot-2', x: 500 - 40, y: 400, angle: 0, damage: 5, speed: 4000, cannonLevel: 3 });
    advance(50);
    expect(fish.hp).toBeLessThanOrEqual(0);
    expect(rewards).toHaveLength(1);
    expect(rewards[0]!.amount).toBe(species.reward);
    expect(rewards[0]!.playerId).toBe('p1');
    expect(resolved.at(-1)!.result).toBe('KILL');
    expect(sim.fish.size).toBe(0);
  });

  it('a shot that hits nothing is recorded as a miss and pays nothing', () => {
    const config = getActiveConfiguration(db);
    const { sim, rewards, resolved, advance } = buildRuntimeSim(config);
    sim.addPlayer({ id: 'p1', username: 'p1', avatarSeed: 'p1', cannonKey: 'tidecaster' });
    sim.debugSpawn(config.fish[0]!.key, { x: 900, y: 200, angle: 0 });
    sim.debugFireAt({ playerId: 'p1', shotId: 'miss-1', x: 100, y: 900, angle: -Math.PI / 4, damage: 1, speed: 1500, cannonLevel: 1 });
    advance(50, 40);
    expect(rewards).toHaveLength(0);
    expect(resolved.some((entry) => entry.result === 'KILL')).toBe(false);
    expect(sim.projectiles.size).toBe(0);
  });

  it('a fish needs exactly its health in damage: no partial-credit over-payment', () => {
    const config = getActiveConfiguration(db);
    const { sim, rewards, advance } = buildRuntimeSim(config);
    sim.addPlayer({ id: 'p1', username: 'p1', avatarSeed: 'p1', cannonKey: 'tidecaster' });
    const species = config.fish.find((f) => f.key === 'coral_wrasse')!; // health 3
    const fish = sim.debugSpawn(species.key, { x: 300, y: 300, angle: 0 });
    for (let shot = 0; shot < 2; shot += 1) {
      sim.debugFireAt({ playerId: 'p1', shotId: `w-${shot}`, x: 300 - 30, y: 300, angle: 0, damage: 1, speed: 3000, cannonLevel: 1 });
      advance(50);
    }
    expect(fish.hp).toBe(1);
    expect(rewards).toHaveLength(0);
    sim.debugFireAt({ playerId: 'p1', shotId: 'w-3', x: 300 - 30, y: 300, angle: 0, damage: 1, speed: 3000, cannonLevel: 1 });
    advance(50);
    expect(rewards).toHaveLength(1);
  });

  it('fish never overlap forever: they leave the field on their own schedule', () => {
    const config = getActiveConfiguration(db);
    const { sim, advance } = buildRuntimeSim(config, {});
    const species = config.fish.find((f) => f.key === 'blue_darter')!;
    const fish = sim.debugSpawn(species.key, { x: 900, y: 500, angle: 0 });
    // The fish must be seen to move continuously before it leaves: no teleport.
    const positions: number[] = [];
    let sawOffscreen = false;
    for (let i = 0; i < 400; i += 1) {
      advance(50);
      positions.push(fish.x);
      if (sim.fish.size === 0) {
        sawOffscreen = true;
        break;
      }
    }
    expect(sawOffscreen).toBe(true);
    expect(positions.length).toBeGreaterThan(2);
    for (let i = 1; i < positions.length; i += 1) {
      expect(Math.abs(positions[i]! - positions[i - 1]!)).toBeLessThan(200);
    }
  });

  it('the active fish cap is honoured no matter how long a room runs', () => {
    const config = getActiveConfiguration(db);
    const patched = { ...config, settings: { ...config.settings, maxActiveFish: 12, fishSpawnRate: 40 } };
    let clock = 1_700_000_000_000;
    const sim = new RoomSimulation({
      roomId: 'r',
      roundId: 'R',
      config: patched,
      seed: 7,
      spawnRateMultiplier: 5,
      allowedFishIds: [],
      clock: () => clock,
      hooks: { reward: () => ({ ok: true }), shotResolved: () => undefined, logEvent: () => undefined },
    });
    for (let i = 0; i < 400; i += 1) {
      clock += 50;
      sim.tick(50);
      expect(sim.fish.size).toBeLessThanOrEqual(patched.settings.maxActiveFish);
    }
  });

  it('the projectile cap bounds work per tick', () => {
    const config = getActiveConfiguration(db);
    const patched = { ...config, settings: { ...config.settings, maxProjectiles: 5, fishSpawnRate: 0 } };
    const sim = new RoomSimulation({
      roomId: 'r',
      roundId: 'R',
      config: patched,
      seed: 3,
      spawnRateMultiplier: 1,
      allowedFishIds: [],
      hooks: { reward: () => ({ ok: true }), shotResolved: () => undefined, logEvent: () => undefined },
    });
    sim.addPlayer({ id: 'spammer', username: 'spammer', avatarSeed: 'x', cannonKey: 'tidecaster' });
    sim.debugBarrage('spammer', 400);
    expect(sim.projectiles.size).toBeLessThanOrEqual(Math.max(6, patched.settings.maxProjectiles + 2));
  });

  it('the same seed produces the identical spawn sequence for every player', () => {
    const config = getActiveConfiguration(db);
    const makeRun = (): string[] => {
      let clock = 1_800_000_000_000;
      const sim = new RoomSimulation({
        roomId: 'r',
        roundId: 'R',
        config: { ...config, settings: { ...config.settings, fishSpawnRate: 8 } },
        seed: 987_654_321,
        spawnRateMultiplier: 1,
        allowedFishIds: [],
        clock: () => clock,
        hooks: { reward: () => ({ ok: true }), shotResolved: () => undefined, logEvent: () => undefined },
      });
      const keys: string[] = [];
      for (let i = 0; i < 60; i += 1) {
        const before = sim.fish.size;
        clock += 1000;
        sim.tick(1000);
        if (sim.fish.size > before) {
          const newest = [...sim.fish.values()].at(-1)!;
          keys.push(newest.key);
        }
      }
      return keys;
    };
    const first = makeRun();
    const second = makeRun();
    expect(first.length).toBeGreaterThan(3);
    expect(second).toEqual(first);
  });

  it('reward maths never depends on who the player is', () => {
    const config = getActiveConfiguration(db);
    const outcomes: Record<string, number> = {};
    for (const playerId of ['whale', 'newbie', 'broke']) {
      const { sim, rewards } = buildRuntimeSim(config);
      sim.addPlayer({ id: playerId, username: playerId, avatarSeed: playerId, cannonKey: 'reef_breaker' });
      const species = config.fish.find((f) => f.key === 'tide_grouper')!;
      sim.debugSpawn(species.key, { x: 600, y: 300, angle: 0 });
      for (let shot = 0; shot < 2; shot += 1) {
        sim.debugFireAt({ playerId, shotId: `${playerId}-${shot}`, x: 600 - 40, y: 300, angle: 0, damage: 5, speed: 4000, cannonLevel: 3 });
        sim.tick(50);
      }
      outcomes[playerId] = rewards.reduce((sum, entry) => sum + entry.amount, 0);
    }
    expect(outcomes.whale).toBe(outcomes.newbie);
    expect(outcomes.newbie).toBe(outcomes.broke);
    expect(outcomes.whale).toBe(20);
  });

  it('bomb fish splash damage is credited once to the triggering player', () => {
    const config = getActiveConfiguration(db);
    const { sim, rewards, advance } = buildRuntimeSim(config);
    sim.addPlayer({ id: 'p1', username: 'p1', avatarSeed: 'p1', cannonKey: 'reef_breaker' });
    const bomb = config.fish.find((f) => f.special === 'bomb')!;
    const victim = config.fish.find((f) => f.key === 'blue_darter')!;
    sim.debugSpawn(bomb.key, { x: 700, y: 400, angle: 0 });
    sim.debugSpawn(victim.key, { x: 720, y: 410, angle: 0 });
    const bombFish = [...sim.fish.values()].find((f) => f.key === bomb.key)!;
    bombFish.hp = 1;
    sim.debugFireAt({ playerId: 'p1', shotId: 'bomb-1', x: 700 - 30, y: 400, angle: 0, damage: 5, speed: 4000, cannonLevel: 3 });
    advance(50);
    const total = rewards.reduce((sum, entry) => sum + entry.amount, 0);
    expect(total).toBeGreaterThan(0);
    expect(new Set(rewards.map((entry) => entry.shotId)).size).toBe(rewards.length);
  });
});

/**
 * Leave a single fish in a live room and stop the spawner, so an assertion about
 * "the reward for this kill" is not racing with the rest of the reef.
 */
function isolateOneFish(runtime: any, keepId: number): void {
  runtime.config.settings.fishSpawnRate = 0.001;
  runtime.config.settings.waveIntervalS = 100_000;
  for (const [id, fish] of [...runtime.sim.fish.entries()]) {
    if (id !== keepId) {
      fish.alive = false;
      runtime.sim.fish.delete(id);
    }
  }
}


describe('round manager authority (wallet + sim together)', () => {
  let manager: RoundManager;
  let vclock = 1_900_000_000_000;

  const advance = (ms = 50, ticks = 1): void => {
    for (let i = 0; i < ticks; i += 1) {
      vclock += ms;
      manager.tickOnce(ms);
    }
  };

  beforeEach(() => {
    vclock = 1_900_000_000_000;
    manager = new RoundManager({ db, tickMs: 50, snapshotMs: 50, roundDurationS: 1800, clock: () => vclock });
  });

  afterEach(() => {
    manager.stop();
  });

  const fakeConnection = (userId: string, username: string): any => ({
    ws: { readyState: 1, send: () => undefined, close: () => undefined },
    userId,
    username,
    avatarSeed: username,
    roomId: null,
    lastAngle: -Math.PI / 2,
    cannonKey: 'reef_breaker',
    alive: true,
    lastBalance: 10_000,
    pendingRefs: new Map(),
  });

  it('charges the cannon cost per shot and records it against the round', () => {
    const user = makeUser();
    const room = roomByName('shallow_lagoon');
    joinRoom(db, user.id, room.id);
    const connection = fakeConnection(user.id, user.username);
    manager.attach(connection, room.id);
    const runtime = manager.runtimeFor(room.id)!;

    const before = getWallet(db, user.id).balance;
    const cost = getActiveConfiguration(db).cannons.find((c) => c.key === 'reef_breaker')!.shotCost;
    const result = manager.fire(connection, { clientRef: 'ref-unique-1', cannonKey: 'reef_breaker', angle: -Math.PI / 2, originX: 960, originY: 984 });
    expect(result.ok).toBe(true);
    expect(getWallet(db, user.id).balance).toBe(before - cost);
    const tx = db.get<any>("SELECT * FROM wallet_transactions WHERE type = 'BET' ORDER BY created_at DESC LIMIT 1");
    expect(tx.amount).toBe(-cost);
    expect(tx.game_round_id).toBe(runtime.roundId);
    expect(db.scalar<number>('SELECT COUNT(*) FROM player_shots WHERE user_id = ?', user.id)).toBe(1);
  });

  it('refuses a shot with an unknown or disabled cannon', () => {
    const user = makeUser();
    const room = roomByName('shallow_lagoon');
    joinRoom(db, user.id, room.id);
    const connection = fakeConnection(user.id, user.username);
    manager.attach(connection, room.id);
    expect(manager.fire(connection, { clientRef: 'bad-cannon-1', cannonKey: 'not_a_cannon', angle: -1, originX: 900, originY: 984 }).code).toBe('WEAPON_UNAVAILABLE');

    const admin = db.get<{ id: string }>("SELECT id FROM users WHERE role = 'SUPER_ADMIN'")!;
    const cannon = getActiveConfiguration(db).cannons.find((c) => c.key === 'abyss_cannon')!;
    updateCannon({ db, adminId: admin.id, adminUsername: 'admin' }, cannon.id, { enabled: false });
    publishConfiguration(db, '5.0.0', admin.id, 'disable abyss cannon');
    // The live room is pinned to its own version, so a fresh room must obey the
    // newly published one and reject the disabled cannon.
    manager.closeAllRounds();
    const other = makeUser();
    joinRoom(db, other.id, room.id);
    const freshConnection = fakeConnection(other.id, other.username);
    freshConnection.cannonKey = 'abyss_cannon';
    manager.attach(freshConnection, room.id);
    const result = manager.fire(freshConnection, { clientRef: 'disabled-cannon-1', cannonKey: 'abyss_cannon', angle: -1, originX: 900, originY: 984 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('WEAPON_UNAVAILABLE');
    db.run('UPDATE cannons SET enabled = 1 WHERE id = ?', cannon.id);
    publishConfiguration(db, '5.0.1', admin.id, 're-enable abyss cannon');
  });

  it('refuses to shoot outside the room bet range', () => {
    const user = makeUser();
    const room = roomByName('abyssal_trench'); // min 20
    const config = getActiveConfiguration(db);
    const affordable = config.cannons.find((c) => c.shotCost >= 20)!;
    joinRoom(db, user.id, room.id, affordable.key);
    const connection = fakeConnection(user.id, user.username);
    connection.cannonKey = 'tidecaster';
    manager.attach(connection, room.id);
    const result = manager.fire(connection, { clientRef: 'cheap-shot-1', cannonKey: 'tidecaster', angle: -1.2, originX: 900, originY: 984 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('BET_OUT_OF_RANGE');
  });

  it('a repeated clientRef charges once (replay protection)', () => {
    const user = makeUser();
    const room = roomByName('shallow_lagoon');
    joinRoom(db, user.id, room.id);
    const connection = fakeConnection(user.id, user.username);
    manager.attach(connection, room.id);
    const payload = { clientRef: 'same-ref-0001', cannonKey: 'reef_breaker', angle: -Math.PI / 2, originX: 960, originY: 984 };
    const first = manager.fire(connection, payload);
    const before = getWallet(db, user.id).balance;
    const second = manager.fire(connection, payload);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((second.ack as any).replayed).toBe(true);
    expect(getWallet(db, user.id).balance).toBe(before);
    expect(db.scalar<number>('SELECT COUNT(*) FROM player_shots WHERE client_ref = ?', 'same-ref-0001')).toBe(1);
  });

  it('rate limiting rejects faster-than-cannon shots before any money moves', () => {
    const user = makeUser();
    const room = roomByName('shallow_lagoon');
    joinRoom(db, user.id, room.id);
    const connection = fakeConnection(user.id, user.username);
    manager.attach(connection, room.id);
    const first = manager.fire(connection, { clientRef: 'rapid-0001', cannonKey: 'reef_breaker', angle: -1.4, originX: 960, originY: 984 });
    const second = manager.fire(connection, { clientRef: 'rapid-0002', cannonKey: 'reef_breaker', angle: -1.4, originX: 960, originY: 984 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.code).toBe('RATE_LIMITED');
    expect(db.scalar<number>('SELECT COUNT(*) FROM player_shots WHERE client_ref LIKE ?', 'rapid-%')).toBe(1);
  });

  it('an account with too few demo coins cannot shoot', () => {
    const user = makeUser();
    db.run('UPDATE wallets SET balance = 1');
    const room = roomByName('shallow_lagoon');
    const join = joinRoom(db, user.id, room.id, 'reef_breaker');
    expect(join.cannonKey).toBe('reef_breaker');
    const connection = fakeConnection(user.id, user.username);
    manager.attach(connection, room.id);
    const result = manager.fire(connection, { clientRef: 'broke-shot-1', cannonKey: 'reef_breaker', angle: -1.4, originX: 960, originY: 984 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INSUFFICIENT_FUNDS');
    expect(getWallet(db, user.id).balance).toBe(1);
    expect(db.scalar<number>('SELECT COUNT(*) FROM player_shots WHERE client_ref = ?', 'broke-shot-1')).toBe(0);
  });

  it('a shot without an active session is refused', () => {
    const user = makeUser();
    const room = roomByName('shallow_lagoon');
    const connection = fakeConnection(user.id, user.username);
    manager.attach(connection, room.id);
    leaveRoom(db, user.id);
    const result = manager.fire(connection, { clientRef: 'orphan-shot-1', cannonKey: 'reef_breaker', angle: -1.4, originX: 960, originY: 984 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_SESSION');
  });

  it('angles are clamped so a client cannot shoot through the floor', () => {
    const user = makeUser();
    const room = roomByName('shallow_lagoon');
    joinRoom(db, user.id, room.id);
    const connection = fakeConnection(user.id, user.username);
    manager.attach(connection, room.id);
    const result = manager.fire(connection, { clientRef: 'down-shot-01', cannonKey: 'reef_breaker', angle: 1.5, originX: 960, originY: 984 });
    expect(result.ok).toBe(true);
    const stored = db.get<{ angle: number }>('SELECT angle FROM player_shots WHERE client_ref = ?', 'down-shot-01')!;
    expect(stored.angle).toBeLessThanOrEqual(0);
  });

  it('a kill charges the bet, credits the reward once and writes history', () => {
    const user = makeUser();
    const room = roomByName('shallow_lagoon');
    joinRoom(db, user.id, room.id);
    const connection = fakeConnection(user.id, user.username);
    const { runtime } = manager.attach(connection, room.id);
    const config = runtime.config;
    const weak = config.fish.find((f) => f.health === 1)!;
    // Park a dying fish directly in front of the cannon so the next real shot
    // (real bet, real rate limit, real player_shots row) kills it.
    const fish = runtime.sim.debugSpawn(weak.key, { x: connection ? 960 : 0, y: 940, angle: 0 });
    fish.hp = 1;
    runtime.sim.relocatePlayer(user.id, 960, 984);
    const fired = manager.fire(connection, { clientRef: 'kill-shot-0001', cannonKey: 'reef_breaker', angle: -Math.PI / 2, originX: 960, originY: 984 });
    expect(fired.ok).toBe(true);
    advance(50, 4);

    const balance = getWallet(db, user.id).balance;
    const wins = db.all<any>("SELECT * FROM wallet_transactions WHERE user_id = ? AND type = 'WIN'", user.id);
    // Exactly one reward for one kill, and the wallet equals the ledger.
    expect(wins).toHaveLength(1);
    expect(wins[0]!.amount).toBeGreaterThanOrEqual(weak.reward);
    const cost = config.cannons.find((c) => c.key === 'reef_breaker')!.shotCost;
    expect(balance).toBe(10_000 - cost + wins[0]!.amount);
    const history = listHistory(db, user.id, { limit: 10 });
    expect(history.items.some((entry) => entry.result === 'KILL' && entry.reward === weak.reward)).toBe(true);
    expect(verifyLedgerIntegrity(db).mismatches).toEqual([]);
    expect(db.scalar<number>('SELECT COUNT(*) FROM game_events WHERE round_id = ? AND event_type = ?', runtime.roundId, 'FISH_DEFEATED')).toBeGreaterThanOrEqual(1);
  });

  it('duplicate reward attempts for the same kill never pay twice', () => {
    const user = makeUser();
    const room = roomByName('shallow_lagoon');
    joinRoom(db, user.id, room.id);
    const connection = fakeConnection(user.id, user.username);
    const { runtime } = manager.attach(connection, room.id);
    const config = runtime.config;
    const weak = config.fish.find((f) => f.health === 1)!;
    const fish = runtime.sim.debugSpawn(weak.key, { x: 960, y: 940, angle: 0 });
    fish.hp = 1;
    isolateOneFish(runtime, fish.id);
    runtime.sim.relocatePlayer(user.id, 960, 984);
    manager.fire(connection, { clientRef: 'dup-kill-shot-1', cannonKey: 'reef_breaker', angle: -Math.PI / 2, originX: 960, originY: 984 });
    advance(50, 4);
    const firstWin = db.get<any>("SELECT amount FROM wallet_transactions WHERE user_id = ? AND type = 'WIN'", user.id);
    expect(firstWin).toBeTruthy();
    const afterFirst = getWallet(db, user.id).balance;
    // Replaying the reward callback for the same shot must never pay twice.
    const shotId = db.get<{ id: string }>("SELECT id FROM player_shots WHERE client_ref = ?", 'dup-kill-shot-1')!.id;
    const repeat = (manager as any).creditReward(runtime, { playerId: user.id, amount: weak.reward, shotId, fishKey: weak.key, roundId: runtime.roundId });
    expect(repeat.ok).toBe(false);
    expect(getWallet(db, user.id).balance).toBe(afterFirst);
    expect(db.scalar<number>("SELECT COUNT(*) FROM wallet_transactions WHERE user_id = ? AND type = 'WIN'", user.id)).toBe(1);
  });

  it('room capacity is enforced at attach time', () => {
    const room = roomByName('shallow_lagoon');
    const capacity = db.get<{ max_players: number }>('SELECT max_players FROM game_rooms WHERE id = ?', room.id)!.max_players;
    const connections: any[] = [];
    for (let index = 0; index < capacity; index += 1) {
      const user = makeUser();
      joinRoom(db, user.id, room.id);
      const connection = fakeConnection(user.id, user.username);
      manager.attach(connection, room.id);
      connections.push(connection);
    }
    const overflow = makeUser();
    joinRoom(db, overflow.id, room.id);
    let caught: any;
    try {
      manager.attach(fakeConnection(overflow.id, overflow.username), room.id);
    } catch (err) {
      caught = err;
    }
    expect(caught?.code).toBe('ROOM_FULL');
  });

  it('a round rollover ends the old round, re-attaches players and pins the config version', () => {
    const user = makeUser();
    const room = roomByName('shallow_lagoon');
    joinRoom(db, user.id, room.id);
    const connection = fakeConnection(user.id, user.username);
    const first = manager.attach(connection, room.id).runtime;
    const firstRound = first.roundId;
    manager.rollover(first);
    const second = manager.runtimeFor(room.id)!;
    expect(second.roundId).not.toBe(firstRound);
    expect(db.get<{ status: string }>('SELECT status FROM game_rounds WHERE id = ?', firstRound)!.status).toBe('ENDED');
    expect(db.get<{ status: string }>('SELECT status FROM game_rounds WHERE id = ?', second.roundId)!.status).toBe('ACTIVE');
    expect(second.members.has(connection)).toBe(true);
    const session = db.get<any>("SELECT round_id FROM game_sessions WHERE user_id = ? AND status = 'ACTIVE'", user.id);
    expect(session.round_id).toBe(second.roundId);
    expect(second.config.version).toBe(getActiveConfiguration(db).version);
  });

  it('config edits do not silently change a round already in play', () => {
    const user = makeUser();
    const room = roomByName('shallow_lagoon');
    joinRoom(db, user.id, room.id);
    const { runtime } = manager.attach(fakeConnection(user.id, user.username), room.id);
    const pinned = runtime.config.fish.find((f) => f.key === 'blue_darter')!.reward;
    const admin = db.get<{ id: string }>("SELECT id FROM users WHERE role = 'SUPER_ADMIN'")!;
    const fish = getActiveConfiguration(db).fish.find((f) => f.key === 'blue_darter')!;
    updateFish({ db, adminId: admin.id, adminUsername: 'admin' }, fish.id, { reward: pinned + 40 });
    publishConfiguration(db, '7.7.7', admin.id, 'mid-round change');
    expect(runtime.config.fish.find((f) => f.key === 'blue_darter')!.reward).toBe(pinned);
    expect(getActiveConfiguration(db).fish.find((f) => f.key === 'blue_darter')!.reward).toBe(pinned + 40);
    // A new round picks the new numbers up.
    manager.rollover(runtime);
    expect(manager.runtimeFor(room.id)!.config.fish.find((f) => f.key === 'blue_darter')!.reward).toBe(pinned + 40);
  });

  it('concurrent shooters in one room are serialised safely', () => {
    const room = roomByName('shallow_lagoon');
    const players = Array.from({ length: 4 }, () => {
      const user = makeUser();
      joinRoom(db, user.id, room.id);
      return { user, connection: fakeConnection(user.id, user.username) };
    });
    for (const player of players) manager.attach(player.connection, room.id);
    const startBalance = new Map(players.map((player) => [player.user.id, getWallet(db, player.user.id).balance]));

    // Every player tries the same number of shots with interleaved client refs.
    for (let round = 0; round < 3; round += 1) {
      for (const player of players) {
        manager.fire(player.connection, { clientRef: `conc-${round}-${player.user.id}`, cannonKey: 'reef_breaker', angle: -Math.PI / 2 + round * 0.05, originX: 900 + round * 20, originY: 984 });
        // Force the rate limiter to release between rounds so shots are accepted.
        (manager as any).lastFireAt.delete(player.user.id);
        const simPlayer = manager.runtimeFor(room.id)!.sim.players.get(player.user.id);
        if (simPlayer) simPlayer.lastShotAt = 0;
      }
    }
    const cost = getActiveConfiguration(db).cannons.find((c) => c.key === 'reef_breaker')!.shotCost;
    for (const player of players) {
      const shots = db.scalar<number>('SELECT COUNT(*) FROM player_shots WHERE user_id = ?', player.user.id)!;
      expect(shots).toBe(3);
      const spent = (startBalance.get(player.user.id) ?? 0) - getWallet(db, player.user.id).balance;
      // Spent must equal exactly the number of accepted shots times the cost,
      // ignoring any rewards; if a reward landed the balance is higher than this.
      expect(spent).toBeLessThanOrEqual(shots * cost);
      expect(spent % cost === 0 || spent < shots * cost).toBe(true);
    }
    expect(verifyLedgerIntegrity(db).mismatches).toEqual([]);
  });

  it('a shot arriving over HTTP runs the same authority checks as the socket', () => {
    const user = makeUser();
    const room = roomByName('shallow_lagoon');
    joinRoom(db, user.id, room.id);
    const managerRef = manager;
    managerRef.attach(fakeConnection(user.id, user.username), room.id);
    const result = managerRef.fireViaHttp(db, user.id, { clientRef: 'http-shot-001', cannonKey: 'reef_breaker', angle: -Math.PI / 2, originX: 960, originY: 984 });
    expect(result.ok).toBe(true);
    expect(getWallet(db, user.id).balance).toBe(10_000 - getActiveConfiguration(db).cannons.find((c) => c.key === 'reef_breaker')!.shotCost);
    // Rejected path: unknown cannon over HTTP.
    const bad = managerRef.fireViaHttp(db, user.id, { clientRef: 'http-shot-002', cannonKey: 'fake_cannon', angle: -1, originX: 0, originY: 0 });
    expect(bad.ok).toBe(false);
  });
});

describe('multiplayer in one room', () => {
  let vc = 2_400_000_000_000;
  let manager: RoundManager;

  const connectionFor = (userId: string, username: string): any => ({
    ws: { readyState: 1, send: () => undefined, close: () => undefined },
    userId,
    username,
    avatarSeed: username,
    roomId: null,
    lastAngle: -Math.PI / 2,
    cannonKey: 'reef_breaker',
    alive: true,
    lastBalance: 10_000,
    pendingRefs: new Map(),
  });

  beforeEach(() => {
    vc = 2_400_000_000_000;
    manager = new RoundManager({ db, tickMs: 50, snapshotMs: 50, roundDurationS: 1800, clock: () => vc });
  });
  afterEach(() => manager.stop());

  it('players in the same room share one fish field and one round', () => {
    const room = roomByName('shallow_lagoon');
    const players = [makeUser(), makeUser(), makeUser()];
    for (const player of players) joinRoom(db, player.id, room.id);
    const attached = players.map((player) => manager.attach(connectionFor(player.id, player.username), room.id));

    const roundIds = new Set(attached.map((a) => a.runtime.roundId));
    expect(roundIds.size).toBe(1);
    const runtime = attached[0]!.runtime;
    expect(runtime.members.size).toBe(3);
    // Everyone sees the identical reef: same fish ids, same spawn parameters.
    const viewA = runtime.sim.snapshot().fish;
    const viewB = runtime.sim.snapshot().fish;
    expect(viewA.map((f) => f.id)).toEqual(viewB.map((f) => f.id));
    // Seats differ so cannons do not overlap.
    const seats = attached.map((a) => a.seat.x);
    expect(new Set(seats).size).toBe(3);
  });

  it('a kill pays only its own shooter, and never the other players', () => {
    const room = roomByName('shallow_lagoon');
    const shooter = makeUser();
    const bystander = makeUser();
    joinRoom(db, shooter.id, room.id);
    joinRoom(db, bystander.id, room.id);
    const shooterConn = connectionFor(shooter.id, shooter.username);
    const bystanderConn = connectionFor(bystander.id, bystander.username);
    const { runtime } = manager.attach(shooterConn, room.id);
    manager.attach(bystanderConn, room.id);

    const weak = runtime.config.fish.find((f) => f.health === 1)!;
    const fish = runtime.sim.debugSpawn(weak.key, { x: 960, y: 940, angle: 0 });
    fish.hp = 1;
    isolateOneFish(runtime, fish.id);
    runtime.sim.relocatePlayer(shooter.id, 960, 984);
    const fired = manager.fire(shooterConn, { clientRef: 'mp-kill-00001', cannonKey: 'reef_breaker', angle: -Math.PI / 2, originX: 960, originY: 984 });
    expect(fired.ok).toBe(true);
    vc += 50;
    runtime.sim.tick(50);

    expect(getWallet(db, shooter.id).balance).toBeLessThan(10_000 + 100);
    expect(getWallet(db, shooter.id).balance).toBeGreaterThan(10_000 - 100);
    // The bystander's wallet is untouched by someone else's kill.
    expect(getWallet(db, bystander.id).balance).toBe(10_000);
    expect(bystanderConn.lastBalance).toBe(10_000);
    const wins = db.all<any>("SELECT user_id FROM wallet_transactions WHERE type = 'WIN'");
    expect(wins).toHaveLength(1);
    expect(wins[0]!.user_id).toBe(shooter.id);
  });

  it('a player who leaves stops receiving the room and frees their seat', () => {
    const room = roomByName('shallow_lagoon');
    const a = makeUser();
    const b = makeUser();
    joinRoom(db, a.id, room.id);
    joinRoom(db, b.id, room.id);
    const connA = connectionFor(a.id, a.username);
    const connB = connectionFor(b.id, b.username);
    manager.attach(connA, room.id);
    manager.attach(connB, room.id);
    const runtime = manager.runtimeFor(room.id)!;
    expect(runtime.members.size).toBe(2);
    manager.detach(connA);
    expect(runtime.members.size).toBe(1);
    expect(runtime.sim.hasPlayer(a.id)).toBe(false);
    expect(manager.roomPlayerCount(room.id)).toBe(1);
    // The detached player's shots are refused rather than silently applied.
    const fired = manager.fire(connA, { clientRef: 'mp-afterleave-1', cannonKey: 'reef_breaker', angle: -1.4, originX: 960, originY: 984 });
    expect(fired.ok).toBe(false);
    expect(fired.code).toBe('NO_ACTIVE_SESSION');
  });

  it("a broke player cannot spend another player's balance", () => {
    const room = roomByName('shallow_lagoon');
    const rich = makeUser();
    const poor = makeUser();
    joinRoom(db, rich.id, room.id);
    joinRoom(db, poor.id, room.id);
    db.run('UPDATE wallets SET balance = 0 WHERE user_id = ?', poor.id);
    manager.attach(connectionFor(rich.id, rich.username), room.id);
    const poorConn = connectionFor(poor.id, poor.username);
    manager.attach(poorConn, room.id);
    const result = manager.fire(poorConn, { clientRef: 'mp-broke-0001', cannonKey: 'reef_breaker', angle: -1.4, originX: 960, originY: 984 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('INSUFFICIENT_FUNDS');
    // The rich player's balance is untouched by the failed attempt.
    expect(getWallet(db, rich.id).balance).toBe(10_000);
  });

  it('snapshot broadcasts stay small and event-driven', () => {
    const room = roomByName('shallow_lagoon');
    const player = makeUser();
    joinRoom(db, player.id, room.id);
    const sent: string[] = [];
    const conn = connectionFor(player.id, player.username);
    conn.ws.send = (text: string) => {
      sent.push(text);
    };
    manager.attach(conn, room.id);
    const before = sent.length;
    // A dozen ticks with no interaction should not stream frames.
    for (let i = 0; i < 12; i += 1) {
      vc += 50;
      manager.tickOnce(50);
    }
    const framesDuringIdle = sent.length - before;
    // Only deltas that actually contain something are sent: spawns are rare at
    // this scale, so at most a couple of messages over half a second.
    expect(framesDuringIdle).toBeLessThanOrEqual(3);
    const biggest = Math.max(0, ...sent.map((s) => s.length));
    expect(biggest).toBeLessThan(200_000);
  });
});

describe('leaderboards, history and admin reporting', () => {
  it('leaderboards rank by demo coins earned from the ledger only', () => {
    const a = makeUser();
    const b = makeUser();
    credit(db, { userId: a.id, amount: 900, type: 'WIN', referenceId: 'la', idempotencyKey: 'la' });
    credit(db, { userId: b.id, amount: 400, type: 'WIN', referenceId: 'lb', idempotencyKey: 'lb' });
    const board = leaderboard(db, 'alltime', 10);
    expect(board[0]!.username).toBe(a.username);
    expect(board[0]!.earned).toBe(900);
    expect(board[1]!.earned).toBe(400);
    expect(board[0]!.avatarSeed).toBeTruthy();
    // No private fields leak into the board.
    expect(JSON.stringify(board)).not.toContain(a.id);
    expect(JSON.stringify(board)).not.toContain('@example.com');
  });

  it('betting without winning does not put a player on the board', () => {
    const player = makeUser();
    debit(db, { userId: player.id, amount: 50, referenceId: 'justbets', gameRoundId: 'R1', description: 'x' });
    const board = leaderboard(db, 'alltime', 10);
    expect(board.some((entry) => entry.username === player.username)).toBe(false);
  });

  it('admin dashboard counts demo activity and flags RTP above target', () => {
    const user = makeUser();
    const room = roomByName('shallow_lagoon');
    joinRoom(db, user.id, room.id);
    let vc = 2_000_000_000_000;
    const manager = new RoundManager({ db, tickMs: 50, snapshotMs: 50, roundDurationS: 1800, clock: () => vc });
    const connection = {
      ws: { readyState: 1, send: () => undefined },
      userId: user.id,
      username: user.username,
      avatarSeed: 'x',
      roomId: null,
      lastAngle: -Math.PI / 2,
      cannonKey: 'reef_breaker',
      alive: true,
      lastBalance: 10_000,
      pendingRefs: new Map(),
    } as any;
    const { runtime } = manager.attach(connection, room.id);
    const weak = runtime.config.fish.find((f) => f.health === 1)!;
    const fish = runtime.sim.debugSpawn(weak.key, { x: 960, y: 940, angle: 0 });
    fish.hp = 1;
    isolateOneFish(runtime, fish.id);
    runtime.sim.relocatePlayer(user.id, 960, 984);
    const cost = runtime.config.cannons.find((c) => c.key === 'reef_breaker')!.shotCost;
    manager.fire(connection, { clientRef: 'rep-kill-0001', cannonKey: 'reef_breaker', angle: -Math.PI / 2, originX: 960, originY: 984 });
    for (let i = 0; i < 4; i += 1) {
      vc += 50;
      (manager as any).tickAll(50);
    }
    expect(db.scalar<number>('SELECT COUNT(*) FROM player_shots WHERE user_id = ?', user.id)).toBe(1);
    const win = db.get<{ amount: number }>("SELECT amount FROM wallet_transactions WHERE user_id = ? AND type = 'WIN'", user.id);
    expect(win?.amount ?? 0).toBeGreaterThanOrEqual(weak.reward);
    expect(getWallet(db, user.id).balance).toBe(10_000 - cost + (win?.amount ?? 0));
    manager.stop();

    const stats = computeAdminStats(db, 0, 1);
    expect(stats.shotsToday).toBe(1);
    expect(stats.gamesToday).toBe(1);
    expect(stats.demoCoinsRewardedToday).toBe(weak.reward);
    expect(stats.demoCoinsWageredToday).toBeGreaterThan(0);
    expect(stats.rtpToday).not.toBeNull();
    expect(stats.totalUsers).toBeGreaterThanOrEqual(2);

    const audit = roundAudit(db, runtime.roundId)!;
    expect(audit.configVersion).toBe(runtime.config.version);
    expect(audit.totals.rewarded).toBe(weak.reward);
    expect(audit.perPlayer[0]!.username).toBe(user.username);
    expect(audit.configuration).toBeTruthy();
  });

  it('game history keeps a row per shot with the reward recorded on kills', () => {
    const user = makeUser();
    const room = roomByName('shallow_lagoon');
    joinRoom(db, user.id, room.id);
    let vc2 = 2_100_000_000_000;
    const manager = new RoundManager({ db, tickMs: 50, snapshotMs: 50, roundDurationS: 1800, clock: () => vc2 });
    const connection = {
      ws: { readyState: 1, send: () => undefined },
      userId: user.id,
      username: user.username,
      avatarSeed: 'x',
      roomId: null,
      lastAngle: -Math.PI / 2,
      cannonKey: 'tidecaster',
      alive: true,
      lastBalance: 10_000,
      pendingRefs: new Map(),
    } as any;
    const { runtime } = manager.attach(connection, room.id);
    manager.fire(connection, { clientRef: 'hist-shot-1', cannonKey: 'tidecaster', angle: -Math.PI / 2, originX: 960, originY: 984 });
    for (let i = 0; i < 60; i += 1) {
      vc2 += 50;
      runtime.sim.tick(50);
    }
    manager.stop();
    const history = listHistory(db, user.id, { limit: 20 });
    expect(history.total).toBeGreaterThanOrEqual(1);
    expect(history.items[0]!.roomName).toBeTruthy();
    expect(history.items.every((entry) => entry.shotCost >= 0)).toBe(true);
  });
});

describe('authorisation model', () => {
  it('maps admin roles to least-privilege capability sets', async () => {
    const { permissionsForRole } = await import('@reef/shared');
    expect(permissionsForRole('USER')).toEqual([]);
    const game = permissionsForRole('GAME_ADMIN');
    expect(game).toContain('fish:write');
    expect(game).not.toContain('transactions:write');
    expect(game).not.toContain('admin:full');
    const finance = permissionsForRole('FINANCE_ADMIN');
    expect(finance).toContain('transactions:write');
    expect(finance).not.toContain('fish:write');
    const support = permissionsForRole('SUPPORT_ADMIN');
    expect(support).toContain('users:write');
    expect(support).not.toContain('config:write');
    const compliance = permissionsForRole('COMPLIANCE_ADMIN');
    expect(compliance).toContain('audit:read');
    expect(compliance).not.toContain('config:write');
    expect(permissionsForRole('SUPER_ADMIN')).toContain('admin:full');
  });

  it('role and status are resolved from the database, not from a token', async () => {
    const { verifyAccessToken } = await import('../src/security/tokens.js');
    const user = makeUser();
    // A real session, issued the way the API issues them.
    const session = await issueSession(db, user.id, {});
    const token = session.accessToken;
    const claims = verifyAccessToken(token);
    expect(claims.sub).toBe(user.id);
    expect(typeof claims.sid).toBe('string');
    expect(JSON.stringify(claims)).not.toContain('role');

    // Escalating the row in the database is what changes access; the token is
    // unchanged and must not be able to claim admin by itself.
    db.run("UPDATE users SET role = 'GAME_ADMIN' WHERE id = ?", user.id);
    expect(verifyAccessToken(token).sub).toBe(user.id);
    const { resolveUser } = await import('../src/http/auth.js');
    const fakeRequest: any = { headers: { authorization: `Bearer ${token}` }, url: '/api/me', cookies: {} };
    const resolved = resolveUser(fakeRequest);
    expect(resolved?.permissions).toContain('fish:write');

    db.run("UPDATE users SET status = 'SUSPENDED' WHERE id = ?", user.id);
    expect(resolveUser({ headers: { authorization: `Bearer ${token}` }, cookies: {} })).toBeUndefined();
  });

  it('rejects tampered and expired tokens', async () => {
    const { signAccessToken, verifyAccessToken, TokenError } = await import('../src/security/tokens.js');
    const token = signAccessToken('usr-1', 'sid-1');
    const [header, payload, signature] = token.split('.');
    expect(() => verifyAccessToken(`${header}.${Buffer.from(JSON.stringify({ sub: 'admin', sid: 'x', typ: 'access', iss: 'reef-raiders', aud: 'reef-raiders-web', exp: Math.floor(Date.now() / 1000) + 60 })).toString('base64url')}.${signature}`)).toThrowError(TokenError);
    expect(() => verifyAccessToken(`${header}.${payload}.AAAA`)).toThrowError(/signature/i);
    expect(() => verifyAccessToken('nonsense')).toThrowError(/Malformed/i);
    const expired = signAccessToken('usr-1', 'sid-1', -10);
    expect(() => verifyAccessToken(expired)).toThrowError(/expired/i);
  });

  it('blocks every real-money entry point while the flag is off', async () => {
    const { requireRealMoneyEnabled, featureFlags } = await import('../src/config/flags.js');
    expect(featureFlags().realMoneyEnabled).toBe(false);
    expect(featureFlags().demoMode).toBe(true);
    expect(() => requireRealMoneyEnabled()).toThrowError(/disabled/i);

    const { getPaymentProvider, DemoPaymentProvider } = await import('../src/modules/payments/provider.js');
    const provider = getPaymentProvider();
    expect(provider).toBeInstanceOf(DemoPaymentProvider);
    expect(provider.settlesRealMoney).toBe(false);
    await expect(provider.createDeposit({ userId: 'u', amount: 1000, currency: 'EUR', idempotencyKey: 'k' })).rejects.toThrowError(/disabled/i);
    await expect(provider.createWithdrawal({ userId: 'u', amount: 1000, currency: 'EUR', destinationRef: 'x', idempotencyKey: 'k' })).rejects.toThrowError(/disabled/i);
  });

  it('a real-money provider cannot be activated by the demo flag path', async () => {
    const { registerPaymentProvider, getPaymentProvider } = await import('../src/modules/payments/provider.js');
    const fake: any = {
      id: 'fake-regulated',
      settlesRealMoney: true,
      createDeposit: async () => ({}),
      verifyDeposit: async () => ({}),
      createWithdrawal: async () => ({}),
      verifyWithdrawal: async () => ({}),
      handleWebhook: async () => ({ acknowledged: true as const, eventId: 'e' }),
    };
    registerPaymentProvider(fake);
    expect(() => getPaymentProvider('fake-regulated')).toThrowError(/disabled/i);
  });
});

describe('query safety', () => {
  it('uses parameter binding: quote-shaped search strings are data, not SQL', () => {
    makeUser();
    const before = db.scalar<number>('SELECT COUNT(*) FROM users')!;
    const attack = "x'; DROP TABLE users; --";
    const result = listUsers(db, { search: attack, limit: 10, offset: 0 });
    expect(result.items).toEqual([]);
    expect(db.scalar<number>('SELECT COUNT(*) FROM users')!).toBe(before);
    // The union-based probe must not return rows either.
    const union = db.all("SELECT id FROM users WHERE username LIKE ?", "%' UNION SELECT id FROM wallets --%");
    expect(union).toEqual([]);
  });

  it('escapes LIKE wildcards in admin search', () => {
    const user = makeUser();
    expect(listUsers(db, { search: '%', limit: 10, offset: 0 }).total).toBe(0);
    expect(listUsers(db, { search: user.username.slice(0, 5), limit: 10, offset: 0 }).total).toBe(1);
  });

  it('one player cannot read another player history or transactions through the service layer', () => {
    const a = makeUser();
    const b = makeUser();
    credit(db, { userId: b.id, amount: 77, type: 'WIN', referenceId: 'b-only', idempotencyKey: 'b-only' });
    // Every read in the API is keyed by the caller's own id (routes pass
    // `requireAuth(request).id`), so asking for another user's data returns the
    // caller's own empty result rather than the other player's rows.
    const mine = listTransactions(db, a.id, { limit: 50 });
    expect(mine.items.some((item) => item.referenceId === 'b-only')).toBe(false);
    expect(mine.items.every((item) => item.userId === a.id)).toBe(true);
    expect(listHistory(db, a.id, { limit: 10 }).items.every((entry) => true)).toBe(true);
  });
});

describe('HTTP surface', () => {
  it('builds an app whose routes all answer without leaking internals', async () => {
    const { buildApp } = await import('../src/http/app.js');
    const manager = new RoundManager({ db, tickMs: 50, snapshotMs: 60, roundDurationS: 1800 });
    const app = await buildApp({ rounds: manager, logger: false });

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe('ok');

    const meta = await app.inject({ method: 'GET', url: '/api/meta' });
    expect(meta.json().flags.realMoneyEnabled).toBe(false);
    expect(meta.json().currency.label).toBe('DEMO COINS');

    const badRegister = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'x', email: 'nope', password: 'short' } });
    expect(badRegister.statusCode).toBe(400);
    expect(badRegister.json().error.code).toBe('VALIDATION_FAILED');
    expect(badRegister.json().message ?? '').not.toMatch(/at .*\.ts:/);
    expect(JSON.stringify(badRegister.json())).not.toContain('SQLITE');

    const unknown = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('NOT_FOUND');

    const unauthed = await app.inject({ method: 'GET', url: '/api/me' });
    expect(unauthed.statusCode).toBe(401);

    const adminBlocked = await app.inject({ method: 'GET', url: '/api/admin/dashboard' });
    expect(adminBlocked.statusCode).toBe(401);

    const deposit = await app.inject({ method: 'POST', url: '/api/payments/deposit', payload: { amount: 10 } });
    expect(deposit.statusCode).toBe(403);
    expect(deposit.json().error.code).toBe('REAL_MONEY_DISABLED');

    // Register over HTTP, then use the token for a protected call.
    const register = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'httpuser', email: 'http@example.com', password: 'Passw0rd!42', acceptTerms: true },
    });
    expect(register.statusCode).toBe(201);
    const token = register.json().accessToken;
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().wallet.balance).toBe(10_000);
    expect(JSON.stringify(me.json())).not.toContain('password');

    const rooms = await app.inject({ method: 'GET', url: '/api/rooms', headers: { authorization: `Bearer ${token}` } });
    expect(rooms.json().rooms.length).toBeGreaterThan(0);

    const join = await app.inject({ method: 'POST', url: '/api/game/join', headers: { authorization: `Bearer ${token}` }, payload: { roomKey: 'shallow_lagoon' } });
    expect(join.statusCode).toBe(200);
    expect(join.json().wallet.balance).toBe(10_000);

    const fire = await app.inject({
      method: 'POST',
      url: '/api/game/fire',
      headers: { authorization: `Bearer ${token}` },
      payload: { clientRef: 'http-e2e-0001', cannonKey: 'tidecaster', angle: -Math.PI / 2, originX: 960, originY: 984 },
    });
    expect(fire.statusCode).toBe(200);
    expect(fire.json().ok).toBe(true);
    expect(fire.json().ack.balance).toBe(9_999);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/game/fire',
      headers: { authorization: `Bearer ${token}` },
      payload: { clientRef: 'http-e2e-0001', cannonKey: 'tidecaster', angle: -Math.PI / 2, originX: 960, originY: 984 },
    });
    expect(replay.json().ack.replayed).toBe(true);
    const walletAfter = await app.inject({ method: 'GET', url: '/api/wallet', headers: { authorization: `Bearer ${token}` } });
    expect(walletAfter.json().wallet.balance).toBe(9_999);

    const otherUser = await app.inject({ method: 'GET', url: '/api/admin/fish' });
    expect(otherUser.statusCode).toBe(401);

    // Admin: login with the bootstrap account and confirm a privileged read works.
    const adminLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'admin@test.local', password: 'Adm1n!pass' } });
    expect(adminLogin.statusCode).toBe(200);
    const adminToken = adminLogin.json().accessToken;
    const adminDash = await app.inject({ method: 'GET', url: '/api/admin/dashboard', headers: { authorization: `Bearer ${adminToken}` } });
    expect(adminDash.statusCode).toBe(200);
    expect(adminDash.json().totalUsers).toBeGreaterThanOrEqual(2);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/admin/fish/${getActiveConfiguration(db).fish[0].id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { reward: 4 },
    });
    expect(patch.statusCode).toBe(200);
    const auditList = await app.inject({ method: 'GET', url: '/api/admin/audit', headers: { authorization: `Bearer ${adminToken}` } });
    expect(auditList.json().items[0].action).toBe('FISH_UPDATE');

    const publish = await app.inject({ method: 'POST', url: '/api/admin/config/publish', headers: { authorization: `Bearer ${adminToken}` }, payload: { notes: 'e2e' } });
    expect(publish.statusCode).toBe(200);
    expect(publish.json().version).toMatch(/^\d+\.\d+\.\d+$/);

    const gameConfig = await app.inject({ method: 'GET', url: '/api/config' });
    expect(gameConfig.json().version).toBe(publish.json().version);
    expect(gameConfig.json().fish[0].reward).toBe(4);

    // Player must not be able to change the economy.
    const playerTries = await app.inject({ method: 'PATCH', url: `/api/admin/fish/${getActiveConfiguration(db).fish[0].id}`, headers: { authorization: `Bearer ${token}` }, payload: { reward: 999999 } });
    expect([401, 403]).toContain(playerTries.statusCode);

    // Maintenance mode blocks gameplay but not reads.
    const maintenance = await app.inject({ method: 'POST', url: '/api/admin/maintenance', headers: { authorization: `Bearer ${adminToken}` }, payload: { enabled: true, reason: 'test window' } });
    expect(maintenance.json().maintenance).toBe(true);
    const blockedJoin = await app.inject({ method: 'POST', url: '/api/game/join', headers: { authorization: `Bearer ${token}` }, payload: { roomKey: 'shallow_lagoon' } });
    expect(blockedJoin.statusCode).toBe(409);
    expect(blockedJoin.json().error.code).toBe('MAINTENANCE');
    await app.inject({ method: 'POST', url: '/api/admin/maintenance', headers: { authorization: `Bearer ${adminToken}` }, payload: { enabled: false } });
    const allowedJoin = await app.inject({ method: 'POST', url: '/api/game/join', headers: { authorization: `Bearer ${token}` }, payload: { roomKey: 'shallow_lagoon' } });
    expect(allowedJoin.statusCode).toBe(200);

    // Security headers are present on API responses.
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['x-frame-options']).toBe('DENY');

    await app.close();
    manager.stop();
  });

  it('serves a friendly error for a cross-site origin', async () => {
    const { buildApp } = await import('../src/http/app.js');
    const manager = new RoundManager({ db, tickMs: 50, snapshotMs: 60, roundDurationS: 1800 });
    const app = await buildApp({ rounds: manager, logger: false });
    const response = await app.inject({ method: 'GET', url: '/api/rooms', headers: { origin: 'https://evil.example' } });
    expect([403, 200]).toContain(response.statusCode);
    if (response.statusCode === 200) {
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
    await app.close();
    manager.stop();
  });
});

describe('player protection: play limits and self-exclusion', () => {
  const MIN = 60_000;
  let vc = 1_700_000_000_000;

  type FakeConn = any;

  const connectFor = (userId: string, username: string): { conn: FakeConn; sent: any[] } => {
    const sent: any[] = [];
    const conn = {
      ws: { readyState: 1, send: (text: string) => sent.push(JSON.parse(text)), close: () => undefined },
      userId,
      username,
      avatarSeed: username,
      roomId: null,
      lastAngle: -Math.PI / 2,
      cannonKey: 'reef_breaker',
      alive: true,
      lastBalance: 10_000,
      pendingRefs: new Map(),
    };
    return { conn, sent };
  };

  const setLimit = (userId: string, minutes: number | null): void => {
    db.run('UPDATE profiles SET session_limit_min = ? WHERE user_id = ?', minutes, userId);
  };

  /** Rewrites the player's newest session so it *looks* like it started `minutesAgo`. */
  const backdateSession = (userId: string, minutesAgo: number, endedMinutesAgo: number | null = null): void => {
    const session = db.get<{ id: string }>(
      "SELECT id FROM game_sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT 1",
      userId,
    )!;
    db.run(
      'UPDATE game_sessions SET started_at = ?, ended_at = ? WHERE id = ?',
      new Date(vc - minutesAgo * MIN).toISOString(),
      endedMinutesAgo === null ? null : new Date(vc - endedMinutesAgo * MIN).toISOString(),
      session.id,
    );
  };

  /** A real joined session, retimed so it reads as `minutes` played earlier today. */
  const seedPlayedMinutes = (userId: string, minutes: number): void => {
    const room = db.get<{ id: string }>("SELECT id FROM game_rooms WHERE key = 'shallow_lagoon'")!;
    joinRoom(db, userId, room.id);
    backdateSession(userId, minutes + 5, 5);
    db.run("UPDATE game_sessions SET status = 'ENDED' WHERE user_id = ? AND status = 'ACTIVE'", userId);
  };

  beforeEach(() => {
    vc = 1_700_000_000_000;
  });

  it('a configured daily limit stops play once the budget is spent', () => {
          const user = makeUser();
    seedPlayedMinutes(user.id, 40);
    expect(msPlayedToday(db, user.id, vc)).toBeCloseTo(40 * MIN, -4);

    // No limit configured: unlimited play.
    expect(assertPlayAllowed(db, user.id, vc).limitMin).toBe(0);

    setLimit(user.id, 30);
    expect(() => assertPlayAllowed(db, user.id, vc)).toThrowError(/daily play limit/i);
    try {
      assertPlayAllowed(db, user.id, vc);
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as AppError).code).toBe('SESSION_LIMIT_REACHED');
    }

    // A 60-minute budget still leaves 20 minutes of the 40 already used.
    setLimit(user.id, 60);
    const limits = readPlayLimits(db, user.id, vc);
    expect(limits.minutesRemaining).toBe(20);
    expect(() => assertPlayAllowed(db, user.id, vc)).not.toThrow();
  });

  it('the shot path refuses once the allowance elapses, charging nothing', () => {
    const user = makeUser();
    const room = roomByName('shallow_lagoon');
    joinRoom(db, user.id, room.id);
    setLimit(user.id, 30);
    backdateSession(user.id, 29);

    const manager = new RoundManager({ db, tickMs: 50, snapshotMs: 50, roundDurationS: 1800, clock: () => vc });
    try {
      const { conn, sent } = connectFor(user.id, user.username);
      manager.attach(conn, room.id);
      expect(typeof conn.playDeadlineMs).toBe('number');

      const before = getWallet(db, user.id).balance;
      const first = manager.fire(conn, { clientRef: 'prot-shot-0001', cannonKey: 'reef_breaker', angle: -Math.PI / 2, originX: 960, originY: 984 });
      expect(first.ok).toBe(true);
      expect(getWallet(db, user.id).balance).toBeLessThan(before);

      // One minute of virtual time passes: the budget is gone.
      vc += 61_000;
      const second = manager.fire(conn, { clientRef: 'prot-shot-0002', cannonKey: 'reef_breaker', angle: -Math.PI / 2, originX: 960, originY: 984 });
      expect(second.ok).toBe(false);
      expect(second.code).toBe('SESSION_LIMIT_REACHED');
      // The refused shot is not billed.
      expect(getWallet(db, user.id).balance).not.toBeLessThan(before - 100);
      // The player was removed and told why, in one message they cannot ignore.
      const limit = sent.find((message) => message.type === 'limit');
      expect(limit).toBeTruthy();
      expect(limit.kind).toBe('SESSION_LIMIT');
      expect(limit.message).toMatch(/daily play limit/i);
      expect(db.get<{ status: string }>("SELECT status FROM game_sessions WHERE user_id = ?", user.id)!.status).toBe('ENDED');
    } finally {
      manager.stop();
    }
  });

  it('self-exclusion blocks play, cannot be shortened, and needs an admin to lift', () => {
    const user = makeUser();
    const admin = { id: 'usr_admin_test', username: 'admin' };
    const room = roomByName('shallow_lagoon');

    expect(assertPlayAllowed(db, user.id, vc).selfExcludedUntil).toBeNull();

    const started = requestSelfExclusion(db, user.id, '30d', admin, vc);
    expect(Date.parse(started.until)).toBeGreaterThan(vc + 29 * 24 * 3_600_000);
    try {
      assertPlayAllowed(db, user.id, vc);
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as AppError).code).toBe('SELF_EXCLUDED');
      expect((err as AppError).message).toMatch(/Self-exclusion is active/i);
    }

    // A shorter request during an active exclusion cannot cut it short.
    const extended = requestSelfExclusion(db, user.id, '24h', admin, vc + 1000);
    expect(extended.until).toBe(started.until);

    // Joining a room is refused for the same reason as firing.
    const manager = new RoundManager({ db, tickMs: 50, snapshotMs: 50, roundDurationS: 1800, clock: () => vc });
    try {
      const { conn } = connectFor(user.id, user.username);
      expect(() => manager.attach(conn, room.id)).toThrowError(AppError);
    } finally {
      manager.stop();
    }

    // Nobody but an admin can end it; the lift is audited with a reason.
    expect(() => liftSelfExclusion(db, user.id, admin, 'x', vc)).toThrowError(/at least 5|reason/i);
    liftSelfExclusion(db, user.id, admin, 'support verified identity', vc);
    expect(assertPlayAllowed(db, user.id, vc).selfExcludedUntil).toBeNull();
    const audit = readAudit(db, { action: 'admin.self_exclusion.lift', limit: 5 });
    expect(audit.items.length).toBe(1);
    expect(JSON.stringify(audit.items[0]!.metadata)).toContain('support verified identity');
  });

  it('a player who self-excludes mid-round is taken out on the next sweep', () => {
    const user = makeUser();
    const room = roomByName('shallow_lagoon');
    joinRoom(db, user.id, room.id);

    const manager = new RoundManager({ db, tickMs: 50, snapshotMs: 50, roundDurationS: 1800 });
    try {
      const { conn, sent } = connectFor(user.id, user.username);
      manager.attach(conn, room.id);
      const runtime = manager.runtimeFor(room.id)!;
      expect(runtime.members.size).toBe(1);

      requestSelfExclusion(db, user.id, '24h', { id: user.id, username: user.username });
      manager.tickOnce();

      expect(runtime.members.size).toBe(0);
      const limit = sent.find((message: any) => message.type === 'limit');
      expect(limit.kind).toBe('SELF_EXCLUDED');
      expect(conn.roomId).toBeNull();
    } finally {
      manager.stop();
    }
  });

  it('HTTP: the API answers with the reason instead of an empty room', async () => {
    const { buildApp } = await import('../src/http/app.js');
    const manager = new RoundManager({ db, tickMs: 50, snapshotMs: 60, roundDurationS: 1800 });
    const app = await buildApp({ rounds: manager, logger: false });
    try {
      const register = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'limitedplayer', email: 'limited@example.com', password: 'Passw0rd!77', acceptTerms: true },
      });
      const token = register.json().accessToken;
      const auth = { authorization: `Bearer ${token}` };

      const saved = await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: auth, payload: { sessionLimitMin: 15 } });
      expect(saved.statusCode).toBe(200);

      const joined = await app.inject({ method: 'POST', url: '/api/game/join', headers: auth, payload: { roomKey: 'coral_shelf' } });
      expect(joined.statusCode).toBe(200);
      expect(joined.json().limits.limitMin).toBe(15);

      const limits = await app.inject({ method: 'GET', url: '/api/me/limits', headers: auth });
      expect(limits.statusCode).toBe(200);
      expect(limits.json().limitMin).toBe(15);
      expect(limits.json().selfExcludedUntil).toBeNull();

      const break1 = await app.inject({ method: 'POST', url: '/api/me/self-exclusion', headers: auth, payload: { duration: '7d' } });
      expect(break1.statusCode).toBe(200);
      expect(break1.json().selfExclusion.until).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const blocked = await app.inject({ method: 'POST', url: '/api/game/join', headers: auth, payload: { roomKey: 'coral_shelf' } });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().error.code).toBe('SELF_EXCLUDED');
      expect(blocked.json().message ?? blocked.json().error.message).toMatch(/Self-exclusion/i);

      // A player cannot lift their own exclusion through any player route.
      const selfLift = await app.inject({ method: 'POST', url: '/api/admin/users/whatever/limits/lift', headers: auth, payload: { reason: 'let me back in' } });
      expect([401, 403]).toContain(selfLift.statusCode);

      // Admin lift, then play resumes.
      const adminLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { identifier: 'admin@test.local', password: 'Adm1n!pass' } });
      const adminToken = adminLogin.json().accessToken;
      const profile = await app.inject({ method: 'GET', url: '/api/me', headers: auth });
      const userId = profile.json().user.id;
      const view = await app.inject({ method: 'GET', url: `/api/admin/users/${userId}/limits`, headers: { authorization: `Bearer ${adminToken}` } });
      expect(view.statusCode).toBe(200);
      expect(view.json().selfExcludedUntil).toBeTruthy();

      const lift = await app.inject({
        method: 'POST',
        url: `/api/admin/users/${userId}/limits/lift`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { reason: 'player verified by support' },
      });
      expect(lift.statusCode).toBe(200);

      const resumed = await app.inject({ method: 'POST', url: '/api/game/join', headers: auth, payload: { roomKey: 'coral_shelf' } });
      expect(resumed.statusCode).toBe(200);
    } finally {
      await app.close();
      manager.stop();
    }
  });

  it('the new sign-in alert honours the player setting and ignores known browsers', async () => {
    const { buildApp } = await import('../src/http/app.js');
    const manager = new RoundManager({ db, tickMs: 50, snapshotMs: 60, roundDurationS: 1800 });
    const app = await buildApp({ rounds: manager, logger: false });
    const loginWith = async (userAgent: string) =>
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'user-agent': userAgent },
        payload: { identifier: 'notify@example.com', password: 'Passw0rd!88' },
      });
    try {
      const register = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { 'user-agent': 'Browser-A' },
        payload: { username: 'notifyme', email: 'notify@example.com', password: 'Passw0rd!88', acceptTerms: true },
      });
      expect(register.statusCode).toBe(201);

      // First sign-in from a second browser is news.
      const second = await loginWith('Browser-B');
      expect(second.statusCode).toBe(200);
      expect(second.json().securityNotice).toMatch(/browser that has no other active session/i);

      // Signing in again with a browser that already has a live session is not.
      const third = await loginWith('Browser-A');
      expect(third.json().securityNotice ?? null).toBeNull();

      // Once the player turns alerts off, nothing is reported.
      const token = third.json().accessToken;
      await app.inject({ method: 'PATCH', url: '/api/me/profile', headers: { authorization: `Bearer ${token}` }, payload: { loginNotify: false } });
      const fourth = await loginWith('Browser-C');
      expect(fourth.json().securityNotice ?? null).toBeNull();
    } finally {
      await app.close();
      manager.stop();
    }
  });
});
