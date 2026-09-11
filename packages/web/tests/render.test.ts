import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { BASELINE_CANNONS, BASELINE_FISH, GAME_HEIGHT, GAME_WIDTH } from '@reef/shared';

/**
 * Headless render smoke test.
 *
 * There is no browser in the test environment, so a recording fake canvas stands
 * in for the real 2D context. The point is not pixel accuracy — it is proving
 * that the drawing and state-application code paths run to completion without
 * throwing when fed a realistic stream of authoritative messages, that sprites
 * get baked and blitted, and that the aspect-fit maths is correct at every
 * viewport shape the product supports.
 */

interface FakeCanvas {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  style: Record<string, string>;
  getContext: () => unknown;
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
  addEventListener: () => void;
  removeEventListener: () => void;
  setPointerCapture: () => void;
  releasePointerCapture: () => void;
  __calls: Map<string, number>;
}

function makeGradient(): { addColorStop: () => void } {
  return { addColorStop: () => undefined };
}

function makeCanvas(width = 1280, height = 720): FakeCanvas {
  const calls = new Map<string, number>();
  const state: Record<string, unknown> = {};
  const record = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1);

  const target: Record<string, unknown> = {
    canvas: null,
    save: () => record('save'),
    restore: () => record('restore'),
    beginPath: () => record('beginPath'),
    closePath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    arc: () => record('arc'),
    arcTo: () => undefined,
    ellipse: () => record('ellipse'),
    bezierCurveTo: () => undefined,
    quadraticCurveTo: () => undefined,
    rect: () => undefined,
    roundRect: () => record('roundRect'),
    fill: () => record('fill'),
    stroke: () => record('stroke'),
    clip: () => undefined,
    fillRect: () => record('fillRect'),
    strokeRect: () => undefined,
    clearRect: () => undefined,
    translate: () => undefined,
    rotate: () => undefined,
    scale: () => undefined,
    transform: () => undefined,
    setTransform: () => undefined,
    resetTransform: () => undefined,
    fillText: () => record('fillText'),
    strokeText: () => undefined,
    measureText: () => ({ width: 12 }),
    createLinearGradient: makeGradient,
    createRadialGradient: makeGradient,
    createPattern: makeGradient,
    drawImage: () => record('drawImage'),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: () => undefined,
    createImageData: () => ({ data: new Uint8ClampedArray(4) }),
    setLineDash: () => undefined,
    getLineDash: () => [],
    filter: 'none',
  };
  target.canvas = { width, height };

  const ctx = new Proxy(target, {
    get(obj, prop: string) {
      if (prop in obj) return obj[prop];
      if (prop in state) return state[prop];
      return () => undefined;
    },
    set(obj, prop: string, value) {
      obj[prop] = value;
      state[prop] = value;
      return true;
    },
  });

  return {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    __calls: calls,
  };
}

const created: FakeCanvas[] = [];

beforeAll(() => {
  const doc = {
    createElement: (tag: string) => {
      const canvas = makeCanvas(tag === 'canvas' ? 256 : 256, 256);
      created.push(canvas);
      return canvas as unknown as HTMLCanvasElement;
    },
  };
  const win = {
    devicePixelRatio: 2,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (fn: () => void) => setTimeout(fn, 0),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: unknown) => clearInterval(id as ReturnType<typeof setInterval>),
    AudioContext: undefined,
  };
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: (fn: (t: number) => void) => setTimeout(() => fn(performance.now()), 0),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    value: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
    configurable: true,
    writable: true,
  });
});

afterAll(() => {
  vi.useRealTimers();
});

describe('sprite baking', () => {
  it('bakes every species into a strip without throwing', async () => {
    const { bakeFishSprite, SPRITE_FRAMES } = await import('../src/game/Sprites');
    for (const fish of BASELINE_FISH) {
      const sprite = bakeFishSprite(fish);
      expect(sprite.canvas.width, fish.key).toBe(sprite.frameWidth * SPRITE_FRAMES);
      expect(sprite.frameHeight).toBeGreaterThan(sprite.frameWidth * 0.4);
    }
  });

  it('caches one bake per species', async () => {
    const { createSpriteCache } = await import('../src/game/Sprites');
    const cache = createSpriteCache();
    const first = cache.get(BASELINE_FISH[0]);
    expect(cache.get(BASELINE_FISH[0])).toBe(first);
  });
});

