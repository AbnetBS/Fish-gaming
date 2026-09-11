/**
 * Reef Raiders — shared domain constants.
 *
 * These values are shared by the API server and the web client so that both
 * sides agree on vocabulary. NOTE: nothing here is an *economy* value.
 * All economy numbers (fish rewards, cannon costs, spawn weights, room limits)
 * live in the database configuration system and are served to clients at
 * runtime — see `packages/server/src/modules/config`.
 */

/** Logical game resolution. The renderer scales this to any viewport. */
export const GAME_WIDTH = 1920;
export const GAME_HEIGHT = 1080;

/** Server authoritative simulation rate. */
export const SIM_TICK_MS = 50;
export const SNAPSHOT_MS = 50;

/** Human-readable currency label. This is NEVER real money. */
export const CURRENCY_LABEL = 'DEMO COINS';
export const CURRENCY_CODE = 'DEMO';

/** Starting balance for a freshly registered account. */
export const DEFAULT_STARTING_DEMO_COINS = 10_000;

export const ROLES = [
  'USER',
  'ADMIN',
  'SUPER_ADMIN',
  'GAME_ADMIN',
  'FINANCE_ADMIN',
  'SUPPORT_ADMIN',
  'COMPLIANCE_ADMIN',
] as const;
export type Role = (typeof ROLES)[number];
export type AdminRole = Exclude<Role, 'USER'>;

export const ADMIN_ROLES: AdminRole[] = [
  'ADMIN',
  'SUPER_ADMIN',
  'GAME_ADMIN',
  'FINANCE_ADMIN',
  'SUPPORT_ADMIN',
  'COMPLIANCE_ADMIN',
];

export const ACCOUNT_STATUSES = ['ACTIVE', 'PENDING_VERIFICATION', 'SUSPENDED', 'CLOSED'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const TRANSACTION_TYPES = [
  'DEMO_CREDIT',
  'BET',
  'WIN',
  'REFUND',
  'ADMIN_ADJUSTMENT',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = ['PENDING', 'COMPLETED', 'FAILED', 'REVERSED'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const ROUND_STATUSES = ['WAITING', 'ACTIVE', 'PAUSED', 'ENDED'] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

export const SESSION_STATUSES = ['ACTIVE', 'ENDED', 'ABANDONED'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SHOT_RESULTS = ['MISSED', 'HIT', 'KILL'] as const;
export type ShotResult = (typeof SHOT_RESULTS)[number];

export const MOVEMENT_PATTERNS = [
  'STRAIGHT',
  'DIAGONAL',
  'SINE',
  'CIRCULAR',
  'CURVED',
  'WANDER',
  'BOSS',
] as const;
export type MovementPattern = (typeof MOVEMENT_PATTERNS)[number];

export const FISH_CATEGORIES = [
  'COMMON',
  'MEDIUM',
  'LARGE',
  'RARE',
  'BOSS',
  'SPECIAL_GOLDEN',
  'SPECIAL_TREASURE',
  'SPECIAL_SPEED',
  'SPECIAL_BOMB',
] as const;
export type FishCategory = (typeof FISH_CATEGORIES)[number];

export const GAME_EVENT_TYPES = [
  'ROUND_STARTED',
  'ROUND_ENDED',
  'PLAYER_JOINED',
  'PLAYER_LEFT',
  'PLAYER_SHOT',
  'FISH_SPAWNED',
  'FISH_HIT',
  'FISH_DEFEATED',
  'REWARD_GRANTED',
  'SPECIAL_EFFECT',
  'WAVE_STARTED',
] as const;
export type GameEventType = (typeof GAME_EVENT_TYPES)[number];

/** Machine-readable error codes returned by the API in `error.code`. */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_UNAVAILABLE: 'ROOM_UNAVAILABLE',
  MAINTENANCE: 'MAINTENANCE',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ACCOUNT_NOT_VERIFIED: 'ACCOUNT_NOT_VERIFIED',
  NO_ACTIVE_SESSION: 'NO_ACTIVE_SESSION',
  INVALID_SESSION: 'INVALID_SESSION',
  WEAPON_UNAVAILABLE: 'WEAPON_UNAVAILABLE',
  BET_OUT_OF_RANGE: 'BET_OUT_OF_RANGE',
  GAME_UNAVAILABLE: 'GAME_UNAVAILABLE',
  SELF_EXCLUDED: 'SELF_EXCLUDED',
  SESSION_LIMIT_REACHED: 'SESSION_LIMIT_REACHED',
  REAL_MONEY_DISABLED: 'REAL_MONEY_DISABLED',
  INTERNAL: 'INTERNAL',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
