import type { FishConfig, GameConfiguration } from '@reef/shared';
import { GAME_HEIGHT, GAME_WIDTH, circlesOverlap, clamp, computeFishPose, createFishMotion, createRng, isOutOfBounds } from '@reef/shared';

/**
 * ---------------------------------------------------------------------------
 * AUTHORITATIVE ROOM SIMULATION
 * ---------------------------------------------------------------------------
 *
 * This module is the only place where game outcomes are decided. Clients send
 * *intents* (an aim angle and a cannon); this file decides whether a shot hit,
 * how much damage it did, and therefore what the player is owed. The wallet is
 * credited through the callback the caller supplies — the simulation itself has
 * no idea about money, which keeps it pure and unit-testable.
 *
 * Fairness properties, by construction:
 *  * Every player in a room shares one fish field; nobody gets a private deck.
 *  * All randomness comes from a per-round seed consumed in deterministic
 *    order. The same seed replayed produces the same spawn sequence.
 *  * Outcome never depends on identity, balance, previous wins or losses.
 *  * Hard caps (`maxActiveFish`, `maxProjectiles`) bound memory and CPU.
 */

export interface ActiveFish {
  id: number;
  key: string;
  species: FishConfig;
  params: ReturnType<typeof createFishMotion>;
  t0: number;
  hp: number;
  mhp: number;
  x: number;
  y: number;
  a: number;
  radius: number;
  flash: number;
  alive: boolean;
  /** Set when a bomb-chain is already being processed, to avoid recursion loops. */
  chain: boolean;
}

export interface ActiveProjectile {
  id: number;
  owner: string;
  x: number;
  y: number;
  a: number;
  vx: number;
  vy: number;
  speed: number;
  damage: number;
  radius: number;
  t0: number;
  ttl: number;
  cannonLevel: number;
  cannonKey: string;
  shotId: string;
  alive: boolean;
}

export interface SimPlayer {
  id: string;
  username: string;
  avatarSeed: string;
  cannonKey: string;
  angle: number;
  x: number;
  y: number;
  lastShotAt: number;
  wagered: number;
  rewarded: number;
  shots: number;
  kills: number;
}

export interface SimEvents {
  /** Credit the killing player. Return ok=false to veto the reward. */
  reward(args: { playerId: string; amount: number; shotId: string; fishKey: string; roundId: string }): { ok: boolean; balance?: number; message?: string };
  /** Report the resolved outcome of a shot so history can be finalised. */
  shotResolved(args: { shotId: string; playerId: string; result: 'MISSED' | 'HIT' | 'KILL'; reward: number; fishKey: string | null; fishName: string | null; roundId: string }): void;
  /** Append-only event log (batched by the caller). */
  logEvent(type: string, payload: Record<string, unknown>, playerId?: string | null): void;
}

const defaultWallClock = (): number => Date.now();

export const BOMB_SPLASH_RADIUS = 268;
export const BOMB_SPLASH_DAMAGE = 8;
export const TREASURE_MAX_MULTIPLIER = 3;
export const GOLDEN_MULTIPLIER = 2;
export const PROJECTILE_TTL_S = 2.4;
export const PROJECTILE_BASE_RADIUS = 11;

/**
 * Uniform spatial hash. Rebuilt every tick from live fish; queried per
 * projectile. With up to 400 fish and 200 projectiles this keeps the
 * broad-phase close to O(n) on low-powered phones.
 */
class SpatialHash {
  private cells = new Map<string, ActiveFish[]>();
  constructor(private readonly cell: number) {}

  private key(cx: number, cy: number): string {
    return `${cx}:${cy}`;
  }

