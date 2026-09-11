/**
 * Pooled particle system.
 *
 * A single fixed-size ring buffer is used for every particle type (bubbles,
 * sparks, debris, coins, shockwave rings). Nothing is allocated per frame, so
 * a burst of kills on a mid-range phone does not trigger GC hitches.
 */

export type ParticleKind = 'bubble' | 'spark' | 'debris' | 'coin' | 'ring' | 'smoke' | 'star';

export interface Particle {
  active: boolean;
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
  size: number;
  rot: number;
  spin: number;
  hue: number;
  drag: number;
  gravity: number;
}

const TAU = Math.PI * 2;

/**
 * Hard ceiling on per-effect particle counts. A misconfigured fish (huge `size`
 * or `reward`) must never be able to freeze the browser by asking for a
 * million-particle burst, so every count is clamped here at the source.
 */
function clampCount(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, Math.round(value)));
}

function clampSize(value: number): number {
  if (!Number.isFinite(value)) return 4;
  return Math.max(0.5, Math.min(320, value));
}

export class ParticleSystem {
  private pool: Particle[] = [];
  private cursor = 0;

  constructor(private readonly capacity = 900) {
    for (let i = 0; i < capacity; i += 1) {
      this.pool.push({
        active: false,
        kind: 'spark',
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        life: 0,
        ttl: 1,
        size: 1,
        rot: 0,
        spin: 0,
        hue: 190,
        drag: 0.98,
        gravity: 0,
      });
    }
  }

  get activeCount(): number {
    let n = 0;
    for (const p of this.pool) if (p.active) n += 1;
    return n;
  }

  private acquire(): Particle {
    // Ring-buffer allocation: when saturated the oldest particle is recycled,
    // which bounds memory and CPU regardless of what the game throws at it.
    for (let i = 0; i < this.capacity; i += 1) {
      const p = this.pool[this.cursor]!;
      this.cursor = (this.cursor + 1) % this.capacity;
      if (!p.active) return p;
    }
    const p = this.pool[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.capacity;
    return p;
  }

  emit(config: Partial<Particle> & { kind: ParticleKind; x: number; y: number }): void {
    const p = this.acquire();
    p.active = true;
    p.kind = config.kind;
    p.x = config.x;
    p.y = config.y;
    p.vx = config.vx ?? 0;
    p.vy = config.vy ?? 0;
    p.life = 0;
    p.ttl = config.ttl ?? 0.8;
    p.size = config.size ?? 6;
    p.rot = config.rot ?? Math.random() * TAU;
    p.spin = config.spin ?? 0;
    p.hue = config.hue ?? 190;
    p.drag = config.drag ?? 0.98;
    p.gravity = config.gravity ?? 0;
  }

  bubbles(x: number, y: number, count = 6, spread = 26): void {
    const n = clampCount(count, 48);
    for (let i = 0; i < n; i += 1) {
      this.emit({
        kind: 'bubble',
        x: x + (Math.random() - 0.5) * spread,
        y: y + (Math.random() - 0.5) * spread,
        vx: (Math.random() - 0.5) * 26,
        vy: -50 - Math.random() * 90,
        ttl: 0.7 + Math.random() * 1.1,
        size: 1.6 + Math.random() * 4.4,
        drag: 0.995,
        gravity: -14,
      });
    }
  }

  hitSparks(x: number, y: number, damage: number, hue = 45): void {
    const count = clampCount(6 + damage / 2, 24);
    for (let i = 0; i < count; i += 1) {
      const a = Math.random() * TAU;
      const speed = 90 + Math.random() * 300;
      this.emit({
        kind: 'spark',
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed * 0.8,
        ttl: 0.2 + Math.random() * 0.25,
        size: 1.6 + Math.random() * 3.2,
        hue,
        drag: 0.9,
        gravity: 140,
      });
    }
    this.emit({ kind: 'ring', x, y, ttl: 0.28, size: 12, hue, drag: 1, gravity: 0 });
  }

  defeatBurst(x: number, y: number, scale: number, hue: number, gold: boolean): void {
    const sparks = clampCount(10 + scale / 3, 30);
    for (let i = 0; i < sparks; i += 1) {
      const a = Math.random() * TAU;
      const speed = (120 + Math.random() * 340) * (0.6 + scale / 120);
      this.emit({
        kind: 'spark',
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        ttl: 0.28 + Math.random() * 0.34,
        size: clampSize(2 + Math.random() * 4),
        hue: gold ? 45 : hue,
        drag: 0.9,
        gravity: 180,
      });
    }
    const debris = clampCount(6 + scale / 8, 16);
    for (let i = 0; i < debris; i += 1) {
      const a = Math.random() * TAU;
      this.emit({
        kind: 'debris',
        x,
        y,
        vx: Math.cos(a) * (60 + Math.random() * 190),
        vy: Math.sin(a) * (60 + Math.random() * 150) - 40,
        ttl: 0.6 + Math.random() * 0.6,
        size: clampSize(3 + Math.random() * (scale / 12)),
        rot: Math.random() * TAU,
        spin: (Math.random() - 0.5) * 9,
        hue: gold ? 45 : hue,
        drag: 0.96,
        gravity: 240,
      });
    }
    this.bubbles(x, y, clampCount(8 + scale / 6, 24), clampSize(scale));
    this.emit({ kind: 'ring', x, y, ttl: 0.42, size: clampSize(Math.max(20, scale * 1.3)), hue: gold ? 45 : hue });
    if (gold) {
      for (let i = 0; i < 8; i += 1) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
        this.emit({
          kind: 'coin',
          x,
          y,
          vx: Math.cos(a) * (70 + Math.random() * 150),
          vy: Math.sin(a) * (150 + Math.random() * 120),
          ttl: 0.9 + Math.random() * 0.4,
          size: 7 + Math.random() * 5,
          rot: Math.random() * TAU,
          spin: (Math.random() - 0.5) * 14,
          hue: 45,
          drag: 0.99,
          gravity: 420,
        });
      }
    }
  }

