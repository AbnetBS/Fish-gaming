import type { MovementPattern } from './constants.js';
import { GAME_HEIGHT, GAME_WIDTH } from './constants.js';

/**
 * Deterministic fish motion.
 *
 * A fish's pose is a *pure function* of (movement params, age, speed). The
 * server uses it as the authoritative simulation; the client uses the exact
 * same function to render. That means the network only has to carry
 * "fish #42 spawned with these params" once, instead of a position every
 * frame — which keeps bandwidth tiny and makes client visuals match the
 * authoritative server state exactly.
 */

export interface FishMotionParams {
  p: MovementPattern;
  /** Entry point in logical coordinates. */
  x0: number;
  y0: number;
  /** Base heading in radians (0 = +X). */
  a: number;
  /** Lateral amplitude (sine / wander). */
  amp: number;
  /** Lateral frequency in radians per second. */
  freq: number;
  /** Turn radius (circular). */
  radius: number;
  /** Turn rate in radians per second (circular / boss). */
  spin: number;
  /** Wander noise seeds. */
  w1: number;
  w2: number;
}

export interface Pose {
  x: number;
  y: number;
  a: number;
}

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-path angular interpolation. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

export function angleLerp(a: number, b: number, t: number): number {
  return lerpAngle(a, b, t);
}

export function normalizeAngle(a: number): number {
  let x = a % TAU;
  if (x > Math.PI) x -= TAU;
  if (x < -Math.PI) x += TAU;
  return x;
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** Squared-distance circle/circle overlap test (hot path: no sqrt). */
export function circlesOverlap(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
): boolean {
  const r = ar + br;
  return dist2(ax, ay, bx, by) <= r * r;
}

/**
 * Compute the pose of a fish `age` seconds after spawn.
 * `speed` is the species base speed; `gameSpeed` is the global multiplier.
 */
export function computeFishPose(params: FishMotionParams, age: number, speed: number, gameSpeed = 1): Pose {
  const s = speed * gameSpeed;
  const t = age;
  const a = params.a;
  const dirX = Math.cos(a);
  const dirY = Math.sin(a);
  // Unit perpendicular vector.
  const perpX = -dirY;
  const perpY = dirX;

  switch (params.p) {
    case 'STRAIGHT':
    case 'DIAGONAL': {
      return { x: params.x0 + dirX * s * t, y: params.y0 + dirY * s * t, a };
    }

    case 'SINE': {
      const off = params.amp * Math.sin(params.freq * t);
      return {
        x: params.x0 + dirX * s * t + perpX * off,
        y: params.y0 + dirY * s * t + perpY * off,
        a: Math.atan2(dirY * s + perpY * params.amp * params.freq * Math.cos(params.freq * t), dirX * s + perpX * params.amp * params.freq * Math.cos(params.freq * t)),
      };
    }

    case 'CIRCULAR': {
      const r = Math.max(24, params.radius);
      // Centre of the orbit sits `r` to the left of the spawn heading.
      const cx = params.x0 + perpX * r;
      const cy = params.y0 + perpY * r;
      const theta = params.spin * t;
      // Angle of the spawn point relative to the centre, then rotate.
      const base = Math.atan2(params.y0 - cy, params.x0 - cx);
      const ang = base + theta;
      return {
        x: cx + Math.cos(ang) * r,
        y: cy + Math.sin(ang) * r,
        a: ang + (theta >= 0 ? Math.PI / 2 : -Math.PI / 2),
      };
    }

    case 'CURVED': {
      // Gentle accelerating arc: lateral offset grows with t^2, capped.
      const raw = params.amp * Math.min(1, (t * params.freq) ** 2);
      const off = params.amp * (1 - Math.exp(-raw / params.amp)) * Math.sign(params.amp || 1);
      const slope = params.amp * params.freq * 2 * t * Math.exp(-((t * params.freq) ** 2)) * params.freq;
      return {
        x: params.x0 + dirX * s * t + perpX * off,
        y: params.y0 + dirY * s * t + perpY * off,
        a: Math.atan2(dirY + perpY * slope, dirX + perpX * slope),
      };
    }

    case 'WANDER': {
      // Smooth pseudo-noise from two incommensurate sines -> organic drift.
      const off =
        params.amp * (Math.sin(params.freq * t + params.w1) * 0.6 + Math.sin(params.freq * 0.37 * t + params.w2) * 0.4);
      const dOff =
        params.amp *
        (Math.cos(params.freq * t + params.w1) * 0.6 * params.freq +
          Math.cos(params.freq * 0.37 * t + params.w2) * 0.4 * params.freq * 0.37);
      return {
        x: params.x0 + dirX * s * t + perpX * off,
        y: params.y0 + dirY * s * t + perpY * off,
        a: Math.atan2(dirY * s + perpY * dOff, dirX * s + perpX * dOff),
      };
    }

    case 'BOSS': {
      // Slow forward crawl + wide, slow sweeping arc.
      const sweep = params.amp * Math.sin(params.spin * t);
      return {
        x: params.x0 + dirX * s * t + perpX * sweep,
        y: params.y0 + dirY * s * t + perpY * sweep,
        a: Math.atan2(
          dirY * s + perpY * params.amp * params.spin * Math.cos(params.spin * t),
          dirX * s + perpX * params.amp * params.spin * Math.cos(params.spin * t),
        ),
      };
    }

    default:
      return { x: params.x0 + dirX * s * t, y: params.y0 + dirY * s * t, a };
  }
}

/**
 * Deterministic PRNG (mulberry32). Both sides need reproducible randomness
 * for spawn parameters, so a seed is shipped with the round instead of using
 * `Math.random()` on the client.
 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SpawnOptions {
  pattern: MovementPattern;
  rng: () => number;
  width?: number;
  height?: number;
  /** Species radius, used to keep spawn points off-screen. */
  radius: number;
  /** Prefer a specific entry edge ('left' | 'right' | 'top' | 'bottom'). */
  edge?: 'left' | 'right' | 'top' | 'bottom';
}