  insert(fish: ActiveFish): void {
    const r = Math.max(1, Math.ceil(fish.radius / this.cell));
    const cx = Math.floor(fish.x / this.cell);
    const cy = Math.floor(fish.y / this.cell);
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        const k = this.key(cx + dx, cy + dy);
        const bucket = this.cells.get(k);
        if (bucket) bucket.push(fish);
        else this.cells.set(k, [fish]);
      }
    }
  }

  query(x: number, y: number, radius: number): ActiveFish[] {
    const out: ActiveFish[] = [];
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const r = Math.max(1, Math.ceil(radius / this.cell));
    const seen = new Set<number>();
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        const bucket = this.cells.get(this.key(cx + dx, cy + dy));
        if (!bucket) continue;
        for (const f of bucket) {
          if (seen.has(f.id) || !f.alive) continue;
          seen.add(f.id);
          out.push(f);
        }
      }
    }
    return out;
  }

  clear(): void {
    this.cells.clear();
  }
}

export interface RoomSimOptions {
  roomId: string;
  roundId: string;
  config: GameConfiguration;
  seed: number;
  /** Room-level overrides taken from the configuration. */
  spawnRateMultiplier: number;
  allowedFishIds: string[];
  hooks: SimEvents;
  width?: number;
  height?: number;
  /** Cannon seat positions across the bottom (default 4, arenas use capacity). */
  seats?: number;
  /**
   * Injectable clock. Defaults to wall time (which is what makes client and
   * server agree), but tests pass a virtual clock so they can advance seconds
   * of simulation instantly instead of sleeping.
   */
  clock?: () => number;
}

export class RoomSimulation {
  readonly fish = new Map<number, ActiveFish>();
  readonly projectiles = new Map<number, ActiveProjectile>();
  readonly players = new Map<string, SimPlayer>();

  private nextFishId = 1;
  private nextProjectileId = 1;
  private spawnBudget = 0;
  private lastWaveAt = 0;
  private lastSpawnBySpecies = new Map<string, number>();
  private readonly rng: () => number;
  private readonly grid: SpatialHash;
  private readonly pool: FishConfig[];
  private readonly totalWeight: number;
  /** Smallest live target radius: sets the collision sub-step size. */
  private readonly minFishRadius: number;
  private readonly deltas: { add: ActiveFish[]; rm: number[]; hp: { id: number; hp: number; f: number }[] } = {
    add: [],
    rm: [],
    hp: [],
  };
  private readonly broadcastEvents: Array<Record<string, unknown>> = [];
  private seatCursor = 0;

  private readonly clockFn: () => number;

  /** Current simulation time in ms, from the injected clock. */
  protected now(): number {
    return this.clockFn();
  }

  constructor(private readonly opts: RoomSimOptions) {
    // Wall clock by default. Tests inject a virtual clock so they can step
    // seconds of simulation without sleeping.
    this.clockFn = opts.clock ?? defaultWallClock;
    this.rng = createRng(opts.seed >>> 0 || 1);
    this.grid = new SpatialHash(180);
    const enabled = opts.config.fish.filter((f) => f.enabled && f.spawnWeight > 0);
    const allow = opts.allowedFishIds.filter(Boolean);
    this.pool = (allow.length ? enabled.filter((f) => allow.includes(f.id)) : enabled).filter(
      (f) => (opts.config.settings.specialFishEnabled ? true : !f.category.startsWith('SPECIAL') && f.category !== 'BOSS'),
    );
    this.totalWeight = this.pool.reduce((sum, f) => sum + Math.max(0, f.spawnWeight), 0) || 1;
    this.minFishRadius = Math.max(8, Math.min(...this.pool.map((f) => f.size), 40));
    // The first scheduled wave arrives after the configured interval, not on
    // the very first tick (otherwise every room opens with a synthetic flood).
    this.lastWaveAt = this.now();
    // Pre-seed a populated reef so the room never looks empty on entry.
    this.primeReef();
  }

  get width(): number {
    return this.opts.width ?? GAME_WIDTH;
  }

  get height(): number {
    return this.opts.height ?? GAME_HEIGHT;
  }

  /* ------------------------------- players ------------------------------- */