  explosion(x: number, y: number, radius: number): void {
    const r = clampSize(radius);
    this.emit({ kind: 'ring', x, y, ttl: 0.55, size: r, hue: 28 });
    this.emit({ kind: 'ring', x, y, ttl: 0.75, size: r * 1.5, hue: 45 });
    for (let i = 0; i < 40; i += 1) {
      const a = Math.random() * TAU;
      const speed = 140 + Math.random() * 520;
      this.emit({
        kind: 'spark',
        x,
        y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        ttl: 0.3 + Math.random() * 0.4,
        size: 2 + Math.random() * 5,
        hue: 20 + Math.random() * 40,
        drag: 0.9,
        gravity: 90,
      });
    }
    for (let i = 0; i < 16; i += 1) {
      const a = Math.random() * TAU;
      this.emit({
        kind: 'smoke',
        x: x + Math.cos(a) * 20,
        y: y + Math.sin(a) * 20,
        vx: Math.cos(a) * (40 + Math.random() * 90),
        vy: Math.sin(a) * (30 + Math.random() * 70) - 30,
        ttl: 0.7 + Math.random() * 0.7,
        size: 22 + Math.random() * 40,
        hue: 30,
        drag: 0.94,
        gravity: -20,
      });
    }
  }

  muzzle(x: number, y: number, angle: number, level: number): void {
    for (let i = 0; i < 5 + level; i += 1) {
      const a = angle + (Math.random() - 0.5) * 0.7;
      const speed = 120 + Math.random() * 260;
      this.emit({
        kind: 'smoke',
        x: x + Math.cos(angle) * 34,
        y: y + Math.sin(angle) * 34,
        vx: Math.cos(a) * speed * 0.4,
        vy: Math.sin(a) * speed * 0.4,
        ttl: 0.22 + Math.random() * 0.2,
        size: 8 + Math.random() * 12 + level * 2,
        hue: 188,
        drag: 0.9,
        gravity: -30,
      });
    }
    for (let i = 0; i < 4 + level; i += 1) {
      const a = angle + (Math.random() - 0.5) * 0.5;
      this.emit({
        kind: 'spark',
        x: x + Math.cos(angle) * 30,
        y: y + Math.sin(angle) * 30,
        vx: Math.cos(a) * (200 + Math.random() * 320),
        vy: Math.sin(a) * (200 + Math.random() * 320),
        ttl: 0.12 + Math.random() * 0.12,
        size: 1.6 + Math.random() * 2.4,
        hue: 176,
        drag: 0.88,
      });
    }
    this.bubbles(x + Math.cos(angle) * 26, y + Math.sin(angle) * 26, 3, 14);
  }

