import type { Database } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { uid } from '../../lib/ids.js';
import { publishConfiguration } from '../../db/seed.js';

export { publishConfiguration };
import { writeAudit, diffObjects } from '../../lib/audit.js';
import type { CannonConfig, FishCategory, FishConfig, GameConfiguration, GameSettings, MovementPattern, RoomConfig } from '@reef/shared';
import { FISH_CATEGORIES, MOVEMENT_PATTERNS } from '@reef/shared';

/**
 * Game configuration service.
 *
 * The database tables (`fish`, `cannons`, `game_rooms`, `system_settings`) are
 * the editable working copy. Publishing freezes a snapshot into
 * `game_configs.payload` and marks it active; a running round keeps the version
 * it started with, so configuration changes never mutate a live game.
 */

export interface ConfigMeta {
  version: string;
  publishedAt: string;
  publishedBy: string | null;
  notes: string | null;
  isDraftAhead: boolean;
}

const SETTINGS_KEY_MAP: Record<keyof GameSettings, string> = {
  maxActiveFish: 'max_active_fish',
  fishSpawnRate: 'fish_spawn_rate',
  maxProjectiles: 'max_projectiles',
  roundDurationS: 'round_duration_s',
  gameSpeed: 'game_speed',
  waveIntervalS: 'wave_interval_s',
  waveSize: 'wave_size',
  minShotValue: 'min_shot_value',
  maxShotValue: 'max_shot_value',
  fishLifetimeS: 'fish_lifetime_s',
  specialFishEnabled: 'special_fish_enabled',
  rtpTarget: 'rtp_target',
};

const DEFAULT_SETTINGS: GameSettings = {
  maxActiveFish: 45,
  fishSpawnRate: 4.6,
  maxProjectiles: 90,
  roundDurationS: 1800,
  gameSpeed: 1,
  waveIntervalS: 45,
  waveSize: 9,
  minShotValue: 1,
  maxShotValue: 100,
  fishLifetimeS: 28,
  specialFishEnabled: true,
  rtpTarget: 0.9,
};

export function mapFish(r: any): FishConfig {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    category: r.category as FishCategory,
    health: r.health,
    reward: r.reward,
    speed: r.speed,
    size: r.size,
    rarity: r.rarity,
    spawnWeight: r.spawn_weight,
    movementPattern: r.movement_pattern as MovementPattern,
    palette: r.palette,
    minSpawnIntervalMs: r.min_spawn_interval_ms,
    special: r.special ?? null,
    enabled: r.enabled === 1,
    sortOrder: r.sort_order,
  };
}

function mapCannon(r: any): CannonConfig {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    level: r.level,
    power: r.power,
    shotCost: r.shot_cost,
    fireRate: r.fire_rate,
    projectileSpeed: r.projectile_speed,
    enabled: r.enabled === 1,
  };
}

function mapRoom(r: any): RoomConfig {
  let pool: string[] = [];
  try {
    pool = JSON.parse(r.fish_pool);
  } catch {
    pool = [];
  }
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    minBet: r.min_bet,
    maxBet: r.max_bet,
    maxPlayers: r.max_players,
    fishPool: Array.isArray(pool) ? pool : [],
    spawnRateMultiplier: r.spawn_rate_multiplier,
    status: r.status,
    createdAt: r.created_at,
  };
}

export function readWorkingSettings(db: Database): GameSettings {
  const rows = db.all<{ key: string; value: string }>('SELECT key, value FROM system_settings');
  const out: GameSettings = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    const entry = (Object.entries(SETTINGS_KEY_MAP) as [keyof GameSettings, string][]).find(([, k]) => k === row.key);
    if (!entry) continue;
    const key = entry[0];
    const raw = row.value;
    if (typeof out[key] === 'boolean') (out[key] as boolean) = raw === 'true';
    else (out[key] as number) = Number(raw);
  }
  return out;
}

