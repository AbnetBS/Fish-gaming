import type {
  AccountStatus,
  FishCategory,
  MovementPattern,
  Role,
  RoundStatus,
  SessionStatus,
  ShotResult,
  TransactionStatus,
  TransactionType,
} from './constants.js';

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

export interface PublicUser {
  id: string;
  username: string;
  email: string;
  role: Role;
  status: AccountStatus;
  avatarSeed: string;
  emailVerified: boolean;
  createdAt: string;
  lastActiveAt: string | null;
}

export interface AdminUserRow extends PublicUser {
  adminRole: Role;
}

/* ------------------------------------------------------------------ *
 * Wallet
 * ------------------------------------------------------------------ */

export interface Wallet {
  id: string;
  userId: string;
  /** Balance expressed in whole DEMO COINS. Never real money. */
  balance: number;
  currency: 'DEMO';
  createdAt: string;
  updatedAt: string;
}

export interface WalletTransaction {
  id: string;
  userId: string;
  walletId: string;
  type: TransactionType;
  /** Signed: negative = debit, positive = credit. Whole coins. */
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  referenceId: string | null;
  gameRoundId: string | null;
  idempotencyKey: string | null;
  status: TransactionStatus;
  description: string | null;
  createdAt: string;
}

/* ------------------------------------------------------------------ *
 * Game configuration (all economy values live here, not in code)
 * ------------------------------------------------------------------ */

export interface FishConfig {
  id: string;
  key: string;
  name: string;
  category: FishCategory;
  health: number;
  reward: number;
  /** Base speed in logical units / second. */
  speed: number;
  /** Collision radius in logical units. */
  size: number;
  rarity: number;
  spawnWeight: number;
  movementPattern: MovementPattern;
  /** Palette index used by the client renderer. */
  palette: number;
  /** Seconds between possible spawns of this species inside a wave. */
  minSpawnIntervalMs: number;
  /** Special behaviour key. `null` for ordinary fish. */
  special: string | null;
  enabled: boolean;
  sortOrder: number;
}

export interface CannonConfig {
  id: string;
  key: string;
  name: string;
  level: number;
  power: number;
  shotCost: number;
  /** Shots per second allowed for this cannon. */
  fireRate: number;
  /** Projectile travel speed in logical units / second. */
  projectileSpeed: number;
  enabled: boolean;
}

export interface RoomConfig {
  id: string;
  key: string;
  name: string;
  description: string;
  minBet: number;
  maxBet: number;
  maxPlayers: number;
  /** Species allowed to spawn in this room (fish ids). Empty = all enabled. */
  fishPool: string[];
  /** Multiplies the room spawn rate (1 = normal). */
  spawnRateMultiplier: number;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
}

export interface GameSettings {
  /** Maximum simultaneous fish in one room simulation. */
  maxActiveFish: number;
  /** Target fish spawns per second per room. */
  fishSpawnRate: number;
  /** Maximum projectiles alive in one room simulation. */
  maxProjectiles: number;
  /** Round duration in seconds before an automatic rollover. */
  roundDurationS: number;
  /** Global speed multiplier applied to every fish. */
  gameSpeed: number;
  /** Every N seconds a "wave" burst of extra fish is released. */
  waveIntervalS: number;
  /** How many extra fish a wave releases. */
  waveSize: number;
  /** Minimum / maximum shot value allowed globally. */
  minShotValue: number;
  maxShotValue: number;
  /** Seconds a fish stays on screen before it swims away. */
  fishLifetimeS: number;
  /** Toggle for special-fish spawning. */
  specialFishEnabled: boolean;
  /** Return-to-player target used for reporting only (0..1). */
  rtpTarget: number;
}

export interface GameConfiguration {
  version: string;
  fish: FishConfig[];
  cannons: CannonConfig[];
  rooms: RoomConfig[];
  settings: GameSettings;
  publishedAt: string;
  publishedBy: string | null;
  notes: string | null;
}

/* ------------------------------------------------------------------ *
 * Rooms / rounds / sessions
 * ------------------------------------------------------------------ */

export interface RoomSummary {
  id: string;
  key: string;
  name: string;
  description: string;
  minBet: number;
  maxBet: number;
  maxPlayers: number;
  status: 'ACTIVE' | 'INACTIVE';
  playersInRoom: number;
  currentRoundId: string | null;
}

export interface GameRound {
  id: string;
  roomId: string;
  status: RoundStatus;
  startedAt: string;
  endedAt: string | null;
  configVersion: string;
}

export interface GameSession {
  id: string;
  userId: string;
  roomId: string;
  roundId: string;
  cannonId: string | null;
  status: SessionStatus;
  startedAt: string;
  endedAt: string | null;
  totalShots: number;
  totalWagered: number;
  totalRewarded: number;
}

/* ------------------------------------------------------------------ *
 * Gameplay I/O
 * ------------------------------------------------------------------ */

export interface FireRequest {
  /** Client-generated unique reference for idempotency. */
  clientRef: string;
  roomId: string;
  cannonKey: string;
  /** Aiming angle in radians (0 = right, measured clockwise in screen space). */
  angle: number;
  /** Origin of the shot in logical coordinates. */
  originX: number;
  originY: number;
  /** Client timestamp (ms). Used only for diagnostics. */
  clientTime: number;
}

export interface FireAck {
  ok: boolean;
  /** Canonical projectile id assigned by the server. */
  projectileId?: string;
  /** Echoed client reference so the client can reconcile prediction. */
  clientRef: string;
  cost: number;
  damage: number;
  angle: number;
  speed: number;
  originX: number;
  originY: number;
  balance: number;
  /** Rejection reason when ok === false. */
  code?: string;
  message?: string;
}

export interface GameHistoryEntry {
  id: string;
  sessionId: string;
  roundId: string;
  roomId: string;
  roomName: string;
  cannonName: string;
  cannonKey: string;
  shotCost: number;
  fishKey: string | null;
  fishName: string | null;
  reward: number;
  result: ShotResult;
  createdAt: string;
}

export interface LeaderboardEntry {
  rank: number;
  username: string;
  /** Demo coins won (sum of WIN transactions) inside the window. */
  earned: number;
  /** Number of rounds played inside the window. */
  rounds: number;
  avatarSeed: string;
}

export type LeaderboardWindow = 'daily' | 'weekly' | 'alltime';

/* ------------------------------------------------------------------ *
 * Audit / system
 * ------------------------------------------------------------------ */

export interface AuditEntry {
  id: string;
  adminId: string;
  adminUsername: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  previousValue: string | null;
  newValue: string | null;
  metadata: string | null;
  createdAt: string;
}

export interface SystemSetting {
  key: string;
  value: string;
  description: string | null;
  updatedAt: string;
}

export interface AdminStats {
  totalUsers: number;
  activeUsers: number;
  activeRooms: number;
  gamesToday: number;
  shotsToday: number;
  demoCoinsWageredToday: number;
  demoCoinsRewardedToday: number;
  rtpToday: number | null;
  onlinePlayers: number;
  usersOverTime: { date: string; count: number }[];
  shotsOverTime: { date: string; count: number }[];
  popularRooms: { name: string; count: number }[];
  popularFish: { name: string; count: number }[];
  activityByHour: { hour: number; shots: number }[];
}

/* ------------------------------------------------------------------ *
 * API envelopes
 * ------------------------------------------------------------------ */

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