describe('renderer viewport fit', () => {
  it('letterboxes rather than stretches, for phone, tablet and desktop shapes', async () => {
    const { Renderer } = await import('../src/game/Renderer');
    const { createSpriteCache } = await import('../src/game/Sprites');
    const renderer = new Renderer(makeCanvas() as unknown as HTMLCanvasElement, createSpriteCache());

    const desktop = renderer.resize(2560, 1440);
    expect(desktop.scale).toBeCloseTo(2560 / GAME_WIDTH, 5);
    expect(desktop.offsetX).toBeCloseTo(0, 5);

    const phoneLandscape = renderer.resize(844, 390);
    expect(phoneLandscape.scale).toBeCloseTo(390 / GAME_HEIGHT, 5);
    expect(phoneLandscape.offsetX).toBeGreaterThan(0); // horizontal letterbox
    expect(phoneLandscape.offsetY).toBeCloseTo(0, 5);

    const narrowPortrait = renderer.resize(390, 844);
    expect(narrowPortrait.scale).toBeCloseTo(390 / GAME_WIDTH, 5);
    expect(narrowPortrait.offsetY).toBeGreaterThan(0);

    const dprCapped = renderer.resize(1000, 562, 1.5);
    expect(dprCapped.dpr).toBeLessThanOrEqual(1.5);
  });

  it('draws a full frame: background, kelp, fish, projectiles, particles, foreground, post', async () => {
    const { Renderer } = await import('../src/game/Renderer');
    const { createSpriteCache, drawCannon, drawProjectile, paletteFor } = await import('../src/game/Sprites');
    const { ParticleSystem } = await import('../src/game/Particles');

    const sprites = createSpriteCache();
    const canvas = makeCanvas();
    const renderer = new Renderer(canvas as unknown as HTMLCanvasElement, sprites);
    const rc = renderer.resize(1280, 720);

    renderer.begin(rc, 0.016);
    renderer.drawBackground(rc, 12);
    renderer.drawKelp(rc);

    const particles = new ParticleSystem(200);
    for (const fish of BASELINE_FISH) {
      renderer.drawFish(rc, {
        x: 400,
        y: 300,
        angle: 0.2,
        key: fish.key,
        species: fish,
        hp: fish.health - 1,
        mhp: fish.health,
        flash: 0.4,
        appear: 1,
        phase: 3,
        radius: fish.size,
      });
      particles.defeatBurst(300, 300, fish.size, 200, fish.special === 'golden');
    }
    drawProjectile(rc.ctx, { x: 100, y: 200, angle: -1, level: 3, mine: true });
    drawCannon(rc.ctx, {
      x: 960,
      y: 984,
      angle: -1.2,
      level: 4,
      recoil: 0.5,
      color: paletteFor(BASELINE_FISH[0]).body1,
      accent: '#fff',
      local: true,
      aimAssist: 1200,
    });
    particles.step(0.016, { w: GAME_WIDTH, h: GAME_HEIGHT });
    particles.draw(rc.ctx, 1);
    renderer.drawBossBar(rc, { hp: 60, mhp: 120, species: BASELINE_FISH.find((f) => f.category === 'BOSS') }, 'Leviathan');
    renderer.drawForeground(rc, 4);
    renderer.drawPost(rc);
    renderer.end(rc);

    // The frame must actually have issued draw work of every kind.
    for (const op of ['save', 'restore', 'drawImage', 'fill', 'stroke', 'fillText', 'arc']) {
      expect(canvas.__calls.get(op) ?? 0, op).toBeGreaterThan(0);
    }
    expect(canvas.__calls.get('save')).toBe(canvas.__calls.get('restore'));
  });
});

