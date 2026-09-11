import { uid } from '../lib/ids.js';
import { hashPassword } from '../security/passwords.js';
import { env } from '../config/env.js';
import type { Database } from './index.js';
import { BASELINE_CANNONS, BASELINE_FISH, BASELINE_ROOMS, BASELINE_SETTINGS, INITIAL_CONFIG_VERSION, type CannonConfig, type FishConfig, type GameConfiguration, type GameSettings, type RoomConfig } from '@reef/shared';

/**
 * Baseline game configuration.
 *
 * These are *initial* values only. They are written into the database on first
 * boot and from then on the database is authoritative: administrators change
 * them through the admin panel, every change publishes a new immutable
 * configuration version, and each game round records the version it used.
 * Nothing here is read by the client from source code — the client always
 * fetches `/api/config/active`.
 */

const now = () => new Date().toISOString();

interface FishSeed extends Omit<FishConfig, 'id' | 'createdAt'> {}

export const DEFAULT_FISH: FishSeed[] = BASELINE_FISH.map(({ id: _id, ...rest }) => rest);

export const DEFAULT_CANNONS: Array<Omit<CannonConfig, 'id'>> = BASELINE_CANNONS.map(({ id: _id, ...rest }) => rest);

export const DEFAULT_ROOMS: Array<Omit<RoomConfig, 'id' | 'createdAt'>> = BASELINE_ROOMS.map(({ id: _id, createdAt: _c, ...rest }) => rest);

export const DEFAULT_SETTINGS: GameSettings = BASELINE_SETTINGS;



export interface SeedOptions {
  force?: boolean;
  admin?: { email: string; username: string; password: string };
  startingCoins?: number;
}

export interface SeedResult {
  users: number;
  fish: number;
  cannons: number;
  rooms: number;
  configVersion: string;
  adminEmail: string | null;
}