/**
 * Build motion parameters for a fish entering the play field. Fish always
 * enter from outside the visible area so they "swim in" naturally instead of
 * popping into existence.
 */
export function createFishMotion(opts: SpawnOptions): FishMotionParams {
  const { pattern, rng } = opts;
  const W = opts.width ?? GAME_WIDTH;
  const H = opts.height ?? GAME_HEIGHT;
  const margin = Math.max(80, opts.radius + 40);

  const edges: Array<'left' | 'right' | 'top' | 'bottom'> = opts.edge
    ? [opts.edge]
    : ['left', 'right', 'left', 'right', 'top', 'bottom'];
  const edge = edges[Math.floor(rng() * edges.length)] ?? 'left';

  let x0 = 0;
  let y0 = 0;
  let a = 0;

  switch (edge) {
    case 'left':
      x0 = -margin;
      y0 = 80 + rng() * (H - 320);
      a = -0.35 + rng() * 0.7;
      break;
    case 'right':
      x0 = W + margin;
      y0 = 80 + rng() * (H - 320);
      a = Math.PI + (-0.35 + rng() * 0.7);
      break;
    case 'top':
      x0 = 120 + rng() * (W - 240);
      y0 = -margin;
      a = Math.PI / 2 + (-0.4 + rng() * 0.8);
      break;
    case 'bottom':
    default:
      x0 = 120 + rng() * (W - 240);
      y0 = H + margin;
      a = -Math.PI / 2 + (-0.4 + rng() * 0.8);
      break;
  }

  const base: FishMotionParams = {
    p: pattern,
    x0,
    y0,
    a,
    amp: 0,
    freq: 0,
    radius: 0,
    spin: 0,
    w1: rng() * TAU,
    w2: rng() * TAU,
  };

  switch (pattern) {
    case 'SINE':
      base.amp = 30 + rng() * 70;
      base.freq = 1.2 + rng() * 1.6;
      break;
    case 'WANDER':
      base.amp = 45 + rng() * 90;
      base.freq = 0.7 + rng() * 0.9;
      break;
    case 'CIRCULAR':
      base.radius = 120 + rng() * 160;
      base.spin = (rng() < 0.5 ? -1 : 1) * (0.25 + rng() * 0.45);
      break;
    case 'CURVED':
      base.amp = (rng() < 0.5 ? -1 : 1) * (90 + rng() * 140);
      base.freq = 0.0022 + rng() * 0.0022;
      break;
    case 'BOSS':
      base.amp = 160 + rng() * 120;
      base.spin = 0.16 + rng() * 0.14;
      // Bosses always cross the field horizontally for a readable silhouette.
      base.x0 = rng() < 0.5 ? -margin : W + margin;
      base.y0 = 160 + rng() * (H - 420);
      base.a = base.x0 < 0 ? 0 : Math.PI;
      break;
    default:
      break;
  }

  return base;
}

/** A fish is considered off-field (and can be recycled) once it is far out. */
export function isOutOfBounds(x: number, y: number, radius: number, width = GAME_WIDTH, height = GAME_HEIGHT): boolean {
  const m = radius + 220;
  return x < -m || x > width + m || y < -m || y > height + m;
}

/**
 * Projectile travel is deliberately simple linear motion so that client
 * prediction and server authority agree exactly.
 */
export function projectilePosition(originX: number, originY: number, angle: number, speed: number, age: number) {
  return {
    x: originX + Math.cos(angle) * speed * age,
    y: originY + Math.sin(angle) * speed * age,
  };
}