describe('engine message handling', () => {
  it('applies snapshots, deltas, hits and defeats, and clamps aim like the server', async () => {
    const { Engine } = await import('../src/game/Engine');
    const canvas = makeCanvas();
    const notices: string[] = [];
    const balances: number[] = [];
    const rewards: number[] = [];
    const sounds: string[] = [];
    const engine = new Engine(canvas as unknown as HTMLCanvasElement, {
      onNotice: (_level, message) => notices.push(message),
      onBalance: (balance) => balances.push(balance),
      onReward: (reward) => rewards.push(reward.amount),
      onSound: (name) => sounds.push(name),
      requestFire: () => undefined,
      sendAim: () => undefined,
    });
    engine.setSpecies(BASELINE_FISH);

    const now = Date.now();
    const fish = (id: number, key: string, hp: number, mhp: number) => ({
      id,
      key,
      t0: now - 500,
      hp,
      mhp,
      s: 120,
      f: 0,
      p: { p: 'STRAIGHT' as const, x0: 400 + id * 12, y0: 300, a: 0, amp: 0, freq: 0, radius: 0, spin: 0, w1: 0, w2: 0 },
    });

    engine.handle({
      type: 'joined',
      roomId: 'r1',
      roundId: 'RND-2026-000001',
      configVersion: '1.0.0',
      seat: { x: 960, y: 984 },
      balance: 9_990,
      cannonKey: 'reef_breaker',
      betOptions: [{ key: 'reef_breaker', name: 'Reef Breaker', level: 3, power: 5, shotCost: 5, fireRate: 2.6, legal: true }],
      snapshot: {
        t: 1,
        st: now,
        roundId: 'RND-2026-000001',
        configVersion: '1.0.0',
        fish: [fish(1, 'tide_grouper', 10, 10), fish(2, 'blue_darter', 1, 1)],
        projectiles: [],
        players: [{ id: 'local', username: 'me', avatarSeed: 'me', cannonKey: 'reef_breaker', cannonLevel: 3, angle: -1.5, x: 960, y: 984 }],
      },
    } as never);

    const state = engine as unknown as { fish: Map<number, { hp: number; fadeOut: boolean }>; projectiles: Map<number, unknown>; players: Map<string, unknown> };
    expect(state.fish.size).toBe(2);
    expect(engine.cannonLevel).toBe(3);
    expect(balances).toEqual([9_990]);

    engine.handle({
      type: 'delta',
      delta: { t: 2, st: Date.now(), add: [fish(3, 'golden_koi', 5, 5)], rm: [2], hp: [{ id: 1, hp: 5, f: 1 }] },
    } as never);
    expect(state.fish.size).toBe(3);
    expect(state.fish.get(1)!.hp).toBe(5);
    expect(state.fish.get(2)!.fadeOut).toBe(true);

    engine.handle({ type: 'hit', event: { fishId: 1, projectileId: 9, hp: 5, mhp: 10, x: 412, y: 300, damage: 5, ownerId: 'local', mine: true } } as never);
    engine.handle({ type: 'defeat', event: { fishId: 3, key: 'golden_koi', x: 424, y: 300, reward: 50, ownerId: 'local', mine: true, balance: 10_040, special: 'golden' } } as never);
    expect(rewards).toEqual([50]);
    expect(balances.at(-1)).toBe(10_040);
    expect(sounds).toContain('kill');

    engine.handle({ type: 'shotBroadcast', projectile: { id: 77, owner: 'other', x: 100, y: 900, a: -1, lvl: 2, t0: Date.now(), ttl: 2.4, v: 1700 } } as never);
    expect(state.projectiles.size).toBe(1);

    engine.handle({ type: 'playerJoined', player: { id: 'other', username: 'other', avatarSeed: 'o', cannonKey: 'tidecaster', cannonLevel: 1, angle: -1, x: 300, y: 984 } } as never);
    expect(state.players.size).toBe(2);
    engine.handle({ type: 'playerLeft', playerId: 'other' } as never);
    expect(state.players.size).toBe(1);

    engine.handle({ type: 'notice', level: 'warn', message: 'Room is full. Try another room.' } as never);
    expect(notices.some((n) => /full/i.test(n))).toBe(true);
    engine.handle({ type: 'explosion', x: 500, y: 400, r: 268 } as never);
    engine.handle({ type: 'bossDefeated', x: 500, y: 400, ownerId: 'local' } as never);
    engine.handle({ type: 'wave', size: 7 } as never);
    expect(engine.stats.kills).toBe(1);
    expect(engine.stats.wagered + engine.stats.rewarded).toBeGreaterThan(0);

    // A new round clears the local tally: the fresh reef starts from zero.
    engine.handle({ type: 'round', roundId: 'RND-2026-000002', configVersion: '1.0.1' } as never);
    expect(state.fish.size).toBe(0);
    expect(engine.stats.kills).toBe(0);
    engine.handle({ type: 'mystery-message' } as never);

    // A rejected shot must surface the server's reason, never a silent failure.
    engine.handle({
      type: 'shot',
      ack: { ok: false, clientRef: 'x', code: 'INSUFFICIENT_FUNDS', message: 'Not enough demo coins.', cost: 0, damage: 0, angle: 0, speed: 0, originX: 0, originY: 0, balance: 4 },
    } as never);
    expect(notices.some((n) => /demo coins/i.test(n))).toBe(true);

    for (const angle of [0, Math.PI / 2, Math.PI * 4, -0.4]) {
      engine.setAim(angle);
      expect(engine.aimAngle).toBeLessThanOrEqual(0);
      expect(engine.aimAngle).toBeGreaterThanOrEqual(-Math.PI - 0.12);
    }

    engine.resize(900, 500);
    expect(() => {
      for (let i = 0; i < 3; i += 1) (engine as unknown as { tick: (dt: number, now: number) => void }).tick(0.016, performance.now() + i);
    }).not.toThrow();
    expect(canvas.__calls.get('drawImage') ?? 0).toBeGreaterThan(0);
    engine.destroy();
  });

  it('practice mode runs entirely locally and never touches the wallet', async () => {
    const { Engine } = await import('../src/game/Engine');
    const engine = new Engine(makeCanvas() as unknown as HTMLCanvasElement, { onSound: () => undefined, requestFire: () => undefined });
    engine.setSpecies(BASELINE_FISH);
    const balances: number[] = [];
    (engine as unknown as { callbacks: { onBalance: (b: number) => void } }).callbacks.onBalance = (b) => balances.push(b);
    engine.enablePractice(true);
    expect(engine.practice).toBe(true);
    const anyEngine = engine as unknown as { fish: Map<number, unknown>; tick: (dt: number, now: number) => void };
    expect(anyEngine.fish.size).toBeGreaterThan(0);
    for (let i = 0; i < 30; i += 1) anyEngine.tick(0.05, performance.now() + i * 50);
    engine.tryFire();
    expect(engine.stats.shotsFired).toBe(1);
    // No server traffic in practice mode means no balance callbacks at all.
    expect(balances).toEqual([]);
    engine.destroy();
  });

  it('equipping a cannon sets fire cadence from the configuration', async () => {
    const { Engine } = await import('../src/game/Engine');
    const engine = new Engine(makeCanvas() as unknown as HTMLCanvasElement, { onSound: () => undefined });
    const mortar = BASELINE_CANNONS.find((c) => c.level === 5)!;
    engine.setLocalPlayer({ id: 'local', cannonKey: mortar.key, level: mortar.level, fireRate: mortar.fireRate });
    expect(Math.round(engine.fireIntervalMs)).toBe(Math.round(1000 / mortar.fireRate));
    expect(engine.cannonLevel).toBe(5);
    engine.destroy();
  });
});

describe('particle bounds', () => {
  it('never grows past its pool no matter how much is requested', async () => {
    const { ParticleSystem } = await import('../src/game/Particles');
    const ps = new ParticleSystem(120);
    for (let i = 0; i < 500; i += 1) ps.bubbles(10, 10, 9, 30);
    expect(ps.activeCount).toBeLessThanOrEqual(120);
    ps.explosion(0, 0, Number.MAX_SAFE_INTEGER);
    ps.hitSparks(0, 0, Number.MAX_SAFE_INTEGER, 45);
    ps.defeatBurst(0, 0, Number.MAX_SAFE_INTEGER, 45, true);
    expect(ps.activeCount).toBeLessThanOrEqual(120);
    for (let i = 0; i < 200; i += 1) ps.step(0.05, { w: GAME_WIDTH, h: GAME_HEIGHT });
    expect(ps.activeCount).toBe(0);
  });
});