/** Inserts baseline data when the database is empty. Safe to call repeatedly. */
export async function seed(db: Database, opts: SeedOptions = {}): Promise<SeedResult> {
  const adminCreds = opts.admin ?? env().bootstrapAdmin;
  const startingCoins = opts.startingCoins ?? env().startingDemoCoins;
  const timestamp = now();

  const fishCount = db.scalar<number>('SELECT COUNT(*) FROM fish') ?? 0;
  if (opts.force) {
    db.run('DELETE FROM fish');
    db.run('DELETE FROM cannons');
    db.run('DELETE FROM game_rooms');
  }
  const shouldSeedGame = opts.force || fishCount === 0;

  const fishIds = new Map<string, string>();
  if (shouldSeedGame) {
    for (const f of DEFAULT_FISH) {
      const id = uid('fsh');
      fishIds.set(f.key, id);
      db.run(
        `INSERT INTO fish (id, key, name, category, health, reward, speed, size, rarity, spawn_weight,
                           movement_pattern, palette, min_spawn_interval_ms, special, enabled, sort_order, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        f.key,
        f.name,
        f.category,
        f.health,
        f.reward,
        f.speed,
        f.size,
        f.rarity,
        f.spawnWeight,
        f.movementPattern,
        f.palette,
        f.minSpawnIntervalMs,
        f.special,
        f.enabled ? 1 : 0,
        f.sortOrder,
        timestamp,
        timestamp,
      );
    }
    for (const c of DEFAULT_CANNONS) {
      db.run(
        `INSERT INTO cannons (id, key, name, level, power, shot_cost, fire_rate, projectile_speed, enabled, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        uid('cn'),
        c.key,
        c.name,
        c.level,
        c.power,
        c.shotCost,
        c.fireRate,
        c.projectileSpeed,
        c.enabled ? 1 : 0,
        timestamp,
        timestamp,
      );
    }
    for (const r of DEFAULT_ROOMS) {
      db.run(
        `INSERT INTO game_rooms (id, key, name, description, min_bet, max_bet, max_players, fish_pool, spawn_rate_multiplier, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        uid('rm'),
        r.key,
        r.name,
        r.description,
        r.minBet,
        r.maxBet,
        r.maxPlayers,
        JSON.stringify(r.fishPool),
        r.spawnRateMultiplier,
        r.status,
        timestamp,
        timestamp,
      );
    }
  }

  // Publish the initial configuration version (snapshot of the tables above).
  const activeVersion = db.scalar<string>('SELECT version FROM game_configs WHERE is_active = 1');
  let configVersion = activeVersion ?? INITIAL_CONFIG_VERSION;
  if (!activeVersion) {
    configVersion = publishConfiguration(db, INITIAL_CONFIG_VERSION, null, 'Initial configuration published at install.');
  }

  db.run(
    `INSERT INTO system_settings (key, value, description, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    'starting_demo_coins',
    String(startingCoins),
    'DEMO COINS granted to a new account',
    timestamp,
  );
  db.run(
    `INSERT INTO system_settings (key, value, description, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    'maintenance_mode',
    'false',
    'When true, gameplay endpoints are closed to players',
    timestamp,
  );

  // Bootstrap administrator (only if no admin exists yet).
  let adminEmail: string | null = null;
  const adminCount = db.scalar<number>("SELECT COUNT(*) FROM users WHERE role <> 'USER'") ?? 0;
  if (adminCount === 0) {
    const id = uid('usr');
    const passwordHash = await hashPassword(adminCreds.password);
    db.run(
      `INSERT INTO users (id, username, email, password_hash, role, status, avatar_seed, email_verified, created_at, updated_at, last_active_at)
       VALUES (?,?,?,?,?, 'ACTIVE', ?, 1, ?, ?, ?)`,
      id,
      adminCreds.username,
      adminCreds.email.toLowerCase(),
      passwordHash,
      'SUPER_ADMIN',
      adminCreds.username,
      timestamp,
      timestamp,
      timestamp,
    );
    db.run(
      `INSERT INTO profiles (user_id, display_name, language, updated_at) VALUES (?,?,?,?)`,
      id,
      adminCreds.username,
      'en',
      timestamp,
    );
    db.run(
      `INSERT INTO admin_accounts (user_id, admin_role, notes, granted_by, granted_at) VALUES (?,?,?,?,?)`,
      id,
      'SUPER_ADMIN',
      'Bootstrap administrator created on first run.',
      null,
      timestamp,
    );
    const walletId = uid('wlt');
    db.run(
      `INSERT INTO wallets (id, user_id, balance, currency, version, created_at, updated_at) VALUES (?,?,?,?,0,?,?)`,
      walletId,
      id,
      0,
      'DEMO',
      timestamp,
      timestamp,
    );
    const txId = uid('tx');
    db.run(
      `INSERT INTO wallet_transactions (id, user_id, wallet_id, type, amount, balance_before, balance_after, reference_id, game_round_id, idempotency_key, status, description, created_at)
       VALUES (?,?,?, 'DEMO_CREDIT', ?,?,?,?,NULL,?, 'COMPLETED', ?,?)`,
      txId,
      id,
      walletId,
      startingCoins,
      0,
      startingCoins,
      `seed-${id}`,
      `seed-credit:${id}`,
      'Initial demo credit',
      timestamp,
    );
    db.run('UPDATE wallets SET balance = ?, version = 1, updated_at = ? WHERE id = ?', startingCoins, timestamp, walletId);
    adminEmail = adminCreds.email.toLowerCase();
  }

  return {
    users: db.scalar<number>('SELECT COUNT(*) FROM users') ?? 0,
    fish: db.scalar<number>('SELECT COUNT(*) FROM fish') ?? 0,
    cannons: db.scalar<number>('SELECT COUNT(*) FROM cannons') ?? 0,
    rooms: db.scalar<number>('SELECT COUNT(*) FROM game_rooms') ?? 0,
    configVersion,
    adminEmail,
  };
}

/**
 * Snapshots the current fish / cannon / room / settings tables into an
 * immutable `game_configs` row and marks it active. Previous versions stay in
 * the table so any historical round can be audited against the exact economy
 * it was played with.
 */
export function publishConfiguration(db: Database, version: string, publishedBy: string | null, notes: string | null): string {
  const timestamp = now();
  const fish = db
    .all<any>('SELECT * FROM fish ORDER BY sort_order, key')
    .map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      category: r.category,
      health: r.health,
      reward: r.reward,
      speed: r.speed,
      size: r.size,
      rarity: r.rarity,
      spawnWeight: r.spawn_weight,
      movementPattern: r.movement_pattern,
      palette: r.palette,
      minSpawnIntervalMs: r.min_spawn_interval_ms,
      special: r.special,
      enabled: r.enabled === 1,
      sortOrder: r.sort_order,
    }));
  const cannons = db.all<any>('SELECT * FROM cannons ORDER BY level').map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    level: r.level,
    power: r.power,
    shotCost: r.shot_cost,
    fireRate: r.fire_rate,
    projectileSpeed: r.projectile_speed,
    enabled: r.enabled === 1,
  }));
  const rooms = db.all<any>('SELECT * FROM game_rooms ORDER BY min_bet, key').map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    minBet: r.min_bet,
    maxBet: r.max_bet,
    maxPlayers: r.max_players,
    fishPool: safeJson<string[]>(r.fish_pool, []),
    spawnRateMultiplier: r.spawn_rate_multiplier,
    status: r.status,
    createdAt: r.created_at,
  }));
  const settingsRow = db.all<any>('SELECT key, value FROM system_settings');
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of settingsRow) {
    const k = row.key as string;
    const camel = k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    if (camel in settings) {
      const v = row.value as string;
      (settings as any)[camel] = Number.isFinite(Number(v)) && v !== '' ? Number(v) : v === 'true';
    }
  }

  const payload: GameConfiguration = {
    version,
    fish,
    cannons,
    rooms,
    settings,
    publishedAt: timestamp,
    publishedBy,
    notes,
  };

  db.transaction(() => {
    db.run('UPDATE game_configs SET is_active = 0 WHERE is_active = 1');
    db.run(
      `INSERT INTO game_configs (version, payload, notes, is_active, published_by, published_at) VALUES (?,?,?,1,?,?)
       ON CONFLICT(version) DO UPDATE SET payload = excluded.payload, is_active = 1, published_by = excluded.published_by,
                                          published_at = excluded.published_at, notes = excluded.notes`,
      version,
      JSON.stringify(payload),
      notes,
      publishedBy,
      timestamp,
    );
  });
  return version;
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