  addPlayer(input: { id: string; username: string; avatarSeed: string; cannonKey: string }): SimPlayer {
    const existing = this.players.get(input.id);
    if (existing) {
      existing.username = input.username;
      existing.avatarSeed = input.avatarSeed;
      return existing;
    }
    const seats = Math.min(Math.max(this.opts.seats ?? 4, 1), 32);
    const index = this.seatCursor % seats;
    this.seatCursor = (this.seatCursor + 1) % 1000;
    // The classic 4-seat layout is preserved exactly; larger arenas spread seats evenly.
    const x = seats === 4 ? this.width * (0.14 + index * 0.24) : this.width * ((index + 0.5) / seats);
    const y = this.height - 96;
    const player: SimPlayer = {
      id: input.id,
      username: input.username,
      avatarSeed: input.avatarSeed,
      cannonKey: input.cannonKey,
      angle: -Math.PI / 2,
      x,
      y,
      lastShotAt: 0,
      wagered: 0,
      rewarded: 0,
      shots: 0,
      kills: 0,
    };
    this.players.set(input.id, player);
    this.opts.hooks.logEvent('PLAYER_JOINED', { x, y }, input.id);
    return player;
  }

  /** Move a player's cannon anchor (tests + seat re-balancing). */
  relocatePlayer(playerId: string, x: number, y: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.x = x;
    player.y = y;
  }

  setPlayerSeatAnchor(playerId: string, x: number, y: number): void {
    this.relocatePlayer(playerId, x, y);
  }

  hasPlayer(playerId: string): boolean {
    return this.players.has(playerId);
  }

  removePlayer(playerId: string): void {
    if (!this.players.delete(playerId)) return;
    // Projectiles owned by a departed player are cleaned up immediately.
    for (const p of this.projectiles.values()) {
      if (p.owner === playerId) p.alive = false;
    }
    this.opts.hooks.logEvent('PLAYER_LEFT', {}, playerId);
  }

  setPlayerAim(playerId: string, angle: number, cannonKey?: string): void {
    const p = this.players.get(playerId);
    if (!p) return;
    p.angle = clampAngle(angle);
    if (cannonKey) p.cannonKey = cannonKey;
  }

  /* ------------------------------- firing ------------------------------- */

  /**
   * Register a shot. The cost/balance check has already been done by the game
   * service (the wallet was debited there); this only creates the projectile.
   */
  fire(args: { playerId: string; angle: number; originX: number; originY: number; damage: number; speed: number; cannonKey: string; cannonLevel: number; shotId: string }): ActiveProjectile {
    const player = this.players.get(args.playerId);
    const angle = clampAngle(args.angle);
    const cap = Math.max(4, Math.floor(this.opts.config.settings.maxProjectiles ?? 90));
    if (this.projectiles.size >= cap) {
      // Bounded work per tick: recycle the oldest in-flight shot rather than
      // letting a room accumulate an unbounded number of projectiles. The
      // player was still charged for it, exactly as if it had flown and missed.
      const oldest = [...this.projectiles.values()].sort((a, b) => a.t0 - b.t0)[0];
      if (oldest) {
        oldest.alive = false;
        this.projectiles.delete(oldest.id);
        this.expireShot(oldest);
      }
    }
    const speed = clamp(args.speed, 300, 6000);
    const projectile: ActiveProjectile = {
      id: this.nextProjectileId++,
      owner: args.playerId,
      x: args.originX,
      y: args.originY,
      a: angle,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      speed,
      damage: Math.max(1, Math.floor(args.damage)),
      radius: PROJECTILE_BASE_RADIUS + args.cannonLevel * 2,
      t0: this.now(),
      ttl: PROJECTILE_TTL_S,
      cannonLevel: args.cannonLevel,
      cannonKey: args.cannonKey,
      shotId: args.shotId,
      alive: true,
    };
    this.projectiles.set(projectile.id, projectile);
    if (player) {
      player.lastShotAt = this.now();
      player.angle = angle;
      player.shots += 1;
    }
    return projectile;
  }

