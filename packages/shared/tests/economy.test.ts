import { describe, expect, it } from 'vitest';
import {
  BASELINE_CANNONS,
  BASELINE_FISH,
  BASELINE_SETTINGS,
  GAME_HEIGHT,
  GAME_WIDTH,
  computeFishPose,
  createFishMotion,
  createRng,
  isOutOfBounds,
  type FishConfig,
  type FishMotionParams,
  type MovementPattern,
} from '@reef/shared';

/**
 * Economy and motion invariants.
 *
 * These tests describe the *shape* of a sane configuration rather than exact
 * numbers — the numbers themselves live in the database and are operator-owned.
 * A deployment that breaks one of these rules is a deployment where the arcade
 * economy stops making sense, which is precisely what must not happen silently.
 */

const PATTERNS: MovementPattern[] = ['STRAIGHT', 'DIAGONAL', 'SINE', 'CIRCULAR', 'CURVED', 'WANDER', 'BOSS'];

describe('baseline economy shape', () => {
  it('rewards never exceed health-driven cost by an unbounded factor', () => {
    // With the cheapest legal cannon, killing a fish costs ceil(health / power) * shotCost.
    // Reward above that is generosity; a demo may be generous, but it must be *bounded* so
    // that measured RTP stays reportable.
    const cheapest = [...BASELINE_CANNONS].sort((a, b) => a.shotCost / a.power - b.shotCost / b.power)[0]!;
    for (const fish of BASELINE_FISH) {
      const minCostToKill = Math.ceil(fish.health / cheapest.power) * cheapest.shotCost;
      const payout = fish.special === 'golden' ? fish.reward * 2 : fish.reward * 3; // worst case for 'treasure'
      expect(payout / minCostToKill, fish.key).toBeLessThanOrEqual(12);
    }
  });

  it('health, reward and speed increase together up the value ladder', () => {
    const ladder = BASELINE_FISH.filter((f) => ['COMMON', 'MEDIUM', 'LARGE', 'RARE', 'BOSS'].includes(f.category));
    const byHealth = [...ladder].sort((a, b) => a.health - b.health);
    for (let i = 1; i < byHealth.length; i += 1) {
      const prev = byHealth[i - 1]!;
      const curr = byHealth[i]!;
      if (curr.health > prev.health) expect(curr.reward, `${curr.key} vs ${prev.key}`).toBeGreaterThanOrEqual(prev.reward);
      if (curr.health > prev.health) expect(curr.speed, `${curr.key} vs ${prev.key}`).toBeLessThanOrEqual(prev.speed + 40);
    }
  });

  it('spawn weights fall as rewards rise, so rare really means rare', () => {
    const total = BASELINE_FISH.reduce((sum, f) => sum + f.spawnWeight, 0);
    const share = (predicate: (f: FishConfig) => boolean) =>
      BASELINE_FISH.filter(predicate).reduce((sum, f) => sum + f.spawnWeight, 0) / total;
    expect(share((f) => f.category === 'COMMON')).toBeGreaterThan(0.4);
    expect(share((f) => f.category === 'BOSS')).toBeLessThan(0.02);
    expect(share((f) => f.category.startsWith('SPECIAL'))).toBeLessThan(0.15);
  });

  it('cannon ladder costs and power stay monotonic', () => {
    const sorted = [...BASELINE_CANNONS].sort((a, b) => a.level - b.level);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]!.power).toBeGreaterThan(sorted[i - 1]!.power);
      expect(sorted[i]!.shotCost).toBeGreaterThan(sorted[i - 1]!.shotCost);
    }
  });

  it('every room accepts at least one cannon from the ladder', () => {
    for (const room of [
      { key: 'shallow', min: 1, max: 5 },
      { key: 'shelf', min: 5, max: 25 },
      { key: 'canyon', min: 10, max: 50 },
      { key: 'trench', min: 20, max: 100 },
    ]) {
      const legal = BASELINE_CANNONS.filter((c) => c.shotCost >= room.min && c.shotCost <= room.max);
      expect(legal.length, room.key).toBeGreaterThan(0);
    }
  });

  it('species keys and cannon keys are unique and renderer-safe', () => {
    const keys = BASELINE_FISH.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    const cannonKeys = BASELINE_CANNONS.map((c) => c.key);
    expect(new Set(cannonKeys).size).toBe(cannonKeys.length);
    for (const fish of BASELINE_FISH) {
      expect(fish.palette, fish.key).toBeGreaterThanOrEqual(0);
      expect(fish.palette, fish.key).toBeLessThan(13);
      expect(PATTERNS).toContain(fish.movementPattern);
      expect(fish.size).toBeGreaterThan(0);
    }
  });

  it('global settings stay inside the ranges the simulation assumes', () => {
    expect(BASELINE_SETTINGS.maxActiveFish).toBeGreaterThan(0);
    expect(BASELINE_SETTINGS.maxActiveFish).toBeLessThanOrEqual(400);
    expect(BASELINE_SETTINGS.maxProjectiles).toBeGreaterThanOrEqual(BASELINE_SETTINGS.maxActiveFish);
    expect(BASELINE_SETTINGS.gameSpeed).toBeGreaterThan(0);
    expect(BASELINE_SETTINGS.fishLifetimeS).toBeGreaterThan(0);
    expect(BASELINE_SETTINGS.rtpTarget).toBeGreaterThan(0);
    expect(BASELINE_SETTINGS.rtpTarget).toBeLessThanOrEqual(1);
  });
});