export function writeSettings(db: Database, patch: Partial<GameSettings>): GameSettings {
  const timestamp = new Date().toISOString();
  for (const [k, v] of Object.entries(patch) as [keyof GameSettings, number | boolean][]) {
    const column = SETTINGS_KEY_MAP[k];
    if (!column) continue;
    const value = typeof v === 'boolean' ? String(v) : String(v);
    db.run(
      `INSERT INTO system_settings (key, value, description, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      column,
      value,
      `Game configuration: ${k}`,
      timestamp,
    );
  }
  return readWorkingSettings(db);
}

export function getFish(db: Database): FishConfig[] {
  return db.all<any>('SELECT * FROM fish ORDER BY sort_order, key').map(mapFish);
}

export function getCannons(db: Database): CannonConfig[] {
  return db.all<any>('SELECT * FROM cannons ORDER BY level').map(mapCannon);
}

export function getRooms(db: Database): RoomConfig[] {
  return db
    .all<any>(
      `SELECT * FROM game_rooms
       WHERE NOT EXISTS (SELECT 1 FROM tournaments t WHERE t.arena_room_id = game_rooms.id)
       ORDER BY min_bet, key`,
    )
    .map(mapRoom);
}

export function buildWorkingConfiguration(db: Database, version: string): GameConfiguration {
  return {
    version,
    fish: getFish(db),
    cannons: getCannons(db),
    rooms: getRooms(db),
    settings: readWorkingSettings(db),
    publishedAt: new Date().toISOString(),
    publishedBy: null,
    notes: null,
  };
}

/** The active published configuration — what new rounds are created with. */
export function getActiveConfiguration(db: Database): GameConfiguration {
  const row = db.get<{ version: string; payload: string; published_at: string; published_by: string; notes: string }>(
    'SELECT version, payload, published_at, published_by, notes FROM game_configs WHERE is_active = 1 LIMIT 1',
  );
  if (!row) {
    return buildWorkingConfiguration(db, '0.0.0-draft');
  }
  return JSON.parse(row.payload) as GameConfiguration;
}

/** A specific historical version — used to audit how a finished round played. */
export function getConfigurationVersion(db: Database, version: string): GameConfiguration | null {
  const row = db.get<{ payload: string }>('SELECT payload FROM game_configs WHERE version = ?', version);
  return row ? (JSON.parse(row.payload) as GameConfiguration) : null;
}

export function listConfigVersions(db: Database, limit = 25) {
  return db
    .all<{ version: string; notes: string | null; is_active: number; published_at: string; username: string | null }>(
      `SELECT g.version, g.notes, g.is_active, g.published_at, u.username
       FROM game_configs g LEFT JOIN users u ON u.id = g.published_by
       ORDER BY g.published_at DESC LIMIT ?`,
      Math.min(limit, 100),
    )
    .map((r) => ({
      version: r.version,
      notes: r.notes,
      active: r.is_active === 1,
      publishedAt: r.published_at,
      publishedBy: r.username,
    }));
}

export function configMeta(db: Database): ConfigMeta {
  const active = db.get<{ version: string; published_at: string; published_by: string; notes: string }>(
    'SELECT version, published_at, published_by, notes FROM game_configs WHERE is_active = 1 LIMIT 1',
  );
  if (!active) return { version: '0.0.0-draft', publishedAt: '', publishedBy: null, notes: null, isDraftAhead: true };
  const published = JSON.parse(
    db.get<{ payload: string }>('SELECT payload FROM game_configs WHERE version = ?', active.version)!.payload,
  ) as GameConfiguration;
  const working = buildWorkingConfiguration(db, active.version);
  return {
    version: active.version,
    publishedAt: active.published_at,
    publishedBy: active.published_by,
    notes: active.notes,
    isDraftAhead: JSON.stringify(stripVolatile(published)) !== JSON.stringify(stripVolatile(working)),
  };
}

function stripVolatile(c: GameConfiguration) {
  return {
    fish: c.fish.map(({ id: _id, ...rest }) => rest),
    cannons: c.cannons.map(({ id: _id, ...rest }) => rest),
    settings: c.settings,
  };
}

export function nextVersion(current: string): string {
  const parts = current.split('.').map((p) => Number.parseInt(p, 10));
  const [a = 1, b = 0, c = 0] = parts.map((n) => (Number.isFinite(n) ? n : 0));
  return `${a}.${b}.${c + 1}`;
}

export interface PublishContext {
  db: Database;
  adminId: string;
  adminUsername: string | null;
  ip?: string | null;
}

export function publish(ctx: PublishContext, notes: string | null): GameConfiguration {
  const meta = configMeta(ctx.db);
  const version = nextVersion(meta.version === '0.0.0-draft' ? '1.0.0' : meta.version);
  publishConfiguration(ctx.db, version, ctx.adminId, notes);
  writeAudit(ctx.db, {
    adminId: ctx.adminId,
    adminUsername: ctx.adminUsername,
    action: 'CONFIG_PUBLISH',
    entity: 'game_configs',
    entityId: version,
    previousValue: { activeVersion: meta.version },
    newValue: { activeVersion: version, notes },
    ip: ctx.ip ?? null,
  });
  return getActiveConfiguration(ctx.db);
}

/* ------------------------------- fish CRUD ------------------------------- */

export interface FishPatch {
  name?: string;
  category?: FishCategory;
  health?: number;
  reward?: number;
  speed?: number;
  size?: number;
  rarity?: number;
  spawnWeight?: number;
  movementPattern?: MovementPattern;
  palette?: number;
  minSpawnIntervalMs?: number;
  special?: string | null;
  enabled?: boolean;
  sortOrder?: number;
}

const FISH_COLUMNS: Record<string, string> = {
  name: 'name',
  category: 'category',
  health: 'health',
  reward: 'reward',
  speed: 'speed',
  size: 'size',
  rarity: 'rarity',
  spawnWeight: 'spawn_weight',
  movementPattern: 'movement_pattern',
  palette: 'palette',
  minSpawnIntervalMs: 'min_spawn_interval_ms',
  special: 'special',
  enabled: 'enabled',
  sortOrder: 'sort_order',
};

export function validateFishPatch(patch: FishPatch): void {
  if (patch.health !== undefined && (!Number.isInteger(patch.health) || patch.health < 1 || patch.health > 100_000)) {
    throw badRequest('Fish health must be a whole number between 1 and 100000.');
  }
  if (patch.reward !== undefined && (!Number.isInteger(patch.reward) || patch.reward < 0 || patch.reward > 1_000_000)) {
    throw badRequest('Fish reward must be a whole number between 0 and 1000000.');
  }
  if (patch.speed !== undefined && !(patch.speed > 0 && patch.speed <= 4000)) {
    throw badRequest('Fish speed must be between 1 and 4000.');
  }
  if (patch.size !== undefined && !(patch.size > 0 && patch.size <= 400)) {
    throw badRequest('Fish size must be between 1 and 400.');
  }
  if (patch.spawnWeight !== undefined && !(patch.spawnWeight >= 0 && patch.spawnWeight <= 1000)) {
    throw badRequest('Spawn weight must be between 0 and 1000.');
  }
  if (patch.movementPattern !== undefined && !MOVEMENT_PATTERNS.includes(patch.movementPattern)) {
    throw badRequest('Unknown movement pattern.');
  }
  if (patch.category !== undefined && !FISH_CATEGORIES.includes(patch.category)) {
    throw badRequest('Unknown fish category.');
  }
  if (patch.minSpawnIntervalMs !== undefined && (!Number.isInteger(patch.minSpawnIntervalMs) || patch.minSpawnIntervalMs < 0)) {
    throw badRequest('Minimum spawn interval must be a non-negative whole number of milliseconds.');
  }
}

export function createFish(ctx: PublishContext & { db: Database }, data: FishPatch & { key: string; name: string }): FishConfig {
  const db = ctx.db;
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(data.key)) throw badRequest('Fish key must be lowercase snake_case (2-32 chars).');
  if (db.get('SELECT 1 FROM fish WHERE key = ?', data.key)) throw badRequest('A fish with that key already exists.');
  validateFishPatch(data);
  const timestamp = new Date().toISOString();
  const id = uid('fsh');
  db.run(
    `INSERT INTO fish (id, key, name, category, health, reward, speed, size, rarity, spawn_weight, movement_pattern,
                       palette, min_spawn_interval_ms, special, enabled, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    data.key,
    data.name,
    data.category ?? 'COMMON',
    data.health ?? 1,
    data.reward ?? 2,
    data.speed ?? 160,
    data.size ?? 30,
    data.rarity ?? 1,
    data.spawnWeight ?? 10,
    data.movementPattern ?? 'STRAIGHT',
    data.palette ?? Math.floor(Math.random() * 13),
    data.minSpawnIntervalMs ?? 400,
    data.special ?? null,
    data.enabled === false ? 0 : 1,
    data.sortOrder ?? (db.scalar<number>('SELECT COALESCE(MAX(sort_order),0)+1 FROM fish') ?? 1),
    timestamp,
    timestamp,
  );
  writeAudit(db, {
    adminId: ctx.adminId,
    adminUsername: ctx.adminUsername,
    action: 'FISH_CREATE',
    entity: 'fish',
    entityId: id,
    previousValue: null,
    newValue: data,
    ip: ctx.ip ?? null,
  });
  return mapFish(db.get<any>('SELECT * FROM fish WHERE id = ?', id)!);
}

export function updateFish(ctx: PublishContext, id: string, patch: FishPatch): { fish: FishConfig; changed: Record<string, unknown> } {
  const db = ctx.db;
  const before = db.get<any>('SELECT * FROM fish WHERE id = ?', id);
  if (!before) throw notFound('Fish not found.');
  validateFishPatch(patch);

  const assignments: string[] = [];
  const args: unknown[] = [];
  const nextRow: Record<string, unknown> = { ...before };
  for (const [k, v] of Object.entries(patch) as [keyof FishPatch, unknown][]) {
    const column = FISH_COLUMNS[k];
    if (!column || v === undefined) continue;
    const stored = k === 'enabled' ? (v ? 1 : 0) : (v as number | string | null);
    assignments.push(`${column} = ?`);
    args.push(stored);
    nextRow[column] = stored;
  }
  if (!assignments.length) return { fish: mapFish(before), changed: {} };

  assignments.push('updated_at = ?');
  args.push(new Date().toISOString());
  db.run(`UPDATE fish SET ${assignments.join(', ')} WHERE id = ?`, ...args, id);

  const changed = diffObjects(pickDiffable(before), pickDiffable(nextRow));
  writeAudit(db, {
    adminId: ctx.adminId,
    adminUsername: ctx.adminUsername,
    action: 'FISH_UPDATE',
    entity: 'fish',
    entityId: id,
    previousValue: changed,
    newValue: patch,
    metadata: { key: before.key, name: before.name },
    ip: ctx.ip ?? null,
  });
  return { fish: mapFish(db.get<any>('SELECT * FROM fish WHERE id = ?', id)!), changed };
}

function pickDiffable(r: Record<string, unknown>) {
  const { id: _id, created_at: _c, updated_at: _u, ...rest } = r;
  return rest as Record<string, unknown>;
}

export function deleteFish(ctx: PublishContext, id: string): void {
  const db = ctx.db;
  const row = db.get<any>('SELECT * FROM fish WHERE id = ?', id);
  if (!row) throw notFound('Fish not found.');
  // Soft-disable rather than delete: history rows reference the fish key.
  db.run('UPDATE fish SET enabled = 0, spawn_weight = 0, updated_at = ? WHERE id = ?', new Date().toISOString(), id);
  writeAudit(db, {
    adminId: ctx.adminId,
    adminUsername: ctx.adminUsername,
    action: 'FISH_DISABLE',
    entity: 'fish',
    entityId: id,
    previousValue: { enabled: row.enabled, spawnWeight: row.spawn_weight },
    newValue: { enabled: false, spawnWeight: 0 },
    metadata: { key: row.key },
    ip: ctx.ip ?? null,
  });
}

/* ------------------------------ cannon CRUD ------------------------------ */

export interface CannonPatch {
  name?: string;
  level?: number;
  power?: number;
  shotCost?: number;
  fireRate?: number;
  projectileSpeed?: number;
  enabled?: boolean;
}

export function validateCannonPatch(patch: CannonPatch): void {
  if (patch.level !== undefined && (!Number.isInteger(patch.level) || patch.level < 1 || patch.level > 20)) {
    throw badRequest('Cannon level must be a whole number between 1 and 20.');
  }
  if (patch.power !== undefined && (!Number.isInteger(patch.power) || patch.power < 1 || patch.power > 1000)) {
    throw badRequest('Cannon power must be a whole number between 1 and 1000.');
  }
  if (patch.shotCost !== undefined && (!Number.isInteger(patch.shotCost) || patch.shotCost < 1 || patch.shotCost > 100_000)) {
    throw badRequest('Shot cost must be a whole number between 1 and 100000.');
  }
  if (patch.fireRate !== undefined && !(patch.fireRate > 0 && patch.fireRate <= 20)) {
    throw badRequest('Fire rate must be between 0 and 20 shots per second.');
  }
  if (patch.projectileSpeed !== undefined && !(patch.projectileSpeed > 100 && patch.projectileSpeed <= 8000)) {
    throw badRequest('Projectile speed must be between 100 and 8000.');
  }
}

export function createCannon(ctx: PublishContext, data: CannonPatch & { key: string; name: string }): CannonConfig {
  const db = ctx.db;
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(data.key)) throw badRequest('Cannon key must be lowercase snake_case.');
  if (db.get('SELECT 1 FROM cannons WHERE key = ?', data.key)) throw badRequest('A cannon with that key already exists.');
  validateCannonPatch(data);
  if (data.level !== undefined && db.get('SELECT 1 FROM cannons WHERE level = ?', data.level)) {
    throw badRequest('A cannon with that level already exists.');
  }
  const timestamp = new Date().toISOString();
  const id = uid('cn');
  db.run(
    `INSERT INTO cannons (id, key, name, level, power, shot_cost, fire_rate, projectile_speed, enabled, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    data.key,
    data.name,
    data.level ?? ((db.scalar<number>('SELECT COALESCE(MAX(level),0)+1 FROM cannons') ?? 1)),
    data.power ?? 1,
    data.shotCost ?? 1,
    data.fireRate ?? 3,
    data.projectileSpeed ?? 1700,
    data.enabled === false ? 0 : 1,
    timestamp,
    timestamp,
  );
  writeAudit(db, {
    adminId: ctx.adminId,
    adminUsername: ctx.adminUsername,
    action: 'CANNON_CREATE',
    entity: 'cannons',
    entityId: id,
    previousValue: null,
    newValue: data,
    ip: ctx.ip ?? null,
  });
  return mapCannon(db.get<any>('SELECT * FROM cannons WHERE id = ?', id)!);
}

export function updateCannon(ctx: PublishContext, id: string, patch: CannonPatch): CannonConfig {
  const db = ctx.db;
  const before = db.get<any>('SELECT * FROM cannons WHERE id = ?', id);
  if (!before) throw notFound('Cannon not found.');
  validateCannonPatch(patch);
  if (patch.level !== undefined && patch.level !== before.level && db.get('SELECT 1 FROM cannons WHERE level = ? AND id <> ?', patch.level, id)) {
    throw badRequest('Another cannon already uses that level.');
  }

  const columns: Record<string, string> = {
    name: 'name',
    level: 'level',
    power: 'power',
    shotCost: 'shot_cost',
    fireRate: 'fire_rate',
    projectileSpeed: 'projectile_speed',
    enabled: 'enabled',
  };
  const assignments: string[] = [];
  const args: unknown[] = [];
  const nextRow: Record<string, unknown> = { ...before };
  for (const [k, v] of Object.entries(patch) as [string, unknown][]) {
    const column = columns[k];
    if (!column || v === undefined) continue;
    const stored = k === 'enabled' ? (v ? 1 : 0) : v;
    assignments.push(`${column} = ?`);
    args.push(stored);
    nextRow[column] = stored;
  }
  if (!assignments.length) return mapCannon(before);
  assignments.push('updated_at = ?');
  args.push(new Date().toISOString());
  db.run(`UPDATE cannons SET ${assignments.join(', ')} WHERE id = ?`, ...args, id);

  writeAudit(db, {
    adminId: ctx.adminId,
    adminUsername: ctx.adminUsername,
    action: 'CANNON_UPDATE',
    entity: 'cannons',
    entityId: id,
    previousValue: diffObjects(pickDiffable(before), pickDiffable(nextRow)),
    newValue: patch,
    metadata: { key: before.key },
    ip: ctx.ip ?? null,
  });
  return mapCannon(db.get<any>('SELECT * FROM cannons WHERE id = ?', id)!);
}

/* ------------------------------- room CRUD ------------------------------- */

export interface RoomPatch {
  name?: string;
  description?: string;
  minBet?: number;
  maxBet?: number;
  maxPlayers?: number;
  fishPool?: string[];
  spawnRateMultiplier?: number;
  status?: 'ACTIVE' | 'INACTIVE';
}

export function validateRoomPatch(patch: RoomPatch): void {
  if (patch.minBet !== undefined && (!Number.isInteger(patch.minBet) || patch.minBet < 1)) throw badRequest('Minimum bet must be a whole number of at least 1.');
  if (patch.maxBet !== undefined && (!Number.isInteger(patch.maxBet) || patch.maxBet < 1)) throw badRequest('Maximum bet must be a whole number of at least 1.');
  if (patch.minBet !== undefined && patch.maxBet !== undefined && patch.maxBet < patch.minBet) throw badRequest('Maximum bet must be at least the minimum bet.');
  if (patch.maxPlayers !== undefined && (!Number.isInteger(patch.maxPlayers) || patch.maxPlayers < 1 || patch.maxPlayers > 32)) {
    throw badRequest('Room capacity must be between 1 and 32 players.');
  }
  if (patch.spawnRateMultiplier !== undefined && !(patch.spawnRateMultiplier > 0 && patch.spawnRateMultiplier <= 5)) {
    throw badRequest('Spawn rate multiplier must be between 0 and 5.');
  }
}

export function createRoom(ctx: PublishContext, data: RoomPatch & { key: string; name: string }): RoomConfig {
  const db = ctx.db;
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(data.key)) throw badRequest('Room key must be lowercase snake_case.');
  if (db.get('SELECT 1 FROM game_rooms WHERE key = ?', data.key)) throw badRequest('A room with that key already exists.');
  validateRoomPatch(data);
  const timestamp = new Date().toISOString();
  const id = uid('rm');
  db.run(
    `INSERT INTO game_rooms (id, key, name, description, min_bet, max_bet, max_players, fish_pool, spawn_rate_multiplier, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    data.key,
    data.name,
    data.description ?? '',
    data.minBet ?? 1,
    data.maxBet ?? Math.max(5, (data.minBet ?? 1) * 5),
    data.maxPlayers ?? 4,
    JSON.stringify(data.fishPool ?? []),
    data.spawnRateMultiplier ?? 1,
    data.status ?? 'ACTIVE',
    timestamp,
    timestamp,
  );
  writeAudit(db, {
    adminId: ctx.adminId,
    adminUsername: ctx.adminUsername,
    action: 'ROOM_CREATE',
    entity: 'game_rooms',
    entityId: id,
    previousValue: null,
    newValue: data,
    ip: ctx.ip ?? null,
  });
  return mapRoom(db.get<any>('SELECT * FROM game_rooms WHERE id = ?', id)!);
}

export function updateRoom(ctx: PublishContext, id: string, patch: RoomPatch): RoomConfig {
  const db = ctx.db;
  const before = db.get<any>('SELECT * FROM game_rooms WHERE id = ?', id);
  if (!before) throw notFound('Room not found.');
  validateRoomPatch(patch);
  if (patch.fishPool) {
    const known = new Set(db.all<{ id: string }>('SELECT id FROM fish').map((r) => r.id));
    for (const f of patch.fishPool) if (!known.has(f)) throw badRequest(`Unknown fish id in pool: ${f}`);
  }

  const columns: Record<string, string> = {
    name: 'name',
    description: 'description',
    minBet: 'min_bet',
    maxBet: 'max_bet',
    maxPlayers: 'max_players',
    fishPool: 'fish_pool',
    spawnRateMultiplier: 'spawn_rate_multiplier',
    status: 'status',
  };
  const assignments: string[] = [];
  const args: unknown[] = [];
  const nextRow: Record<string, unknown> = { ...before };
  for (const [k, v] of Object.entries(patch) as [string, unknown][]) {
    const column = columns[k];
    if (!column || v === undefined) continue;
    const stored = k === 'fishPool' ? JSON.stringify(v) : v;
    assignments.push(`${column} = ?`);
    args.push(stored);
    nextRow[column] = stored;
  }
  if (!assignments.length) return mapRoom(before);
  assignments.push('updated_at = ?');
  args.push(new Date().toISOString());
  db.run(`UPDATE game_rooms SET ${assignments.join(', ')} WHERE id = ?`, ...args, id);

  writeAudit(db, {
    adminId: ctx.adminId,
    adminUsername: ctx.adminUsername,
    action: 'ROOM_UPDATE',
    entity: 'game_rooms',
    entityId: id,
    previousValue: diffObjects(pickDiffable(before), pickDiffable(nextRow)),
    newValue: patch,
    metadata: { key: before.key },
    ip: ctx.ip ?? null,
  });
  return mapRoom(db.get<any>('SELECT * FROM game_rooms WHERE id = ?', id)!);
}

/* ------------------------------- settings -------------------------------- */

export function updateSettings(ctx: PublishContext, patch: Partial<GameSettings>): GameSettings {
  const db = ctx.db;
  const before = readWorkingSettings(db);
  for (const [k, v] of Object.entries(patch) as [keyof GameSettings, number | boolean][]) {
    if (typeof v !== 'number' && typeof v !== 'boolean') continue;
    if (typeof v === 'number' && !Number.isFinite(v)) throw badRequest(`${k} must be a finite number.`);
  }
  if (patch.minShotValue !== undefined && patch.maxShotValue !== undefined && patch.maxShotValue < patch.minShotValue) {
    throw badRequest('Maximum shot value must be at least the minimum shot value.');
  }
  if (patch.maxActiveFish !== undefined && (patch.maxActiveFish < 1 || patch.maxActiveFish > 400)) {
    throw badRequest('Maximum active fish must be between 1 and 400.');
  }
  if (patch.rtpTarget !== undefined && (patch.rtpTarget <= 0 || patch.rtpTarget > 1)) {
    throw badRequest('RTP target must be between 0 and 1.');
  }
  writeSettings(db, patch);
  writeAudit(db, {
    adminId: ctx.adminId,
    adminUsername: ctx.adminUsername,
    action: 'SETTINGS_UPDATE',
    entity: 'system_settings',
    entityId: 'game_settings',
    previousValue: before,
    newValue: patch,
    ip: ctx.ip ?? null,
  });
  return readWorkingSettings(db);
}

export function getSystemSettings(db: Database) {
  return db
    .all<{ key: string; value: string; description: string | null; updated_at: string }>('SELECT * FROM system_settings ORDER BY key')
    .map((r) => ({ key: r.key, value: r.value, description: r.description, updatedAt: r.updated_at }));
}

export function setSystemSetting(ctx: PublishContext, key: string, value: string, description?: string): void {
  const db = ctx.db;
  if (!/^[a-z0-9_]{2,64}$/.test(key)) throw badRequest('Setting key must be lowercase snake_case.');
  const before = db.get<{ value: string }>('SELECT value FROM system_settings WHERE key = ?', key);
  db.run(
    `INSERT INTO system_settings (key, value, description, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, description = COALESCE(excluded.description, system_settings.description), updated_at = excluded.updated_at`,
    key,
    value,
    description ?? null,
    new Date().toISOString(),
  );
  writeAudit(db, {
    adminId: ctx.adminId,
    adminUsername: ctx.adminUsername,
    action: 'SETTING_UPDATE',
    entity: 'system_settings',
    entityId: key,
    previousValue: before?.value ?? null,
    newValue: value,
    ip: ctx.ip ?? null,
  });
}

export function isMaintenanceMode(db: Database): boolean {
  const row = db.get<{ value: string }>("SELECT value FROM system_settings WHERE key = 'maintenance_mode'");
  return row?.value === 'true';
}