  canFire(playerId: string, fireRate: number): { ok: boolean; waitMs: number } {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, waitMs: 1000 };
    const min = Math.max(40, 1000 / Math.max(0.2, fireRate));
    const elapsed = this.now() - player.lastShotAt;
    if (elapsed < min) return { ok: false, waitMs: Math.ceil(min - elapsed) };
    return { ok: true, waitMs: 0 };
  }

  /* ------------------------------- ticking ------------------------------- */

  /** Advance the authoritative world by one step. `dtMs` is clamped by the caller. */
  tick(dtMs: number): void {
    const now = this.now();
    const settings = this.opts.config.settings;
    const gameSpeed = clamp(settings.gameSpeed ?? 1, 0.2, 4);
    const lifetime = clamp(settings.fishLifetimeS ?? 28, 4, 600) * 1000;

    /* --- fish ----------------------------------------------------------- */
    for (const f of this.fish.values()) {
      if (!f.alive) continue;
      const age = (now - f.t0) / 1000;
      const pose = computeFishPose(f.params, age, f.species.speed, gameSpeed);
      f.x = pose.x;
      f.y = pose.y;
      f.a = pose.a;
      if (f.flash > 0) f.flash = Math.max(0, f.flash - dtMs / 260);
      const offScreen = isOutOfBounds(f.x, f.y, f.species.size, this.width, this.height);
      const ageMs = now - f.t0;
      // A fish only leaves once it is off-screen (or has become ancient and is
      // nudged out of the way), so it never blinks out in plain view.
      if ((offScreen && ageMs > 300) || ageMs > lifetime + 6000) {
        this.remove(f);
      }
    }

    /* --- spawning -------------------------------------------------------- */
    const spawnRate = clamp(settings.fishSpawnRate ?? 4, 0.1, 40) * clamp(this.opts.spawnRateMultiplier, 0.2, 4);
    this.spawnBudget += (dtMs / 1000) * spawnRate;
    let guard = 0;
    while (this.spawnBudget >= 1 && guard++ < 8) {
      this.spawnBudget -= 1;
      if (this.fish.size >= clamp(settings.maxActiveFish ?? 45, 1, 400)) {
        this.spawnBudget = Math.min(this.spawnBudget, 2);
        break;
      }
      this.spawnOne();
    }

    const waveInterval = clamp(settings.waveIntervalS ?? 45, 5, 3600) * 1000;
    if (now - this.lastWaveAt >= waveInterval) {
      this.lastWaveAt = now;
      this.runWave();
    }

    /* --- projectiles + collisions ---------------------------------------- */
    this.grid.clear();
    for (const f of this.fish.values()) if (f.alive) this.grid.insert(f);

    for (const p of this.projectiles.values()) {
      if (!p.alive) continue;
      const ageMs = now - p.t0;
      if (ageMs > p.ttl * 1000) {
        this.expireShot(p);
        continue;
      }

      // Swept motion: the shot is advanced in steps no longer than the smallest
      // target radius, so a 2000-unit/second projectile cannot tunnel straight
      // through a small fish between two 50 ms ticks.
      const travel = p.speed * (dtMs / 1000);
      const minRadius = this.minFishRadius;
      const subSteps = Math.max(1, Math.min(12, Math.ceil(travel / minRadius)));
      const stepTime = dtMs / 1000 / subSteps;

      for (let step = 0; step < subSteps && p.alive; step += 1) {
        p.x += p.vx * stepTime;
        p.y += p.vy * stepTime;
        p.a = Math.atan2(p.vy, p.vx);

        if (p.x < -80 || p.x > this.width + 80 || p.y < -80 || p.y > this.height + 160) {
          this.expireShot(p);
          break;
        }

        const candidates = this.grid.query(p.x, p.y, p.radius + minRadius + 8);
        for (const fish of candidates) {
          if (!fish.alive) continue;
          if (!circlesOverlap(p.x, p.y, p.radius, fish.x, fish.y, fish.radius)) continue;
          this.resolveHit(p, fish);
          break;
        }
      }
      if (!p.alive) continue;
      // Ageing out mid-flight is the only other way a shot disappears.
      if (now - p.t0 > p.ttl * 1000) this.expireShot(p);
    }

    // Sweep dead entities out of the maps once per tick.
    for (const [id, p] of this.projectiles) if (!p.alive) this.projectiles.delete(id);
    for (const [id, f] of this.fish) if (!f.alive) this.fish.delete(id);

    void lifetime;
  }

  private resolveHit(p: ActiveProjectile, fish: ActiveFish): void {
    p.alive = false;
    fish.hp -= p.damage;
    fish.flash = 1;
    const player = this.players.get(p.owner);
    const killed = fish.hp <= 0;

    this.deltas.hp.push({ id: fish.id, hp: Math.max(0, fish.hp), f: 1 });
    this.opts.hooks.logEvent('FISH_HIT', { fishId: fish.id, key: fish.key, damage: p.damage, killed }, p.owner);

    this.broadcastEvents.push({
      type: 'hit',
      event: {
        fishId: fish.id,
        projectileId: p.id,
        hp: Math.max(0, fish.hp),
        mhp: fish.mhp,
        x: fish.x,
        y: fish.y,
        damage: p.damage,
        ownerId: p.owner,
      },
    });

    if (!killed) {
      this.opts.hooks.shotResolved({
        shotId: p.shotId,
        playerId: p.owner,
        result: 'HIT',
        reward: 0,
        fishKey: fish.key,
        fishName: fish.species.name,
        roundId: this.opts.roundId,
      });
      return;
    }

    /* ---------------------------- kill resolution ---------------------------- */
    const reward = this.computeReward(fish);
    const credited = this.opts.hooks.reward({
      playerId: p.owner,
      amount: reward,
      shotId: p.shotId,
      fishKey: fish.key,
      roundId: this.opts.roundId,
    });

    if (player) player.kills += 1;
    this.opts.hooks.shotResolved({
      shotId: p.shotId,
      playerId: p.owner,
      result: 'KILL',
      reward: credited.ok ? reward : 0,
      fishKey: fish.key,
      fishName: fish.species.name,
      roundId: this.opts.roundId,
    });

    this.broadcastEvents.push({
      type: 'defeat',
      event: {
        fishId: fish.id,
        key: fish.key,
        x: fish.x,
        y: fish.y,
        reward: credited.ok ? reward : 0,
        ownerId: p.owner,
        mine: credited.ok,
        balance: credited.balance,
        special: fish.species.special,
      },
    });
    this.opts.hooks.logEvent('FISH_DEFEATED', { fishId: fish.id, key: fish.key, reward }, p.owner);
    if (credited.ok) this.opts.hooks.logEvent('REWARD_GRANTED', { amount: reward, shotId: p.shotId }, p.owner);

    fish.alive = false;
    this.deltas.rm.push(fish.id);
    this.specialOnDeath(fish, p.owner, credited.ok ? credited.balance : undefined);
  }

  /**
   * Reward for a species. Special fish apply a transparent, global multiplier —
   * identical for every player, never conditioned on who they are.
   */
  private computeReward(fish: ActiveFish): number {
    const base = Math.max(0, Math.floor(fish.species.reward));
    switch (fish.species.special) {
      case 'golden':
        return base * GOLDEN_MULTIPLIER;
      case 'treasure':
        return base + Math.floor(this.rng() * base * (TREASURE_MAX_MULTIPLIER - 1));
      default:
        return base;
    }
  }

  private specialOnDeath(fish: ActiveFish, playerId: string, balance?: number): void {
    const special = fish.species.special;
    if (special === 'bomb') {
      let chain = 0;
      for (const other of this.fish.values()) {
        if (!other.alive || other.id === fish.id) continue;
        const dx = other.x - fish.x;
        const dy = other.y - fish.y;
        if (dx * dx + dy * dy > BOMB_SPLASH_RADIUS * BOMB_SPLASH_RADIUS) continue;
        other.hp -= BOMB_SPLASH_DAMAGE;
        other.flash = 1;
        this.deltas.hp.push({ id: other.id, hp: Math.max(0, other.hp), f: 1 });
        if (other.hp <= 0 && chain < 6) {
          chain += 1;
          const splashReward = this.computeReward(other);
          const credited = this.opts.hooks.reward({
            playerId,
            amount: splashReward,
            shotId: `splash:${fish.id}:${other.id}`,
            fishKey: other.key,
            roundId: this.opts.roundId,
          });
          this.broadcastEvents.push({
            type: 'defeat',
            event: {
              fishId: other.id,
              key: other.key,
              x: other.x,
              y: other.y,
              reward: credited.ok ? splashReward : 0,
              ownerId: playerId,
              mine: credited.ok,
              balance: credited.balance ?? balance,
              special: other.species.special,
            },
          });
          other.alive = false;
          this.deltas.rm.push(other.id);
          this.opts.hooks.logEvent('SPECIAL_EFFECT', { kind: 'bomb_splash', from: fish.id, killed: other.id, reward: splashReward }, playerId);
        }
      }
      this.broadcastEvents.push({ type: 'explosion', x: fish.x, y: fish.y, r: BOMB_SPLASH_RADIUS });
      return;
    }

    if (special === 'boss') {
      // A defeated boss releases a bonus school for everyone in the room.
      this.runWave(Math.max(4, Math.floor((this.opts.config.settings.waveSize ?? 8) * 0.75)), ['COMMON', 'MEDIUM']);
      this.broadcastEvents.push({ type: 'bossDefeated', x: fish.x, y: fish.y, ownerId: playerId });
      this.opts.hooks.logEvent('SPECIAL_EFFECT', { kind: 'boss_wave', from: fish.id }, playerId);
    }
  }

  private expireShot(p: ActiveProjectile): void {
    p.alive = false;
    this.opts.hooks.shotResolved({
      shotId: p.shotId,
      playerId: p.owner,
      result: 'MISSED' as const,
      reward: 0,
      fishKey: null,
      fishName: null,
      roundId: this.opts.roundId,
    });
  }

  /** Remove a fish that was not killed (swam off / expired). */
  private remove(fish: ActiveFish): void {
    fish.alive = false;
    this.deltas.rm.push(fish.id);
  }

  /* ------------------------- deterministic test hooks -------------------------
   * Used by the automated suite (and by an offline "practice" room, if one is
   * ever added) to place entities at known coordinates. They do not weaken the
   * server's authority: real client requests never reach them.
   * ------------------------------------------------------------------------- */

  debugSpawn(
    speciesKey: string,
    at: { x: number; y: number; angle?: number; hp?: number },
  ): ActiveFish {
    const species = this.opts.config.fish.find((f) => f.key === speciesKey);
    if (!species) throw new Error(`Unknown species ${speciesKey}`);
    const params = createFishMotion({
      pattern: 'STRAIGHT',
      rng: this.rng,
      radius: species.size,
      width: this.width,
      height: this.height,
    });
    params.x0 = at.x;
    params.y0 = at.y;
    params.a = at.angle ?? 0;
    params.p = 'STRAIGHT';
    params.amp = 0;
    params.freq = 0;
    const fish: ActiveFish = {
      id: this.nextFishId++,
      key: species.key,
      species,
      params,
      t0: this.now(),
      hp: at.hp ?? species.health,
      mhp: species.health,
      x: at.x,
      y: at.y,
      a: params.a,
      radius: species.size,
      flash: 0,
      alive: true,
      chain: false,
    };
    this.fish.set(fish.id, fish);
    return fish;
  }

  /** Fire a projectile from an arbitrary origin, bypassing cost (tests only). */
  debugFireAt(args: { playerId: string; shotId: string; x: number; y: number; angle: number; damage: number; speed: number; cannonLevel: number }): ActiveProjectile {
    return this.fire({
      playerId: args.playerId,
      angle: args.angle,
      originX: args.x,
      originY: args.y,
      damage: args.damage,
      speed: args.speed,
      cannonKey: 'test',
      cannonLevel: args.cannonLevel,
      shotId: args.shotId,
    });
  }

  /**
   * Land a shot directly on a fish (no travel). Used by the test-suite to assert
   * the damage/reward rules in isolation from the motion solver.
   */
  debugHitAt(args: { playerId: string; shotId: string; fishId: number; damage: number; cannonLevel?: number }): ActiveProjectile | null {
    const fish = this.fish.get(args.fishId);
    if (!fish) return null;
    return this.fire({
      playerId: args.playerId,
      angle: fish.a,
      originX: fish.x,
      originY: fish.y,
      damage: args.damage,
      // Zero speed keeps the projectile on top of the fish for exactly one tick,
      // which is all the collision pass needs.
      speed: 300,
      cannonKey: 'test',
      cannonLevel: args.cannonLevel ?? 1,
      shotId: args.shotId,
    });
  }

  debugBarrage(playerId: string, count: number): void {
    for (let i = 0; i < count; i += 1) {
      this.fire({
        playerId,
        angle: -Math.PI / 2 + (i % 20) * 0.05,
        originX: 900,
        originY: 900,
        damage: 1,
        speed: 2000,
        cannonKey: 'test',
        cannonLevel: 1,
        shotId: `barrage-${i}`,
      });
    }
  }

  /* ------------------------------- spawning ------------------------------- */

  private pickSpecies(): FishConfig | null {
    if (!this.pool.length) return null;
    let r = this.rng() * this.totalWeight;
    for (const f of this.pool) {
      r -= Math.max(0, f.spawnWeight);
      if (r <= 0) return f;
    }
    return this.pool[this.pool.length - 1] ?? null;
  }

  private spawnOne(edge?: 'left' | 'right' | 'top' | 'bottom', categoryFilter?: string[]): ActiveFish | null {
    const now = this.now();
    let species = this.pickSpecies();
    if (!species) return null;

    if (categoryFilter?.length) {
      const match = this.pool.filter((f) => categoryFilter.includes(f.category) || categoryFilter.includes(f.special ?? ''));
      if (match.length) species = match[Math.floor(this.rng() * match.length)]!;
    }

    // Respect the per-species minimum spacing so a species cannot flood the field.
    const last = this.lastSpawnBySpecies.get(species.key) ?? 0;
    if (now - last < species.minSpawnIntervalMs) return null;
    this.lastSpawnBySpecies.set(species.key, now);

    const params = createFishMotion({
      pattern: species.movementPattern,
      rng: this.rng,
      radius: species.size,
      width: this.width,
      height: this.height,
      edge,
    });

    const fish: ActiveFish = {
      id: this.nextFishId++,
      key: species.key,
      species,
      params,
      t0: now,
      hp: species.health,
      mhp: species.health,
      x: params.x0,
      y: params.y0,
      a: params.a,
      radius: species.size,
      flash: 0,
      alive: true,
      chain: false,
    };
    this.fish.set(fish.id, fish);
    this.deltas.add.push(fish);
    this.opts.hooks.logEvent('FISH_SPAWNED', { fishId: fish.id, key: fish.key, pattern: species.movementPattern });
    return fish;
  }

  private runWave(size = Math.max(1, Math.floor(this.opts.config.settings.waveSize ?? 8)), categoryFilter?: string[]): void {
    const edge: Array<'left' | 'right' | 'top' | 'bottom'> = ['left', 'right', 'left', 'right'];
    let spawned = 0;
    for (let i = 0; i < size * 2 && spawned < size; i += 1) {
      const f = this.spawnOne(edge[i % edge.length], categoryFilter);
      if (f) spawned += 1;
      if (this.fish.size >= (this.opts.config.settings.maxActiveFish ?? 45)) break;
    }
    if (spawned > 0) {
      this.broadcastEvents.push({ type: 'wave', size: spawned });
      this.opts.hooks.logEvent('WAVE_STARTED', { size: spawned });
    }
  }

  private primeReef(): void {
    const target = Math.min(18, Math.floor((this.opts.config.settings.maxActiveFish ?? 45) * 0.4));
    for (let i = 0; i < target; i += 1) {
      const f = this.spawnOne();
      if (!f) continue;
      // Age the pre-seeded fish so the reef looks mid-motion on entry, but keep
      // them comfortably inside the field.
      const age = this.rng() * 4 + 0.6;
      f.t0 = this.now() - age * 1000;
      const pose = computeFishPose(f.params, age, f.species.speed, this.opts.config.settings.gameSpeed ?? 1);
      if (isOutOfBounds(pose.x, pose.y, f.radius, this.width, this.height)) {
        f.x = this.width * (0.15 + this.rng() * 0.7);
        f.y = this.height * (0.15 + this.rng() * 0.5);
        f.params.x0 = f.x;
        f.params.y0 = f.y;
      }
    }
    this.deltas.add.length = 0;
  }

  /* ------------------------------- outputs ------------------------------- */

  toFishInstance(f: ActiveFish) {
    return {
      id: f.id,
      key: f.key,
      t0: f.t0,
      hp: f.hp,
      mhp: f.mhp,
      p: f.params,
      s: f.species.speed,
      f: f.flash > 0 ? 1 : 0,
    };
  }

  toProjectileInstance(p: ActiveProjectile) {
    return {
      id: p.id,
      owner: p.owner,
      x: p.x,
      y: p.y,
      a: p.a,
      lvl: p.cannonLevel,
      t0: p.t0,
      ttl: p.ttl,
      v: p.speed,
    };
  }

  snapshot() {
    const now = this.now();
    return {
      t: Math.floor(now / 50),
      st: now,
      roundId: this.opts.roundId,
      configVersion: this.opts.config.version,
      fish: [...this.fish.values()].filter((f) => f.alive).map((f) => this.toFishInstance(f)),
      projectiles: [...this.projectiles.values()].filter((p) => p.alive).map((p) => this.toProjectileInstance(p)),
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        username: p.username,
        avatarSeed: p.avatarSeed,
        cannonKey: p.cannonKey,
        cannonLevel: this.opts.config.cannons.find((c) => c.key === p.cannonKey)?.level ?? 1,
        angle: p.angle,
        x: p.x,
        y: p.y,
      })),
    };
  }

  /** Consume the accumulated delta since the last call. */
  drainDelta() {
    const d = this.deltas;
    const out = {
      t: Math.floor(this.now() / 50),
      st: this.now(),
      add: d.add.map((f) => this.toFishInstance(f)),
      rm: d.rm.slice(),
      hp: d.hp.slice(),
    };
    d.add.length = 0;
    d.rm.length = 0;
    d.hp.length = 0;
    return out;
  }

  drainBroadcasts(): Array<Record<string, unknown>> {
    const out = this.broadcastEvents.slice();
    this.broadcastEvents.length = 0;
    return out;
  }

  get poolSize(): number {
    return this.pool.length;
  }

  /** Angle normalisation exposed so the transport layer clamps before sim. */
  settleAngle(angle: number): number {
    return clampAngle(angle);
  }

  get stats() {
    return {
      fish: this.fish.size,
      projectiles: this.projectiles.size,
      players: this.players.size,
    };
  }

  /** Total wagered/rewarded per player — feeds the round report + admin stats. */
  playerEconomy() {
    return [...this.players.values()].map((p) => ({
      playerId: p.id,
      shots: p.shots,
      wagered: p.wagered,
      rewarded: p.rewarded,
      kills: p.kills,
    }));
  }

  addWager(playerId: string, amount: number): void {
    const p = this.players.get(playerId);
    if (p) p.wagered += amount;
  }

  addReward(playerId: string, amount: number): void {
    const p = this.players.get(playerId);
    if (p) p.rewarded += amount;
  }

  get roundId(): string {
    return this.opts.roundId;
  }

  setRound(roundId: string, config: GameConfiguration): void {
    (this.opts as { roundId: string; config: GameConfiguration }).roundId = roundId;
    (this.opts as { config: GameConfiguration }).config = config;
  }
}

/** Only allow shots that travel upwards-ish; the cannon sits at the bottom. */
export function clampAngle(angle: number): number {
  if (!Number.isFinite(angle)) return -Math.PI / 2;
  let a = angle % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  // Map into [-PI - 0.12, -0.12] i.e. the upper half-plane with a small margin.
  if (a >= 0) {
    // Pointing down: fold it onto the nearest horizontal direction.
    a = a < Math.PI / 2 ? -0.12 : -(Math.PI - 0.12);
  }
  return clamp(a, -Math.PI - 0.12, -0.12);
}
