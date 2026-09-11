import type { FishConfig, FishMotionParams } from '@reef/shared';

/** Client-side mirror of the authoritative room state. */

export interface WorldFish {
  id: number;
  key: string;
  species: FishConfig | undefined;
  params: FishMotionParams;
  speed: number;
  t0: number;
  hp: number;
  mhp: number;
  x: number;
  y: number;
  angle: number;
  /** 0..1 damage flash envelope, decayed by the engine. */
  flash: number;
  /** Seconds since this instance appeared locally (drives the fade-in). */
  appear: number;
  /** 0..1 fade-out progress once the fish is leaving. */
  dying: number;
  fadeOut: boolean;
  radius: number;
  dir: 1 | -1;
  /** Accumulator for tail/wake animation. */
  phase: number;
  boss: boolean;
}

export interface WorldProjectile {
  id: number;
  owner: string;
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  speed: number;
  level: number;
  t0: number;
  ttl: number;
  mine: boolean;
  radius: number;
  dead: boolean;
  trail: { x: number; y: number }[];
  hitFishId: number | null;
}

export interface WorldPlayer {
  id: string;
  username: string;
  avatarSeed: string;
  cannonKey: string;
  cannonLevel: number;
  x: number;
  y: number;
  angle: number;
  /** Smoothed aim used for rendering (the target is `angle`). */
  shownAngle: number;
  recoil: number;
  isLocal: boolean;
}

export interface FloatText {
  id: number;
  x: number;
  y: number;
  vy: number;
  life: number;
  ttl: number;
  text: string;
  kind: 'reward' | 'info' | 'cost' | 'combo' | 'boss';
  size: number;
}

export interface RewardPopup extends FloatText {}

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  species: Map<string, FishConfig>;
  dprCap?: number;
  onFps?: (fps: number, quality: number) => void;
}
