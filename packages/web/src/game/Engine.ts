import {
  GAME_HEIGHT,
  GAME_WIDTH,
  computeFishPose,
  createRng,
  lerpAngle,
  type FishConfig,
  type RoomSnapshot,
  type ServerMessage,
} from '@reef/shared';
import { ParticleSystem } from './Particles.js';
import { Renderer } from './Renderer.js';
import { createSpriteCache, drawCannon, drawProjectile } from './Sprites.js';
import type { RenderContext } from './Renderer.js';
import type { SoundName } from './Audio.js';
import type { WorldFish, WorldPlayer, WorldProjectile } from './types.js';

/**
 * Client game engine.
 *
 * Owns the render loop, the input-driven cannon, local shot prediction and the
 * visual mirror of the authoritative room. It never decides an outcome: hits,
 * kills, rewards and balances only ever come from server messages. The one
 * exception is `practice` mode, where a local simulation is used and no wallet
 * exists at all.
 */

export interface EngineCallbacks {
  onBalance?: (balance: number) => void;
  onNotice?: (level: 'info' | 'warn' | 'error', message: string) => void;
  onStats?: (stats: EngineStats) => void;
  onSound?: (name: SoundName, intensity: number) => void;
  onReward?: (reward: { amount: number; fish: string; x: number; y: number }) => void;
  sendAim?: (angle: number) => void;
  requestFire?: (intent: { clientRef: string; angle: number; originX: number; originY: number }) => void;
}

export interface EngineStats {
  fps: number;
  fish: number;
  projectiles: number;
  particles: number;
  quality: number;
  combo: number;
  comboMultiplier: number;
  shotsFired: number;
  kills: number;
  wagered: number;
  rewarded: number;
}

interface FloatText {
  id: number;
  x: number;
  y: number;
  vy: number;
  life: number;
  ttl: number;
  text: string;
  kind: 'reward' | 'cost' | 'info' | 'combo' | 'boss';
  size: number;
}

const TAU = Math.PI * 2;

export class Engine {
  readonly renderer: Renderer;
  readonly particles = new ParticleSystem(760);
  private sprites = createSpriteCache();

  private fish = new Map<number, WorldFish>();
  private projectiles = new Map<number, WorldProjectile>();
  private players = new Map<string, WorldPlayer>();
  private floats: FloatText[] = [];
  private nextFloatId = 1;

  private species = new Map<string, FishConfig>();
  private rafId = 0;
  private running = false;
  private lastFrame = 0;
  private frameTimes: number[] = [];
  private quality = 1;
  private qualityCooldown = 0;

  private shake = 0;
  private flash = 0;
  private combo = 0;
  private comboAt = 0;
  private time = 0;
  private serverNow = Date.now();
  private lastSnapshotAt = 0;

  localId = 'local';
  aimAngle = -Math.PI / 2;
  cannonX = GAME_WIDTH * 0.5;
  cannonY = GAME_HEIGHT - 96;
  cannonLevel = 1;
  cannonColor = '#24d7ff';
  recoil = 0;
  fireCooldown = 0;
  fireIntervalMs = 320;
  practice = false;
  autoFire = false;
  private predicted = new Map<string, { id: number; hitFishId: number | null; at: number }>();
  private nextNegativeId = 1;
  /** Offset (ms) between the local clock and the server clock. */
  clockOffset = 0;

  stats: EngineStats = {
    fps: 60,
    fish: 0,
    projectiles: 0,
    particles: 0,
    quality: 1,
    combo: 0,
    comboMultiplier: 1,
    shotsFired: 0,
    kills: 0,
    wagered: 0,
    rewarded: 0,
  };

  /** Practice-mode simulation state (no network, no wallet). */
  private practiceRng = createRng(1337);
  private practiceFish = new Map<number, { hp: number; mhp: number }>();
  private practiceNextId = 100_000;

  constructor(private canvas: HTMLCanvasElement, private callbacks: EngineCallbacks = {}) {
    this.renderer = new Renderer(canvas, this.sprites);
    this.renderer.resize(canvas.clientWidth || 960, canvas.clientHeight || 540);
  }

  /* ------------------------------- lifecycle ------------------------------- */

  setCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    (this.renderer as any).canvas = canvas;
  }

  setSpecies(list: FishConfig[]): void {
    this.species = new Map(list.map((f) => [f.key, f]));
    this.sprites.clear();
  }

  setLocalPlayer(input: { id: string; cannonKey: string; level: number; fireRate: number; color?: string; x?: number; y?: number }): void {
    this.localId = input.id;
    this.cannonLevel = input.level;
    this.fireIntervalMs = Math.max(80, 1000 / Math.max(0.2, input.fireRate));
    if (input.color) this.cannonColor = input.color;
    if (input.x !== undefined) this.cannonX = input.x;
    if (input.y !== undefined) this.cannonY = input.y;
    this.upsertPlayer(input.id, { cannonLevel: input.level, x: this.cannonX, y: this.cannonY, isLocal: true });
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.renderer.resize(cssWidth, cssHeight, this.quality > 0.6 ? 2 : 1.5);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrame) / 1000));
      this.lastFrame = now;
      this.tick(dt, now);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  destroy(): void {
    this.stop();
    this.fish.clear();
    this.projectiles.clear();
    this.players.clear();
    this.floats.length = 0;
    this.particles.clear();
  }

  reset(): void {
    this.fish.clear();
    this.projectiles.clear();
    this.floats.length = 0;
    this.particles.clear();
    this.combo = 0;
    this.stats.shotsFired = 0;
    this.stats.kills = 0;
    this.stats.wagered = 0;
    this.stats.rewarded = 0;
  }

  /* --------------------------------- inputs --------------------------------- */

  setAutoFire(on: boolean): void {
    this.autoFire = on;
    if (on) this.fireCooldown = 0;
  }

  /** Apply the server clock offset measured by the transport layer. */
  setClockOffset(offsetMs: number): void {
    this.clockOffset = offsetMs;
  }

  setAim(angle: number): void {
    if (!Number.isFinite(angle)) return;
    // Keep shots in the playable upper hemisphere, matching the server clamp.
    let a = angle % TAU;
    if (a > Math.PI) a -= TAU;
    if (a < -Math.PI) a += TAU;
    if (a >= 0) a = a < Math.PI / 2 ? -0.07 : -(Math.PI - 0.07);
    this.aimAngle = Math.max(-Math.PI - 0.07, Math.min(-0.07, a));
    this.callbacks.sendAim?.(this.aimAngle);
    const me = this.players.get(this.localId);
    if (me) me.angle = this.aimAngle;
  }

  /**
   * Fire request from the UI. Returns false when the shot cannot be sent yet
   * (cooldown / no link), so the caller can keep the trigger pressed.
   */
  tryFire(): boolean {
    if (this.fireCooldown > 0) return false;
    const clientRef = `${this.localId.slice(-6)}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.fireCooldown = this.fireIntervalMs / 1000;
    this.recoil = 1;
    this.shake = Math.min(9, 3 + this.cannonLevel * 1.3);
    this.audioCue('shot', Math.min(1, 0.4 + this.cannonLevel * 0.1));
    this.particles.muzzle(this.cannonX, this.cannonY, this.aimAngle, this.cannonLevel);
    this.callbacks.requestFire?.({ clientRef, angle: this.aimAngle, originX: this.cannonX, originY: this.cannonY });

    if (this.practice) {
      // Practice mode has no server, so the client resolves the shot locally.
      this.spawnPracticeProjectile(clientRef);
    }
    return true;
  }

  /* --------------------------------- network --------------------------------- */

  handle(message: ServerMessage): void {
    switch (message.type) {
      case 'joined': {
        this.cannonX = message.seat.x;
        this.cannonY = message.seat.y;
        const option = message.betOptions.find((o) => o.key === message.cannonKey);
        this.cannonLevel = option?.level ?? 1;
        this.fireIntervalMs = Math.max(80, 1000 / Math.max(0.2, option?.fireRate ?? 3));
        this.applySnapshot(message.snapshot);
        this.upsertPlayer(this.localId, { x: message.seat.x, y: message.seat.y, cannonLevel: this.cannonLevel, isLocal: true });
        this.callbacks.onBalance?.(message.balance);
        return;
      }
      case 'snapshot':
        this.applySnapshot(message.snapshot);
        return;
      case 'delta': {
        const { add, rm, hp } = message.delta;
        for (const f of add) this.upsertFish(f);
        for (const id of rm) {
          const existing = this.fish.get(id);
          if (existing) existing.fadeOut = true;
        }
        for (const update of hp) {
          const existing = this.fish.get(update.id);
          if (!existing) continue;
          existing.hp = update.hp;
          if (update.f) existing.flash = 1;
        }
        this.lastSnapshotAt = performance.now();
        return;
      }
      case 'shot': {
        const ack = message.ack;
        if (!ack.ok) {
          this.dropPredicted(ack.clientRef);
          if (ack.code !== 'RATE_LIMITED') this.callbacks.onNotice?.(ack.code === 'INSUFFICIENT_FUNDS' ? 'warn' : 'error', ack.message ?? 'Shot rejected.');
          if (typeof (ack as any).balance === 'number') this.callbacks.onBalance?.((ack as any).balance as number);
          return;
        }
        if ((ack as any).replayed) return;
        // Reconcile the predicted projectile with the authoritative trajectory.
        const predicted = this.takePredicted(ack.clientRef);
        const id = Number(ack.projectileId);
        const projectile: WorldProjectile = {
          id: Number.isFinite(id) ? id : -(this.nextNegativeId++),
          owner: this.localId,
          x: ack.originX,
          y: ack.originY,
          angle: ack.angle,
          vx: Math.cos(ack.angle) * ack.speed,
          vy: Math.sin(ack.angle) * ack.speed,
          speed: ack.speed,
          level: this.cannonLevel,
          t0: this.serverNow,
          ttl: 2.4,
          mine: true,
          radius: 11 + this.cannonLevel * 2,
          dead: false,
          trail: [],
          hitFishId: predicted?.hitFishId ?? null,
        };
        this.projectiles.set(projectile.id, projectile);
        this.stats.shotsFired += 1;
        this.stats.wagered += ack.cost;
        this.callbacks.onBalance?.(ack.balance);
        return;
      }
      case 'shotBroadcast': {
        const p = message.projectile;
        if (p.owner === this.localId) return;
        this.projectiles.set(p.id, {
          id: p.id,
          owner: p.owner,
          x: p.x,
          y: p.y,
          angle: p.a,
          vx: Math.cos(p.a) * p.v,
          vy: Math.sin(p.a) * p.v,
          speed: p.v,
          level: p.lvl,
          t0: p.t0,
          ttl: p.ttl,
          mine: false,
          radius: 11 + p.lvl * 2,
          dead: false,
          trail: [],
          hitFishId: null,
        });
        return;
      }
      case 'hit': {
        const e = message.event;
        const target = this.fish.get(e.fishId);
        if (target) {
          target.hp = e.hp;
          target.flash = 1;
        }
        const projectile = this.projectiles.get(e.projectileId);
        if (projectile && projectile.owner === this.localId) projectile.dead = true;
        const gold = target?.species?.category.startsWith('SPECIAL_GOLDEN') ?? false;
        this.particles.hitSparks(e.x, e.y, e.damage, gold ? 45 : 186);
        if (e.mine) this.audioCue('hit', Math.min(1, e.damage / 20));
        return;
      }
      case 'defeat': {
        const e = message.event;
        const target = this.fish.get(e.fishId);
        const species = target?.species;
        const x = e.x;
        const y = e.y;
        const boss = species?.category === 'BOSS';
        this.particles.defeatBurst(x, y, species?.size ?? 30, hueFor(species), e.special === 'golden' || boss || e.key.includes('golden'));
        if (target) target.dying = 0.001;
        if (e.mine) {
          this.stats.kills += 1;
          this.stats.rewarded += e.reward;
          this.registerCombo();
          this.addFloat(x, y - 12, `+${e.reward}`, e.reward >= 100 ? 'boss' : 'reward', e.reward >= 100 ? 74 : 46 + Math.min(18, e.reward / 6));
          this.callbacks.onReward?.({ amount: e.reward, fish: species?.name ?? e.key, x, y });
          this.audioCue(boss ? 'bossKill' : 'kill', Math.min(1, e.reward / 120));
          this.audioCue('reward', Math.min(1, e.reward / 120));
          if (boss) {
            this.shake = 26;
            this.flash = 0.5;
          }
        } else if (this.practice) {
          this.addFloat(x, y - 12, `+${e.reward}`, 'info', 34);
        }
        if (typeof e.balance === 'number') this.callbacks.onBalance?.(e.balance);
        return;
      }
      case 'explosion':
        this.particles.explosion(message.x, message.y, message.r);
        this.shake = Math.max(this.shake, 16);
        this.audioCue('kill', 1);
        return;
      case 'bossDefeated':
        this.shake = 30;
        this.flash = 0.6;
        this.particles.explosion(message.x, message.y, 420);
        return;
      case 'wave':
        this.callbacks.onNotice?.('info', `A school moves through - ${message.size} fish incoming.`);
        this.audioCue('wave', 0.6);
        return;
      case 'playerJoined':
        this.upsertPlayer(message.player.id, {
          username: message.player.username,
          x: message.player.x,
          y: message.player.y,
          cannonLevel: message.player.cannonLevel,
          angle: message.player.angle,
          isLocal: message.player.id === this.localId,
        });
        return;
      case 'playerLeft':
        this.players.delete(message.playerId);
        for (const p of this.projectiles.values()) if (p.owner === message.playerId) p.dead = true;
        return;
      case 'playerMoved': {
        const player = this.players.get(message.playerId);
        if (player) {
          player.angle = message.angle;
          player.cannonKey = message.cannonKey;
          if (message.playerId === this.localId) {
            const level = Number((message as any).cannonLevel ?? this.cannonLevel);
            this.cannonLevel = Number.isFinite(level) ? level : this.cannonLevel;
          }
        }
        return;
      }
      case 'round':
        this.reset();
        this.callbacks.onNotice?.('info', 'New round started.');
        return;
      case 'balance':
        this.callbacks.onBalance?.(message.balance);
        return;
      case 'notice':
        this.callbacks.onNotice?.(message.level, message.message);
        return;
      case 'time':
        this.serverNow = message.st;
        return;
      default:
        return;
    }
  }

  private applySnapshot(snapshot: RoomSnapshot): void {
    if (!snapshot) return;
    this.lastSnapshotAt = performance.now();
    const seen = new Set<number>();
    for (const f of snapshot.fish) {
      seen.add(f.id);
      this.upsertFish(f);
    }
    for (const id of [...this.fish.keys()]) {
      if (!seen.has(id)) {
        const fish = this.fish.get(id)!;
        fish.fadeOut = true;
      }
    }
    this.projectiles.clear();
    for (const p of snapshot.projectiles) {
      this.projectiles.set(p.id, {
        id: p.id,
        owner: p.owner,
        x: p.x,
        y: p.y,
        angle: p.a,
        vx: Math.cos(p.a) * p.v,
        vy: Math.sin(p.a) * p.v,
        speed: p.v,
        level: p.lvl,
        t0: p.t0,
        ttl: p.ttl,
        mine: p.owner === this.localId,
        radius: 11 + p.lvl * 2,
        dead: false,
        trail: [],
        hitFishId: null,
      });
    }
    for (const player of snapshot.players) {
      this.upsertPlayer(player.id, {
        username: player.username,
        x: player.x,
        y: player.y,
        cannonLevel: player.cannonLevel,
        angle: player.angle,
        isLocal: player.id === this.localId,
      });
    }
    if (snapshot.players.length) {
      const me = snapshot.players.find((p) => p.id === this.localId);
      if (me) {
        this.cannonX = me.x;
        this.cannonY = me.y;
      }
    }
  }

  private upsertFish(source: RoomSnapshot['fish'][number]): void {
    const existing = this.fish.get(source.id);
    const species = this.species.get(source.key);
    if (existing) {
      existing.hp = source.hp;
      existing.mhp = source.mhp;
      existing.fadeOut = false;
      existing.dying = 0;
      return;
    }
    this.fish.set(source.id, {
      id: source.id,
      key: source.key,
      species: species ?? undefined,
      params: source.p,
      speed: source.s,
      t0: source.t0,
      hp: source.hp,
      mhp: source.mhp,
      x: source.p.x0,
      y: source.p.y0,
      angle: source.p.a,
      radius: (species?.size ?? 30) * 0.92,
      flash: 0,
      appear: 0,
      dying: 0,
      fadeOut: false,
      phase: 0,
      dir: 1,
      boss: species?.category === 'BOSS',
    });
    if (species && !this.sprites.get(species)) this.sprites.get(species);
  }

  private upsertPlayer(
    id: string,
    patch: Partial<Omit<WorldPlayer, 'id' | 'username' | 'avatarSeed' | 'cannonKey' | 'shownAngle' | 'recoil'>> & { username?: string },
  ): void {
    const existing = this.players.get(id);
    if (existing) {
      Object.assign(existing, patch);
      if (patch.isLocal) existing.isLocal = true;
      return;
    }
    this.players.set(id, {
      id,
      username: patch.username ?? 'player',
      avatarSeed: (patch as any).avatarSeed ?? id,
      cannonKey: 'tidecaster',
      cannonLevel: patch.cannonLevel ?? 1,
      x: patch.x ?? GAME_WIDTH / 2,
      y: patch.y ?? GAME_HEIGHT - 96,
      angle: patch.angle ?? -Math.PI / 2,
      shownAngle: patch.angle ?? -Math.PI / 2,
      recoil: 0,
      isLocal: patch.isLocal ?? false,
    });
  }

  /* ------------------------- local shot prediction ------------------------- */

  private takePredicted(clientRef: string): { id: number; hitFishId: number | null } | undefined {
    const entry = this.predicted.get(clientRef);
    if (entry) {
      this.predicted.delete(clientRef);
      this.projectiles.delete(entry.id);
    }
    return entry;
  }

  private dropPredicted(clientRef: string): void {
    const entry = this.predicted.get(clientRef);
    if (!entry) return;
    this.predicted.delete(clientRef);
    this.projectiles.delete(entry.id);
    this.audioCue('error', 0.4);
  }

  /** Locally-drawn shot used for practice mode and pre-ack feedback. */
  private spawnPracticeProjectile(clientRef: string): void {
    const id = -(this.nextNegativeId++);
    const speed = 1700;
    this.projectiles.set(id, {
      id,
      owner: this.localId,
      x: this.cannonX,
      y: this.cannonY,
      angle: this.aimAngle,
      vx: Math.cos(this.aimAngle) * speed,
      vy: Math.sin(this.aimAngle) * speed,
      speed,
      level: this.cannonLevel,
      t0: this.serverNow,
      ttl: 2.4,
      mine: true,
      radius: 11 + this.cannonLevel * 2,
      dead: false,
      trail: [],
      hitFishId: null,
    });
    this.predicted.set(clientRef, { id, hitFishId: null, at: performance.now() });
    this.stats.shotsFired += 1;
  }

  /* ------------------------------ practice mode ------------------------------ */

  /**
   * Offline practice: the client runs a small local simulation so the game is
   * still explorable with no server. Clearly labelled in the UI; no wallet, no
   * ledger, no coins of any kind leave the browser.
   */
  enablePractice(on: boolean): void {
    this.practice = on;
    if (!on) return;
    this.reset();
    this.cannonX = GAME_WIDTH / 2;
    this.cannonY = GAME_HEIGHT - 96;
    this.upsertPlayer(this.localId, { username: 'You (practice)', x: this.cannonX, y: this.cannonY, cannonLevel: this.cannonLevel, isLocal: true });
    const keys = [...this.species.keys()];
    for (let i = 0; i < 16; i += 1) this.spawnPracticeFish(keys);
  }

  private spawnPracticeFish(keys: string[]): void {
    if (!keys.length) return;
    const key = keys[Math.floor(this.practiceRng() * keys.length)]!;
    const species = this.species.get(key);
    if (!species) return;
    const id = this.practiceNextId++;
    const fromLeft = this.practiceRng() < 0.5;
    const margin = species.size + 40;
    this.fish.set(id, {
      id,
      key,
      species,
      params: {
        p: species.movementPattern,
        x0: fromLeft ? -margin : GAME_WIDTH + margin,
        y0: 90 + this.practiceRng() * (GAME_HEIGHT - 380),
        a: fromLeft ? -0.3 + this.practiceRng() * 0.6 : Math.PI - 0.3 + this.practiceRng() * 0.6,
        amp: 40 + this.practiceRng() * 70,
        freq: 1 + this.practiceRng() * 1.6,
        radius: 120 + this.practiceRng() * 160,
        spin: (this.practiceRng() < 0.5 ? -1 : 1) * (0.25 + this.practiceRng() * 0.4),
        w1: this.practiceRng() * TAU,
        w2: this.practiceRng() * TAU,
      },
      speed: species.speed,
      t0: this.serverNow,
      hp: species.health,
      mhp: species.health,
      x: 0,
      y: 0,
      angle: 0,
      radius: species.size * 0.92,
      flash: 0,
      appear: 0,
      dying: 0,
      fadeOut: false,
      phase: 0,
      dir: fromLeft ? 1 : -1,
      boss: species.category === 'BOSS',
    });
    this.practiceFish.set(id, { hp: species.health, mhp: species.health });
  }

  private practiceTick(dt: number): void {
    if (!this.practice) return;
    const keys = [...this.species.keys()];
    if (this.fish.size < 18 && this.practiceRng() < dt * 3.2) this.spawnPracticeFish(keys);
    if (this.fireCooldown <= 0 && this.autoFire && this.practice) this.tryFire();
  }

  /* --------------------------------- update --------------------------------- */

  private tick(dt: number, now: number): void {
    this.time += dt;
    this.serverNow = Date.now() + this.clockOffset;
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.recoil = Math.max(0, this.recoil - dt * 4.4);
    this.shake = Math.max(0, this.shake - dt * 42);
    this.flash = Math.max(0, this.flash - dt * 2.4);
    if (this.combo > 0 && now - this.comboAt > 3200) this.combo = 0;

    // Adaptive quality: sustained low FPS trims effects and DPR.
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 45) this.frameTimes.shift();
    this.qualityCooldown -= dt;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, this.frameTimes.length);
    const fps = 1 / Math.max(0.0001, avg);
    if (this.qualityCooldown <= 0) {
      if (fps < 45 && this.quality > 0.45) {
        this.quality -= 0.25;
        this.renderer.quality = this.quality;
        this.qualityCooldown = 2.5;
      } else if (fps > 57 && this.quality < 1) {
        this.quality = Math.min(1, this.quality + 0.25);
        this.renderer.quality = this.quality;
        this.qualityCooldown = 4;
      }
    }

    /* --- fish: deterministic pose from spawn params (matches the server) --- */
    const gameSpeed = 1;
    for (const [id, fish] of this.fish) {
      const age = (this.serverNow - fish.t0) / 1000;
      const pose = computeFishPose(fish.params, age, fish.speed, gameSpeed);
      fish.x = pose.x;
      fish.y = pose.y;
      fish.angle = pose.a;
      fish.appear = Math.min(1, fish.appear + dt * 3.4);
      fish.flash = Math.max(0, fish.flash - dt * 3.6);
      const wiggleSpeed = 4 + Math.min(10, fish.speed / 42);
      fish.phase = (fish.phase + dt * wiggleSpeed) % 8;
      if (fish.fadeOut) {
        fish.dying += dt * 3.4;
        if (fish.dying > 1) this.fish.delete(id);
      } else if (Math.abs(fish.x) > GAME_WIDTH + 400 || fish.y < -360 || fish.y > GAME_HEIGHT + 360) {
        fish.fadeOut = true;
      }
      if (fish.species?.special === 'bomb' && fish.hp <= 0) fish.fadeOut = true;
    }

    /* --- projectiles --- */
    for (const [id, p] of this.projectiles) {
      if (p.dead) {
        this.projectiles.delete(id);
        continue;
      }
      const step = dt;
      p.x += p.vx * step;
      p.y += p.vy * step;
      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > 6) p.trail.shift();
      if (this.quality > 0.7) this.particles.trailSmoke(p.x, p.y, p.level);
      const age = (this.serverNow - p.t0) / 1000;
      if (age > p.ttl || p.x < -100 || p.x > GAME_WIDTH + 100 || p.y < -100 || p.y > GAME_HEIGHT + 200) {
        p.dead = true;
        if (p.owner === this.localId && !this.practice) this.fishOnMiss(p);
      }
      if (p.owner === this.localId) this.practiceCollision(p);
    }

    if (this.practice) this.practiceTick(dt);

    this.particles.step(dt, { w: GAME_WIDTH, h: GAME_HEIGHT });

    // Ambient bubbles from the sea floor keep the scene alive.
    if (this.quality > 0.5 && Math.random() < dt * 7) {
      this.particles.bubbles(Math.random() * GAME_WIDTH, GAME_HEIGHT - 40, 2, 60);
    }

    for (const player of this.players.values()) {
      player.shownAngle = lerpAngle(player.shownAngle, player.angle, Math.min(1, dt * 16));
      player.recoil = player.id === this.localId ? this.recoil : Math.max(0, player.recoil - dt * 4);
    }

    for (let i = this.floats.length - 1; i >= 0; i -= 1) {
      const f = this.floats[i]!;
      f.life += dt;
      f.y += f.vy * dt;
      f.vy *= 0.985;
      if (f.life >= f.ttl) this.floats.splice(i, 1);
    }

    this.stats.fish = this.fish.size;
    this.stats.projectiles = this.projectiles.size;
    this.stats.particles = this.particles.activeCount;
    this.stats.fps = fps;
    this.stats.quality = this.quality;
    this.stats.combo = this.combo;
    this.stats.comboMultiplier = this.comboMultiplier();
    if (now % 500 < 20) this.callbacks.onStats?.({ ...this.stats });

    this.render(dt);
  }

  private fishOnMiss(_projectile: WorldProjectile): void {
    // A shot that expired without a server hit is a miss: nothing to undo,
    // the wager was already taken by the server when the shot was accepted.
  }

  /** Practice-mode-only collision, so offline play still feels complete. */
  private practiceCollision(p: WorldProjectile): void {
    if (!this.practice) return;
    for (const fish of this.fish.values()) {
      if (fish.dying > 0 || fish.fadeOut) continue;
      const dx = p.x - fish.x;
      const dy = p.y - fish.y;
      const rr = p.radius + fish.radius;
      if (dx * dx + dy * dy > rr * rr) continue;
      p.dead = true;
      fish.hp -= Math.max(1, this.cannonLevel);
      fish.flash = 1;
      this.particles.hitSparks(p.x, p.y, 4, 45);
      this.audioCue('hit', 0.5);
      if (fish.hp <= 0) {
        fish.dying = 0.001;
        const reward = fish.species?.reward ?? 2;
        this.stats.kills += 1;
        this.stats.rewarded += reward;
        this.registerCombo();
        this.addFloat(fish.x, fish.y - 10, `+${reward}`, 'reward', 44);
        this.particles.defeatBurst(fish.x, fish.y, fish.radius, hueFor(fish.species), false);
        this.audioCue('kill', 0.7);
        this.audioCue('reward', 0.5);
      }
      return;
    }
  }

  private registerCombo(): void {
    const now = performance.now();
    this.combo = now - this.comboAt < 2600 ? this.combo + 1 : 1;
    this.comboAt = now;
    if (this.combo === 5 || this.combo === 10 || this.combo === 15) {
      this.addFloat(this.cannonX, this.cannonY - 150, `${this.combo} CHAIN`, 'combo', 40);
      this.audioCue('level', 0.5);
    }
  }

  /**
   * Presentation-only combo meter. It multiplies nothing: rewards are computed
   * by the server from the configured economy, and this streak display exists
   * purely so consecutive kills read as satisfying.
   */
  comboMultiplier(): number {
    return 1;
  }

  private addFloat(x: number, y: number, text: string, kind: FloatText['kind'], size: number): void {
    this.floats.push({
      id: this.nextFloatId++,
      x,
      y,
      vy: -70 - Math.min(60, size * 0.6),
      life: 0,
      ttl: kind === 'boss' ? 2.1 : 1.35,
      text,
      kind,
      size,
    });
  }

  private audioCue(name: 'shot' | 'hit' | 'kill' | 'bossKill' | 'reward' | 'error' | 'wave' | 'level', intensity: number): void {
    this.callbacks.onSound?.(name, intensity);
  }

  /* --------------------------------- render --------------------------------- */

  private render(dt: number): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const rc = this.renderer.resize(canvas.clientWidth || 960, canvas.clientHeight || 540, this.quality > 0.6 ? 2 : 1.5);
    const { ctx } = rc;
    const cameraX = Math.sin(this.time * 0.1) * 12;

    this.renderer.begin(rc, dt);
    this.renderer.drawBackground(rc, cameraX);
    this.renderer.drawKelp(rc);

    this.renderer.applyShake(rc, this.shake, this.time * 60);

    // Fish behind the projectiles, sorted so bigger ones read as nearer.
    const list = [...this.fish.values()].sort((a, b) => a.radius - b.radius);
    for (const fish of list) {
      this.renderer.drawFish(rc, {
        x: fish.x,
        y: fish.y,
        angle: fish.angle,
        key: fish.key,
        species: fish.species,
        hp: fish.hp,
        mhp: fish.mhp,
        flash: fish.flash,
        appear: fish.appear - fish.dying,
        phase: fish.phase,
        radius: fish.radius * (1 - fish.dying * 0.24),
      });
    }

    for (const p of this.projectiles.values()) {
      if (this.quality > 0.55 && p.trail.length > 1) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = p.mine ? 'rgba(90,225,255,0.28)' : 'rgba(255,180,90,0.22)';
        ctx.lineWidth = 3 + p.level * 1.4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.trail[0]!.x, p.trail[0]!.y);
        for (const point of p.trail) ctx.lineTo(point.x, point.y);
        ctx.stroke();
        ctx.restore();
      }
      drawProjectile(ctx, { x: p.x, y: p.y, angle: p.angle, level: p.level, mine: p.mine });
    }

    this.particles.draw(ctx, this.quality);

    // Players' cannons (local one last, so it is never occluded).
    for (const player of this.players.values()) {
      if (player.isLocal) continue;
      drawCannon(ctx, {
        x: player.x,
        y: player.y,
        angle: player.shownAngle,
        level: player.cannonLevel,
        recoil: player.recoil,
        color: '#5f8fae',
        accent: 'rgba(150,220,255,0.8)',
        local: false,
      });
      ctx.save();
      ctx.font = '600 15px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(210,240,255,0.72)';
      ctx.fillText(player.username.slice(0, 14), player.x, player.y + 62);
      ctx.restore();
    }

    const me = this.players.get(this.localId);
    drawCannon(ctx, {
      x: this.cannonX,
      y: this.cannonY,
      angle: me ? me.shownAngle : this.aimAngle,
      level: this.cannonLevel,
      recoil: this.recoil,
      color: this.cannonColor,
      accent: 'rgba(190,250,255,0.92)',
      local: true,
      aimAssist: this.quality > 0.5 ? 1500 : 0,
    });

    this.drawReticle(rc);
    this.drawFloats(rc);

    const boss = list.find((f) => f.boss && f.dying === 0);
    if (boss) this.renderer.drawBossBar(rc, boss, boss.species?.name ?? 'Boss');

    this.renderer.restoreShake(rc, this.shake);

    if (this.flash > 0.01) {
      ctx.save();
      ctx.globalAlpha = this.flash * 0.5;
      ctx.fillStyle = '#fff3c4';
      ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
      ctx.restore();
    }

    this.renderer.drawForeground(rc, cameraX);
    this.renderer.drawPost(rc);
    this.renderer.end(rc);
  }

  private drawReticle(rc: RenderContext): void {
    const ctx = rc.ctx;
    const angle = this.aimAngle;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = 'rgba(140,240,255,0.9)';
    ctx.lineWidth = 2;
    const len = 1450;
    const ex = this.cannonX + Math.cos(angle) * len;
    const ey = this.cannonY + Math.sin(angle) * len;
    ctx.setLineDash([3, 16]);
    ctx.beginPath();
    ctx.moveTo(this.cannonX + Math.cos(angle) * 70, this.cannonY + Math.sin(angle) * 70);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(ex, ey, 13, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ex - 20, ey);
    ctx.lineTo(ex - 6, ey);
    ctx.moveTo(ex + 6, ey);
    ctx.lineTo(ex + 20, ey);
    ctx.stroke();
    ctx.restore();
  }

  private drawFloats(rc: RenderContext): void {
    const ctx = rc.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    for (const f of this.floats) {
      const t = f.life / f.ttl;
      const alpha = t < 0.12 ? t / 0.12 : 1 - Math.max(0, (t - 0.55) / 0.45);
      const scale = f.kind === 'boss' ? 1 + Math.sin(Math.min(1, t * 2.4) * Math.PI) * 0.35 : 1;
      ctx.globalAlpha = Math.max(0, alpha);
      const size = f.size * scale * (1 - t * 0.12);
      ctx.font = `900 ${size}px "Rajdhani", "Chakra Petch", system-ui, sans-serif`;
      const color =
        f.kind === 'reward' ? '#ffd166' : f.kind === 'boss' ? '#ffe9a8' : f.kind === 'combo' ? '#3ef2c0' : f.kind === 'cost' ? '#ff9d7a' : '#cdeeff';
      ctx.lineWidth = Math.max(3, size * 0.14);
      ctx.strokeStyle = 'rgba(2,12,20,0.85)';
      ctx.strokeText(f.text, f.x, f.y);
      ctx.fillStyle = color;
      ctx.fillText(f.text, f.x, f.y);
      if (f.kind === 'boss') {
        ctx.globalAlpha = alpha * 0.35;
        ctx.shadowBlur = 24;
        ctx.shadowColor = '#ffd166';
        ctx.fillText(f.text, f.x, f.y);
        ctx.shadowBlur = 0;
      }
    }
    ctx.restore();
  }
}

function hueFor(species: FishConfig | undefined): number {
  if (!species) return 190;
  switch (species.category) {
    case 'SPECIAL_GOLDEN':
      return 46;
    case 'SPECIAL_TREASURE':
      return 172;
    case 'SPECIAL_BOMB':
      return 22;
    case 'SPECIAL_SPEED':
      return 160;
    case 'BOSS':
      return 262;
    case 'RARE':
      return 208;
    case 'LARGE':
      return 148;
    default:
      return 192;
  }
}
