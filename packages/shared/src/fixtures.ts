import type { CannonConfig, FishConfig, GameSettings, RoomConfig } from './types.js';

/**
 * Baseline economy used by the installer on first boot.
 *
 * These are *starting values*, written into the database once. From then on the
 * database is the only source of truth: administrators edit them, every change
 * is published as an immutable configuration version, and clients fetch the live
 * values at runtime. Nothing in the game reads these numbers from code.
 */

const stamp = '2026-01-01T00:00:00.000Z';

export const BASELINE_FISH: FishConfig[] = [
  { id: 'fsh_blue_darter', key: 'blue_darter', name: 'Blue Darter', category: 'COMMON', health: 1, reward: 2, speed: 230, size: 26, rarity: 1, spawnWeight: 46, movementPattern: 'STRAIGHT', palette: 0, minSpawnIntervalMs: 120, special: null, enabled: true, sortOrder: 1 },
  { id: 'fsh_silver_sprat', key: 'silver_sprat', name: 'Silver Sprat', category: 'COMMON', health: 1, reward: 2, speed: 265, size: 23, rarity: 1, spawnWeight: 38, movementPattern: 'SINE', palette: 1, minSpawnIntervalMs: 120, special: null, enabled: true, sortOrder: 2 },
  { id: 'fsh_coral_wrasse', key: 'coral_wrasse', name: 'Coral Wrasse', category: 'MEDIUM', health: 3, reward: 5, speed: 185, size: 34, rarity: 2, spawnWeight: 24, movementPattern: 'WANDER', palette: 2, minSpawnIntervalMs: 250, special: null, enabled: true, sortOrder: 3 },
  { id: 'fsh_sunset_angelfish', key: 'sunset_angelfish', name: 'Sunset Angelfish', category: 'MEDIUM', health: 3, reward: 6, speed: 170, size: 36, rarity: 2, spawnWeight: 18, movementPattern: 'CURVED', palette: 3, minSpawnIntervalMs: 260, special: null, enabled: true, sortOrder: 4 },
  { id: 'fsh_tide_grouper', key: 'tide_grouper', name: 'Tide Grouper', category: 'LARGE', health: 10, reward: 20, speed: 120, size: 52, rarity: 4, spawnWeight: 10, movementPattern: 'DIAGONAL', palette: 4, minSpawnIntervalMs: 600, special: null, enabled: true, sortOrder: 5 },
  { id: 'fsh_reef_sentinel', key: 'reef_sentinel', name: 'Reef Sentinel', category: 'LARGE', health: 10, reward: 22, speed: 110, size: 54, rarity: 4, spawnWeight: 8, movementPattern: 'CIRCULAR', palette: 5, minSpawnIntervalMs: 620, special: null, enabled: true, sortOrder: 6 },
  { id: 'fsh_lantern_ray', key: 'lantern_ray', name: 'Lantern Ray', category: 'RARE', health: 25, reward: 50, speed: 95, size: 68, rarity: 8, spawnWeight: 4, movementPattern: 'WANDER', palette: 6, minSpawnIntervalMs: 2200, special: null, enabled: true, sortOrder: 7 },
  { id: 'fsh_abyss_angler', key: 'abyss_angler', name: 'Abyss Angler', category: 'RARE', health: 30, reward: 60, speed: 88, size: 64, rarity: 9, spawnWeight: 3, movementPattern: 'CURVED', palette: 7, minSpawnIntervalMs: 2600, special: null, enabled: true, sortOrder: 8 },
  { id: 'fsh_golden_koi', key: 'golden_koi', name: 'Golden Koi', category: 'SPECIAL_GOLDEN', health: 5, reward: 25, speed: 320, size: 30, rarity: 12, spawnWeight: 2.5, movementPattern: 'SINE', palette: 8, minSpawnIntervalMs: 4000, special: 'golden', enabled: true, sortOrder: 9 },
  { id: 'fsh_treasure_coffer', key: 'treasure_coffer', name: 'Treasure Coffer', category: 'SPECIAL_TREASURE', health: 14, reward: 40, speed: 105, size: 44, rarity: 14, spawnWeight: 1.6, movementPattern: 'STRAIGHT', palette: 9, minSpawnIntervalMs: 7000, special: 'treasure', enabled: true, sortOrder: 10 },
  { id: 'fsh_velocity_fin', key: 'velocity_fin', name: 'Velocity Fin', category: 'SPECIAL_SPEED', health: 6, reward: 14, speed: 460, size: 28, rarity: 6, spawnWeight: 2, movementPattern: 'STRAIGHT', palette: 10, minSpawnIntervalMs: 5000, special: 'speed', enabled: true, sortOrder: 11 },
  { id: 'fsh_puffer_bomb', key: 'puffer_bomb', name: 'Puffer Bomb', category: 'SPECIAL_BOMB', health: 8, reward: 15, speed: 140, size: 40, rarity: 7, spawnWeight: 2, movementPattern: 'WANDER', palette: 11, minSpawnIntervalMs: 6000, special: 'bomb', enabled: true, sortOrder: 12 },
  { id: 'fsh_leviathan', key: 'leviathan', name: 'Leviathan', category: 'BOSS', health: 120, reward: 260, speed: 62, size: 118, rarity: 30, spawnWeight: 0.6, movementPattern: 'BOSS', palette: 12, minSpawnIntervalMs: 25000, special: 'boss', enabled: true, sortOrder: 13 },
];