  trailSmoke(x: number, y: number, level: number): void {
    this.emit({
      kind: 'bubble',
      x,
      y,
      vx: (Math.random() - 0.5) * 18,
      vy: -8 - Math.random() * 18,
      ttl: 0.28 + Math.random() * 0.22,
      size: 1.2 + Math.random() * (1.6 + level * 0.4),
      drag: 0.98,
    });
  }

  step(dt: number, bounds: { w: number; h: number }): void {
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life += dt;
      if (p.life >= p.ttl) {
        p.active = false;
        continue;
      }
      p.vy += p.gravity * dt;
      const drag = Math.pow(p.drag, dt * 60);
      p.vx *= drag;
      p.vy *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      if (p.kind === 'bubble') {
        p.x += Math.sin((p.life + p.y) * 6) * 12 * dt;
        if (p.y < -20) p.active = false;
      }
      if (p.x < -80 || p.x > bounds.w + 80 || p.y > bounds.h + 120) p.active = false;
    }
  }

  draw(ctx: CanvasRenderingContext2D, quality: number): void {
    const drawGlow = quality > 0.45;
    ctx.save();
    for (const p of this.pool) {
      if (!p.active) continue;
      const t = p.life / p.ttl;
      const fade = 1 - t;
      switch (p.kind) {
        case 'bubble': {
          const r = p.size * (1 + t * 0.5);
          ctx.globalAlpha = 0.5 * fade;
          ctx.strokeStyle = `hsla(190,90%,80%,${0.75 * fade})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = 0.32 * fade;
          ctx.fillStyle = 'rgba(210,245,255,0.6)';
          ctx.beginPath();
          ctx.arc(p.x - r * 0.3, p.y - r * 0.34, r * 0.3, 0, TAU);
          ctx.fill();
          break;
        }
        case 'spark': {
          ctx.globalAlpha = Math.min(1, fade * 1.6);
          ctx.fillStyle = `hsl(${p.hue},100%,${68 - t * 22}%)`;
          if (drawGlow) {
            ctx.shadowBlur = 10;
            ctx.shadowColor = `hsl(${p.hue},100%,60%)`;
          }
          const s = p.size * (1 - t * 0.5);
          ctx.beginPath();
          ctx.arc(p.x, p.y, s, 0, TAU);
          ctx.fill();
          ctx.shadowBlur = 0;
          break;
        }
        case 'debris': {
          ctx.globalAlpha = fade;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = `hsl(${p.hue},70%,${58 - t * 20}%)`;
          const s = p.size * (1 - t * 0.35);
          ctx.beginPath();
          ctx.moveTo(-s, -s * 0.6);
          ctx.lineTo(s, -s * 0.2);
          ctx.lineTo(s * 0.5, s * 0.7);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'coin': {
          ctx.globalAlpha = Math.min(1, fade * 2);
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          const squish = Math.abs(Math.cos(p.rot * 1.6));
          ctx.scale(Math.max(0.18, squish), 1);
          const g = ctx.createLinearGradient(0, -p.size, 0, p.size);
          g.addColorStop(0, '#fff2c2');
          g.addColorStop(0.5, '#ffc93c');
          g.addColorStop(1, '#d98b05');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(0, 0, p.size, 0, TAU);
          ctx.fill();
          ctx.strokeStyle = 'rgba(120,70,0,0.6)';
          ctx.lineWidth = 1.4;
          ctx.stroke();
          ctx.restore();
          break;
        }
        case 'ring': {
          const r = p.size * (0.25 + t * 1.5);
          ctx.globalAlpha = fade * 0.85;
          ctx.strokeStyle = `hsl(${p.hue},100%,72%)`;
          ctx.lineWidth = Math.max(1, 6 * fade);
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, TAU);
          ctx.stroke();
          break;
        }
        case 'smoke': {
          const r = p.size * (1 + t * 2.1);
          ctx.globalAlpha = 0.3 * fade;
          const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
          grad.addColorStop(0, `hsla(${p.hue},60%,72%,0.7)`);
          grad.addColorStop(1, `hsla(${p.hue},60%,40%,0)`);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, TAU);
          ctx.fill();
          break;
        }
        case 'star': {
          ctx.globalAlpha = fade;
          ctx.fillStyle = '#fff8e0';
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (1 - t), 0, TAU);
          ctx.fill();
          break;
        }
      }
    }
    ctx.restore();
  }

  clear(): void {
    for (const p of this.pool) p.active = false;
  }
}
