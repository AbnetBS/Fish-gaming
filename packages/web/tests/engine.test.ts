import { describe, expect, it } from 'vitest';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  circlesOverlap,
  clamp,
  computeFishPose,
  createFishMotion,
  createRng,
  isOutOfBounds,
  lerpAngle,
  normalizeAngle,
} from '@reef/shared';
import type { MovementPattern } from '@reef/shared';
import { ParticleSystem } from '../src/game/Particles';
import { formatCoins, formatSigned, timeAgo } from '../src/components/ui';

/**
 * Client-side engine tests.
 *
 * The important property under test is that the client's view of the world is
 * *derived*, not received: the renderer replays the same motion function the
 * server runs, so if this maths drifts from the server's, players would see fish
 * in places the authoritative simulation never put them.
 */

const PATTERNS: MovementPattern[] = ['STRAIGHT', 'DIAGONAL', 'SINE', 'CIRCULAR', 'CURVED', 'WANDER', 'BOSS'];

describe('deterministic fish motion', () => {
  it('produces identical poses for identical parameters', () => {
    const rngA = createRng(4242);
    const rngB = createRng(4242);
    for (const pattern of PATTERNS) {
      const a = createFishMotion({ pattern, rng: rngA, radius: 30 });
      const b = createFishMotion({ pattern, rng: rngB, radius: 30 });
      expect(a).toEqual(b);
      for (const age of [0, 0.4, 2.5, 11]) {
        expect(computeFishPose(a, age, 150)).toEqual(computeFishPose(b, age, 150));
      }
    }
  });

  it('moves continuously — no teleporting between frames', () => {
    for (const pattern of PATTERNS) {
      const rng = createRng(pattern.length * 977 + 13);
      const params = createFishMotion({ pattern, rng, radius: 34 });
      const speed = 260;
      let previous = computeFishPose(params, 0, speed);
      for (let i = 1; i <= 200; i += 1) {
        const pose = computeFishPose(params, i * 0.05, speed);
        const dx = pose.x - previous.x;
        const dy = pose.y - previous.y;
        const distance = Math.hypot(dx, dy);
        // 50 ms at 260 u/s is 13 units; allow generous headroom for curved
        // paths but never a jump.
        expect(distance).toBeLessThan(60);
        previous = pose;
      }
    }
  });

  it('enters from off-screen and leaves off-screen', () => {
    const rng = createRng(7);
    for (let i = 0; i < 40; i += 1) {
      const params = createFishMotion({ pattern: 'STRAIGHT', rng, radius: 25 });
      // Spawn points sit outside the visible field so a fish swims in rather
      // than popping into existence (the despawn margin is deliberately wider).
      const outsideVisibleArea = params.x0 < 0 || params.x0 > GAME_WIDTH || params.y0 < 0 || params.y0 > GAME_HEIGHT;
      expect(outsideVisibleArea).toBe(true);
      let entered = false;
      for (let age = 0; age < 30; age += 0.1) {
        const pose = computeFishPose(params, age, 200);
        if (pose.x > 0 && pose.x < GAME_WIDTH && pose.y > 0 && pose.y < GAME_HEIGHT) {
          entered = true;
          break;
        }
      }
      expect(entered).toBe(true);
    }
  });

  it('scales with the global speed multiplier and the species speed', () => {
    const params = { ...createFishMotion({ pattern: 'STRAIGHT', rng: createRng(3), radius: 20 }), a: 0, x0: 0, y0: 0 };
    const slow = computeFishPose(params, 1, 100, 1);
    const fast = computeFishPose(params, 1, 200, 1);
    const boosted = computeFishPose(params, 1, 100, 2);
    expect(fast.x).toBeGreaterThan(slow.x);
    expect(Math.round(boosted.x)).toBe(Math.round(fast.x));
  });
});

describe('angle and overlap helpers', () => {
  it('normalises and lerps angles along the short way round', () => {
    // +/-PI describe the same heading; what matters is the range, not the sign.
    expect(Math.abs(normalizeAngle(Math.PI * 3))).toBeCloseTo(Math.PI, 6);
    expect(normalizeAngle(-Math.PI * 3)).toBeLessThanOrEqual(Math.PI);
    expect(normalizeAngle(0.5)).toBeCloseTo(0.5);
    // Crossing the +/-PI seam must travel the short way round, i.e. through
    // +/-PI rather than back through zero.
    const mid = lerpAngle(-Math.PI + 0.1, Math.PI - 0.1, 0.5);
    expect(Math.abs(mid)).toBeGreaterThan(Math.PI - 0.2);
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4);
  });

  it('clamps values into range', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
    expect(Number.isNaN(clamp(NaN, 0, 10))).toBe(true);
  });

  it('detects circle overlap symmetrically', () => {
    expect(circlesOverlap(0, 0, 10, 15, 0, 6)).toBe(true);
    expect(circlesOverlap(0, 0, 10, 30, 0, 6)).toBe(false);
    expect(circlesOverlap(30, 0, 6, 0, 0, 10)).toBe(false);
  });
});

describe('particle system bounds', () => {
  it('never exceeds its capacity and recycles the oldest particles', () => {
    const ps = new ParticleSystem(50);
    for (let i = 0; i < 500; i += 1) ps.bubbles(i, i, 4, 10);
    expect(ps.activeCount).toBeLessThanOrEqual(50);
  });

  it('ages particles out so memory and draw cost stay flat', () => {
    const ps = new ParticleSystem(200);
    ps.defeatBurst(100, 100, 40, 200, true);
    const initial = ps.activeCount;
    expect(initial).toBeGreaterThan(0);
    for (let i = 0; i < 400; i += 1) ps.step(0.05, { w: GAME_WIDTH, h: GAME_HEIGHT });
    expect(ps.activeCount).toBe(0);
  });

  it('keeps every burst bounded regardless of input size', () => {
    const ps = new ParticleSystem(120);
    ps.explosion(0, 0, 100_000);
    ps.hitSparks(0, 0, Number.MAX_SAFE_INTEGER, 200);
    ps.defeatBurst(0, 0, Number.MAX_SAFE_INTEGER, 200, true);
    expect(ps.activeCount).toBeLessThanOrEqual(120);
  });
});

describe('presentation helpers', () => {
  it('formats demo coin amounts with thousands separators and a sign', () => {
    expect(formatCoins(10_000)).toBe('10,000');
    expect(formatCoins(0)).toBe('0');
    expect(formatSigned(12)).toBe('+12');
    expect(formatSigned(-12)).toBe('-12');
    expect(formatSigned(0)).toBe('0');
  });

  it('renders relative times without throwing on empty input', () => {
    expect(timeAgo(null)).toBe('never');
    expect(timeAgo('not-a-date')).toBe('—');
    expect(timeAgo(new Date().toISOString())).toBe('just now');
    expect(timeAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
  });
});