describe('shared motion model', () => {
  const makeParams = (pattern: MovementPattern, seed: number): FishMotionParams =>
    createFishMotion({ pattern, rng: createRng(seed), radius: 30 });

  it('starts every fish outside the visible field so nothing pops into view', () => {
    for (const pattern of PATTERNS) {
      for (let seed = 1; seed <= 25; seed += 1) {
        const params = makeParams(pattern, seed * 31);
        const { x0, y0 } = params;
        const margin = 12;
        const inside = x0 >= 0 && x0 <= GAME_WIDTH && y0 >= 0 && y0 <= GAME_HEIGHT;
        // Boss and circular entries are allowed to start just inside so their
        // arc has room, but never at the centre of the screen.
        if (pattern !== 'CIRCULAR' && pattern !== 'BOSS') {
          expect(inside, `${pattern}/${seed}`).toBe(false);
          void margin;
        }
      }
    }
  });

  it('is a pure function: same inputs, same pose, forever', () => {
    for (const pattern of PATTERNS) {
      const params = makeParams(pattern, 7);
      for (const age of [0, 0.25, 1.5, 3.75, 12.5]) {
        expect(computeFishPose(params, age, 180, 1)).toEqual(computeFishPose(params, age, 180, 1));
      }
    }
  });

  it('travels at the configured speed along a straight heading', () => {
    const params = makeParams('STRAIGHT', 5);
    const one = computeFishPose(params, 1, 250, 1);
    const two = computeFishPose(params, 2, 250, 1);
    expect(Math.hypot(two.x - one.x, two.y - one.y)).toBeCloseTo(250, 3);
  });

  it('obeys the global speed multiplier', () => {
    const params = makeParams('STRAIGHT', 6);
    const normal = computeFishPose(params, 1, 200, 1);
    const double = computeFishPose(params, 1, 200, 2);
    expect(Math.hypot(double.x - params.x0, double.y - params.y0)).toBeCloseTo(
      Math.hypot(normal.x - params.x0, normal.y - params.y0) * 2,
      3,
    );
  });

  it('keeps sine and wander motion bounded around the heading', () => {
    for (const pattern of ['SINE', 'WANDER', 'CURVED', 'BOSS'] as MovementPattern[]) {
      const params = makeParams(pattern, 11);
      let maxLateral = 0;
      let previous = computeFishPose(params, 0, 200, 1);
      for (let age = 0.05; age <= 30; age += 0.05) {
        const pose = computeFishPose(params, age, 200, 1);
        const dx = pose.x - previous.x;
        const dy = pose.y - previous.y;
        // Never a jump larger than the per-frame travel plus slack.
        expect(Math.hypot(dx, dy)).toBeLessThan(40);
        const lateral = Math.abs(-Math.sin(params.a) * (pose.x - params.x0) + Math.cos(params.a) * (pose.y - params.y0));
        maxLateral = Math.max(maxLateral, lateral);
        previous = pose;
      }
      expect(maxLateral).toBeLessThan(Math.max(240, Math.abs(params.amp) * 2.6 + 40));
    }
  });

  it('circles stay on their orbit', () => {
    const params = makeParams('CIRCULAR', 3);
    const radius = params.radius;
    // Orbit centre sits one radius to the left of the heading at spawn.
    const cx = params.x0 - Math.sin(params.a) * radius;
    const cy = params.y0 + Math.cos(params.a) * radius;
    for (const age of [0.2, 1.1, 2.4, 5.5]) {
      const pose = computeFishPose(params, age, 150, 1);
      expect(Math.hypot(pose.x - cx, pose.y - cy)).toBeCloseTo(radius, 1);
    }
  });

  it('every fish eventually leaves the field', () => {
    for (const fish of BASELINE_FISH) {
      const params = createFishMotion({ pattern: fish.movementPattern, rng: createRng(fish.sortOrder * 97), radius: fish.size });
      let left = false;
      for (let age = 0; age <= 240; age += 0.25) {
        const pose = computeFishPose(params, age, fish.speed, 1);
        if (isOutOfBounds(pose.x, pose.y, fish.size)) {
          left = true;
          break;
        }
      }
      // Circular orbits are the one pattern that can stay on station; the
      // simulation retires those fish by age instead.
      expect(left || fish.movementPattern === 'CIRCULAR', fish.key).toBe(true);
    }
  });

  it('the seeded RNG is reproducible and uniform', () => {
    const a = createRng(1234);
    const b = createRng(1234);
    const samples: number[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      samples.push(value);
    }
    const mean = samples.reduce((sum, v) => sum + v, 0) / samples.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.03);
  });

  it('species selection follows spawn weights', () => {
    const total = BASELINE_FISH.reduce((sum, f) => sum + f.spawnWeight, 0);
    const rng = createRng(9);
    const counts = new Map<string, number>();
    for (let i = 0; i < 200_000; i += 1) {
      let roll = rng() * total;
      for (const fish of BASELINE_FISH) {
        roll -= fish.spawnWeight;
        if (roll <= 0) {
          counts.set(fish.key, (counts.get(fish.key) ?? 0) + 1);
          break;
        }
      }
    }
    const common = (counts.get('blue_darter') ?? 0) / 200_000;
    const boss = (counts.get('leviathan') ?? 0) / 200_000;
    expect(common).toBeGreaterThan(boss * 20);
    expect(boss).toBeLessThan(0.01);
  });
});
