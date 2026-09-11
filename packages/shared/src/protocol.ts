import type { FishMotionParams } from './sim.js';
import type { FireAck, RoomSummary } from './types.js';

/**
 * Wire protocol for the real-time gameplay channel (`/ws/game`).
 *
 * Design rules — these are what keep bandwidth tiny while still being
 * authoritative:
 *
 *  1. The server never streams animation frames. A fish's *whole trajectory*
 *     is a pure function of its spawn parameters (see `sim.ts`), so the server
 *     sends the spawn once and every client derives the same position forever.
 *  2. After that first message, only meaningful events travel the wire:
 *     fish spawned / despawned, hits, defeats, shots, player join/leave,
 *     round rollover, wave announcements, balance changes.
 *  3. A throttled delta (default 20 Hz, often idle) carries just the diffs.
 *  4. Clients interpolate/predict visually; the server stays authoritative for
 *     damage, rewards and the wallet. A client can lie about aim all it likes —
 *     the server recomputes everything.
 */

/* ------------------------------- client -> server ------------------------------- */

export type ClientMessage =
  | { type: 'auth'; token?: string }
  | { type: 'join'; roomId: string }
  | { type: 'leave' }
  | { type: 'resync' }
  | {
      type: 'fire';
      clientRef: string;
      cannonKey: string;
      angle: number;
      originX: number;
      originY: number;
    }
  | { type: 'setCannon'; cannonKey: string }
  | { type: 'aim'; angle: number }
  | { type: 'ping'; t: number };

/* ------------------------------- shared shapes ------------------------------- */

export interface FishInstance {
  /** Server-assigned instance id, unique within the room. */
  id: number;
  /** Species key from the game configuration. */
  key: string;
  /** Server epoch (ms) at which the fish was spawned — clients derive `age`. */
  t0: number;
  hp: number;
  mhp: number;
  /** Everything needed to reproduce the trajectory deterministically. */
  p: FishMotionParams;
  /** Species base speed (logical units/second). */
  s: number;
  /** 1 while the fish is flashing from a hit (visual only). */
  f: number;
}

export interface ProjectileInstance {
  id: number;
  owner: string;
  x: number;
  y: number;
  a: number;
  /** Cannon level, drives size/colour on the client. */
  lvl: number;
  /** Server epoch (ms) of the shot. */
  t0: number;
  /** Seconds the projectile lives before the server discards it. */
  ttl: number;
  /** Logical units per second. */
  v: number;
}

export interface PlayerInstance {
  id: string;
  username: string;
  avatarSeed: string;
  cannonKey: string;
  cannonLevel: number;
  angle: number;
  /** Cannon anchor in logical coordinates (assigned seat). */
  x: number;
  y: number;
}

export interface RoomSnapshot {
  t: number;
  st: number;
  roundId: string;
  configVersion: string;
  fish: FishInstance[];
  projectiles: ProjectileInstance[];
  players: PlayerInstance[];
}

export interface RoomDelta {
  t: number;
  st: number;
  add: FishInstance[];
  rm: number[];
  hp: { id: number; hp: number; f?: number }[];
}

/* ------------------------------- server -> client ------------------------------- */

export interface FishHitEvent {
  fishId: number;
  projectileId: number;
  hp: number;
  mhp: number;
  x: number;
  y: number;
  damage: number;
  /** `mine` is only ever true for the player who fired the shot. */
  mine?: boolean;
  ownerId: string;
}

export interface FishDefeatedEvent {
  fishId: number;
  key: string;
  x: number;
  y: number;
  /** Reward credited; only meaningful (and only sent) to the killing player. */
  reward: number;
  ownerId: string;
  mine: boolean;
  balance?: number;
  special?: string | null;
}

export interface PlayLimitsView {
  /** Minutes allowed per UTC day; 0 = no limit set. */
  limitMin: number;
  minutesPlayedToday: number;
  /** `Infinity` serialises to null over JSON — clients treat null as unlimited. */
  minutesRemaining: number | null;
}

export type ServerMessage =
  | { type: 'welcome'; userId: string; username: string; serverTime: number; flags: { realMoneyEnabled: boolean; maintenance: boolean } }
  | { type: 'authError'; message: string }
  | { type: 'rooms'; rooms: RoomSummary[] }
  | {
      type: 'joined';
      roomId: string;
      roundId: string;
      configVersion: string;
      seat: { x: number; y: number };
      snapshot: RoomSnapshot;
      balance: number;
      cannonKey: string;
      betOptions: { key: string; name: string; level: number; power: number; shotCost: number; fireRate: number; legal: boolean }[];
      /** Player-protection budget so the HUD can show it without another round-trip. */
      limits?: PlayLimitsView;
    }
  | { type: 'left' }
  | { type: 'snapshot'; snapshot: RoomSnapshot }
  | { type: 'delta'; delta: RoomDelta }
  | { type: 'shot'; ack: FireAck }
  | { type: 'shotBroadcast'; projectile: ProjectileInstance }
  | { type: 'hit'; event: FishHitEvent }
  | { type: 'defeat'; event: FishDefeatedEvent }
  | { type: 'playerJoined'; player: PlayerInstance }
  | { type: 'playerLeft'; playerId: string }
  | { type: 'playerMoved'; playerId: string; angle: number; cannonKey: string }
  | { type: 'round'; roundId: string; configVersion: string }
  | { type: 'wave'; size: number }
  | { type: 'explosion'; x: number; y: number; r: number }
  | { type: 'bossDefeated'; x: number; y: number; ownerId: string }
  | { type: 'balance'; balance: number }
  | { type: 'time'; st: number }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  /**
   * Player-protection verdict. Sent when a limit stops play (join refused,
   * shots no longer accepted, self-exclusion hit mid-round) so the client can
   * explain *why* instead of showing a generic failure.
   */
  | {
      type: 'limit';
      kind: 'SESSION_LIMIT' | 'SELF_EXCLUDED' | 'ACCOUNT_BLOCKED';
      message: string;
      /** Minutes the player allowed themselves per day; 0 when unlimited. */
      limitMin: number;
      minutesPlayedToday: number;
      /** ISO timestamp for SELF_EXCLUDED, null otherwise. */
      until: string | null;
    }
  | { type: 'pong'; t: number };

export const WS_GAME_PATH = '/ws/game';
export const CLIENT_PING_INTERVAL_MS = 5000;
export const FULL_SNAPSHOT_INTERVAL_MS = 5000;
export const TIME_SYNC_INTERVAL_MS = 3000;