export const BASELINE_CANNONS: CannonConfig[] = [
  { id: 'cn_tidecaster', key: 'tidecaster', name: 'Tidecaster', level: 1, power: 1, shotCost: 1, fireRate: 3.2, projectileSpeed: 1650, enabled: true },
  { id: 'cn_current_blaster', key: 'current_blaster', name: 'Current Blaster', level: 2, power: 2, shotCost: 2, fireRate: 3.0, projectileSpeed: 1750, enabled: true },
  { id: 'cn_reef_breaker', key: 'reef_breaker', name: 'Reef Breaker', level: 3, power: 5, shotCost: 5, fireRate: 2.6, projectileSpeed: 1850, enabled: true },
  { id: 'cn_abyss_cannon', key: 'abyss_cannon', name: 'Abyss Cannon', level: 4, power: 10, shotCost: 10, fireRate: 2.2, projectileSpeed: 1950, enabled: true },
  { id: 'cn_leviathan_mortar', key: 'leviathan_mortar', name: 'Leviathan Mortar', level: 5, power: 20, shotCost: 20, fireRate: 1.8, projectileSpeed: 2050, enabled: true },
];

export const BASELINE_ROOMS: RoomConfig[] = [
  { id: 'rm_shallow_lagoon', key: 'shallow_lagoon', name: 'Shallow Lagoon', description: 'Calm starter reef. Small, fast fish and low stakes.', minBet: 1, maxBet: 5, maxPlayers: 4, fishPool: [], spawnRateMultiplier: 1, status: 'ACTIVE', createdAt: stamp },
  { id: 'rm_coral_shelf', key: 'coral_shelf', name: 'Coral Shelf', description: 'Denser schools and the first rare visitors.', minBet: 5, maxBet: 25, maxPlayers: 4, fishPool: [], spawnRateMultiplier: 1.15, status: 'ACTIVE', createdAt: stamp },
  { id: 'rm_kelp_canyon', key: 'kelp_canyon', name: 'Kelp Canyon', description: 'Narrow lanes, big fish, fast reflexes required.', minBet: 10, maxBet: 50, maxPlayers: 4, fishPool: [], spawnRateMultiplier: 1.3, status: 'ACTIVE', createdAt: stamp },
  { id: 'rm_abyssal_trench', key: 'abyssal_trench', name: 'Abyssal Trench', description: 'Deep water. Leviathan territory for high-stakes hunters.', minBet: 20, maxBet: 100, maxPlayers: 4, fishPool: [], spawnRateMultiplier: 1.45, status: 'ACTIVE', createdAt: stamp },
];

export const BASELINE_SETTINGS: GameSettings = {
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

export const INITIAL_CONFIG_VERSION = '1.0.0';
