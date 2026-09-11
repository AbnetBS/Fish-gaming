import { GAME_HEIGHT, GAME_WIDTH, type FishConfig } from '@reef/shared';
import { createRng } from '@reef/shared';
import { paletteFor, type SpriteCache } from './Sprites.js';

/**
 * Underwater renderer.
 *
 * Everything is drawn into a fixed 1920x1080 *logical* space and then scaled to
 * the viewport with a `contain` fit, so the game looks identical on a phone in
 * landscape and on a 4K monitor. Static layers (rock, coral, sand) are baked
 * once into offscreen canvases and blitted with a small parallax offset; only
 * genuinely animated things (rays, caustics, kelp sway, plankton) are drawn per
 * frame, which is what keeps the frame cost low on mobile GPUs.
 */

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  /** Logical-space transform applied for this frame. */
  scale: number;
  offsetX: number;
  offsetY: number;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

interface CoralProp {
  kind: 'fan' | 'tube' | 'branch' | 'kelp' | 'rock' | 'anemone';
  x: number;
  y: number;
  scale: number;
  hue: number;
  seed: number;
  sway: number;
}

const TAU = Math.PI * 2;

export class Renderer {
  private bg: HTMLCanvasElement | null = null;
  private fg: HTMLCanvasElement | null = null;
  private props: CoralProp[] = [];
  private plankton: { x: number; y: number; r: number; sp: number; ph: number }[] = [];
  private time = 0;
  quality = 1;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly sprites: SpriteCache) {}

  /** Fit a logical GAME_WIDTH x GAME_HEIGHT view inside the CSS box. */
  resize(cssWidth: number, cssHeight: number, dprCap = 2): RenderContext {
    const dpr = Math.min(Math.max(1, window.devicePixelRatio || 1), dprCap);
    const scale = Math.min(cssWidth / GAME_WIDTH, cssHeight / GAME_HEIGHT);
    const logicalW = GAME_WIDTH * scale;
    const logicalH = GAME_HEIGHT * scale;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    const ctx = this.canvas.getContext('2d', { alpha: false })!;
    if (!this.bg) this.buildLayers();
    return {
      ctx,
      scale,
      offsetX: (cssWidth - logicalW) / 2,
      offsetY: (cssHeight - logicalH) / 2,
      cssWidth,
      cssHeight,
      dpr,
    };
  }

  get context(): CanvasRenderingContext2D | null {
    return this.canvas.getContext('2d');
  }

  /* ------------------------------ static layers ------------------------------ */

  private buildLayers(): void {
    const rng = createRng(0x5ea5);

    const bg = document.createElement('canvas');
    bg.width = GAME_WIDTH;
    bg.height = GAME_HEIGHT;
    const b = bg.getContext('2d')!;

    // Water column.
    const water = b.createLinearGradient(0, 0, 0, GAME_HEIGHT);
    water.addColorStop(0, '#0a4a6e');
    water.addColorStop(0.28, '#073554');
    water.addColorStop(0.66, '#04202f');
    water.addColorStop(1, '#020e16');
    b.fillStyle = water;
    b.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    // Surface shimmer band.
    const surface = b.createLinearGradient(0, 0, 0, 150);
    surface.addColorStop(0, 'rgba(180,240,255,0.32)');
    surface.addColorStop(1, 'rgba(180,240,255,0)');
    b.fillStyle = surface;
    b.fillRect(0, 0, GAME_WIDTH, 150);

    // Distant rock formations (three parallax ridges).
    for (const [depth, color, height] of [
      [0.34, 'rgba(8,44,66,0.75)', 250],
      [0.55, 'rgba(6,32,48,0.85)', 190],
      [0.8, 'rgba(3,20,31,0.95)', 130],
    ] as const) {
      b.fillStyle = color;
      b.beginPath();
      b.moveTo(0, GAME_HEIGHT);
      let x = 0;
      let y = GAME_HEIGHT - height;
      b.lineTo(0, y);
      while (x < GAME_WIDTH) {
        const step = 60 + rng() * 130;
        x += step;
        y = GAME_HEIGHT - height * (0.55 + rng() * 0.75);
        b.quadraticCurveTo(x - step / 2, y - 40 * depth, x, y);
      }
      b.lineTo(GAME_WIDTH, GAME_HEIGHT);
      b.closePath();
      b.fill();
    }

    // Sea floor.
    const floorY = GAME_HEIGHT - 116;
    const sand = b.createLinearGradient(0, floorY - 30, 0, GAME_HEIGHT);
    sand.addColorStop(0, '#1d4a5e');
    sand.addColorStop(0.25, '#2c5f6b');
    sand.addColorStop(1, '#0c2230');
    b.fillStyle = sand;
    b.beginPath();
    b.moveTo(0, GAME_HEIGHT);
    b.lineTo(0, floorY + 14);
    for (let x = 0; x <= GAME_WIDTH; x += 48) {
      b.quadraticCurveTo(x + 24, floorY + 14 + Math.sin(x * 0.01) * 12 - rng() * 8, x + 48, floorY + 14 + Math.sin((x + 48) * 0.01) * 12);
    }
    b.lineTo(GAME_WIDTH, GAME_HEIGHT);
    b.closePath();
    b.fill();

    // Sand speckles + small stones.
    for (let i = 0; i < 620; i += 1) {
      const x = rng() * GAME_WIDTH;
      const y = floorY + 18 + rng() * (GAME_HEIGHT - floorY - 18);
      b.fillStyle = `rgba(210,240,250,${0.03 + rng() * 0.12})`;
      b.fillRect(x, y, 1 + rng() * 2.2, 1 + rng() * 1.6);
    }
    for (let i = 0; i < 26; i += 1) {
      const x = rng() * GAME_WIDTH;
      const y = floorY + 26 + rng() * 66;
      const r = 8 + rng() * 22;
      b.fillStyle = 'rgba(6,22,32,0.5)';
      b.beginPath();
      b.ellipse(x, y, r, r * 0.5, 0, 0, TAU);
      b.fill();
      b.fillStyle = 'rgba(150,200,215,0.14)';
      b.beginPath();
      b.ellipse(x - r * 0.2, y - r * 0.25, r * 0.6, r * 0.28, 0, 0, TAU);
      b.fill();
    }

    // Wrecks / arches give the arena a landmark without copying anyone's art.
    this.drawArch(b, GAME_WIDTH * 0.2, floorY + 34, 150, rng);
    this.drawArch(b, GAME_WIDTH * 0.78, floorY + 40, 116, rng);

    // Props: coral clusters (static part goes in bg, swaying part in fg).
    this.props = [];
    const count = 34;
    for (let i = 0; i < count; i += 1) {
      const side = rng();
      const kind: CoralProp['kind'] = side < 0.2 ? 'fan' : side < 0.42 ? 'tube' : side < 0.62 ? 'branch' : side < 0.84 ? 'rock' : 'anemone';
      const prop: CoralProp = {
        kind,
        x: 40 + rng() * (GAME_WIDTH - 80),
        y: floorY + 8 + rng() * 46,
        scale: 0.55 + rng() * 0.85,
        hue: Math.floor(rng() * 360),
        seed: Math.floor(rng() * 10000),
        sway: 0.4 + rng() * 0.8,
      };
      this.props.push(prop);
      this.drawProp(b, prop, 0, true);
    }
    this.bg = bg;

    // Foreground: out-of-focus coral silhouettes for depth + kelp that sways.
    const fg = document.createElement('canvas');
    fg.width = GAME_WIDTH;
    fg.height = GAME_HEIGHT;
    const f = fg.getContext('2d')!;
    const fgProps: CoralProp[] = [];
    for (let i = 0; i < 7; i += 1) {
      fgProps.push({
        kind: i % 2 === 0 ? 'branch' : 'fan',
        x: i % 2 === 0 ? -30 + rng() * 260 : GAME_WIDTH - 230 + rng() * 260,
        y: GAME_HEIGHT - 8 - rng() * 40,
        scale: 1.5 + rng() * 0.9,
        hue: Math.floor(rng() * 360),
        seed: Math.floor(rng() * 10000),
        sway: 0.5 + rng() * 0.6,
      });
    }
    for (const prop of fgProps) {
      f.save();
      f.globalAlpha = 0.82;
      f.filter = 'blur(2px)';
      this.drawProp(f, prop, 0, true);
      f.restore();
    }
    this.fg = fg;

    // Kelp is drawn live so it can sway.
    this.kelp = [];
    for (let i = 0; i < 16; i += 1) {
      this.kelp.push({
        x: 30 + rng() * (GAME_WIDTH - 60),
        y: floorY + 20,
        h: 160 + rng() * 380,
        w: 8 + rng() * 14,
        ph: rng() * TAU,
        sp: 0.4 + rng() * 0.5,
        hue: 150 + rng() * 50,
      });
    }

    this.plankton = [];
    const planktonCount = 110;
    for (let i = 0; i < planktonCount; i += 1) {
      this.plankton.push({
        x: rng() * GAME_WIDTH,
        y: rng() * GAME_HEIGHT,
        r: 0.6 + rng() * 2.4,
        sp: 4 + rng() * 22,
        ph: rng() * TAU,
      });
    }
  }

  private kelp: { x: number; y: number; h: number; w: number; ph: number; sp: number; hue: number }[] = [];

  private drawArch(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, rng: () => number): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(9,38,54,0.9)';
    ctx.strokeStyle = 'rgba(120,190,220,0.12)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-size, 0);
    ctx.lineTo(-size * 0.86, -size * 1.05);
    ctx.quadraticCurveTo(0, -size * 1.7, size * 0.86, -size * 1.05);
    ctx.lineTo(size, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.moveTo(-size * 0.5, 0);
    ctx.quadraticCurveTo(0, -size * 1.05, size * 0.5, 0);
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 12; i += 1) {
      ctx.fillStyle = `rgba(160,220,240,${0.03 + rng() * 0.06})`;
      ctx.fillRect(-size + rng() * size * 2, -rng() * size * 1.5, 6 + rng() * 16, 2 + rng() * 4);
    }
    ctx.restore();
  }

  private drawProp(ctx: CanvasRenderingContext2D, prop: CoralProp, sway: number, isBg: boolean): void {
    const rng = createRng(prop.seed);
    ctx.save();
    ctx.translate(prop.x, prop.y);
    ctx.scale(prop.scale, prop.scale);
    const light = isBg ? 0.62 : 0.9;
    switch (prop.kind) {
      case 'fan': {
        const grad = ctx.createLinearGradient(0, 0, 0, -150);
        grad.addColorStop(0, `hsla(${prop.hue},55%,${18 * light + 8}%,0.95)`);
        grad.addColorStop(1, `hsla(${prop.hue},72%,${44 * light + 10}%,0.85)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(-4, 0);
        for (let i = 0; i <= 16; i += 1) {
          const a = Math.PI + (i / 16) * Math.PI;
          const r = 78 + Math.sin(i * 2.1) * 16;
          ctx.lineTo(Math.cos(a) * r + sway * 8, Math.sin(a) * r * 0.92);
        }
        ctx.lineTo(4, 0);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = `hsla(${prop.hue},80%,70%,0.25)`;
        ctx.lineWidth = 1.6;
        for (let i = 1; i < 8; i += 1) {
          ctx.beginPath();
          ctx.moveTo(0, -4);
          ctx.lineTo(Math.cos(Math.PI + (i / 8) * Math.PI) * 74 + sway * 8, Math.sin(Math.PI + (i / 8) * Math.PI) * 68);
          ctx.stroke();
        }
        break;
      }
      case 'tube': {
        for (let i = 0; i < 5; i += 1) {
          const h = 60 + rng() * 90;
          const w = 16 + rng() * 12;
          const x = -46 + i * 22 + rng() * 8;
          const grad = ctx.createLinearGradient(x, 0, x, -h);
          grad.addColorStop(0, `hsla(${prop.hue},50%,${14 * light + 6}%,1)`);
          grad.addColorStop(1, `hsla(${prop.hue},88%,${56 * light + 12}%,0.95)`);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(x - w / 2, 4);
          ctx.quadraticCurveTo(x - w / 2 + sway * 6, -h * 0.6, x - w / 2 + sway * 10, -h);
          ctx.lineTo(x + w / 2 + sway * 10, -h);
          ctx.quadraticCurveTo(x + w / 2 + sway * 6, -h * 0.6, x + w / 2, 4);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = `hsla(${prop.hue},90%,${70 * light + 10}%,0.7)`;
          ctx.beginPath();
          ctx.ellipse(x + sway * 10, -h, w / 2, w / 5, 0, 0, TAU);
          ctx.fill();
        }
        break;
      }
      case 'branch': {
        const branch = (x: number, y: number, angle: number, len: number, depth: number): void => {
          if (depth <= 0 || len < 8) return;
          const nx = x + Math.cos(angle) * len;
          const ny = y + Math.sin(angle) * len;
          ctx.strokeStyle = `hsla(${prop.hue},60%,${28 * light + 8}%,0.95)`;
          ctx.lineWidth = depth * 2.4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(nx, ny);
          ctx.stroke();
          if (depth === 1) {
            ctx.fillStyle = `hsla(${(prop.hue + 40) % 360},90%,${62 * light + 12}%,0.9)`;
            ctx.beginPath();
            ctx.arc(nx, ny, 4.5, 0, TAU);
            ctx.fill();
          }
          branch(nx, ny, angle - 0.5 - rng() * 0.3 + sway * 0.06, len * 0.72, depth - 1);
          branch(nx, ny, angle + 0.5 + rng() * 0.3 + sway * 0.06, len * 0.7, depth - 1);
        };
        branch(0, 0, -Math.PI / 2, 46, 4);
        break;
      }
      case 'rock': {
        ctx.fillStyle = `hsla(${prop.hue},24%,${16 * light + 4}%,0.96)`;
        ctx.beginPath();
        ctx.moveTo(-50, 6);
        for (let i = 0; i <= 8; i += 1) {
          const a = Math.PI + (i / 8) * Math.PI;
          ctx.lineTo(Math.cos(a) * (46 + rng() * 12), Math.sin(a) * (26 + rng() * 14));
        }
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = `hsla(${prop.hue},30%,${40 * light + 10}%,0.25)`;
        ctx.beginPath();
        ctx.ellipse(-8, -18, 22, 8, -0.3, 0, TAU);
        ctx.fill();
        break;
      }
      case 'anemone':
      default: {
        ctx.fillStyle = `hsla(${prop.hue},70%,${20 * light + 6}%,0.9)`;
        ctx.beginPath();
        ctx.ellipse(0, -6, 34, 14, 0, 0, TAU);
        ctx.fill();
        for (let i = 0; i < 22; i += 1) {
          const a = Math.PI + (i / 21) * Math.PI;
          const len = 26 + Math.sin(i * 1.7) * 10;
          ctx.strokeStyle = `hsla(${(prop.hue + 20) % 360},88%,${64 * light + 12}%,0.85)`;
          ctx.lineWidth = 3.4;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * 24, -8);
          ctx.lineTo(Math.cos(a) * 24 + Math.cos(a + sway) * len * 0.5, -8 + Math.sin(a) * len);
          ctx.stroke();
        }
        break;
      }
    }
    ctx.restore();
  }

  /* --------------------------------- frame --------------------------------- */

  begin(rc: RenderContext, dt: number): void {
    this.time += dt;
    const { ctx } = rc;
    ctx.setTransform(rc.dpr, 0, 0, rc.dpr, 0, 0);
    ctx.fillStyle = '#01080e';
    ctx.fillRect(0, 0, rc.cssWidth, rc.cssHeight);
    ctx.save();
    ctx.translate(rc.offsetX, rc.offsetY);
    ctx.scale(rc.scale, rc.scale);
    ctx.beginPath();
    ctx.rect(0, 0, GAME_WIDTH, GAME_HEIGHT);
    ctx.clip();
  }

  end(rc: RenderContext): void {
    const { ctx } = rc;
    ctx.restore();
    void rc;
  }

  /** Water column, rays, caustics, plankton, static coral. */
  drawBackground(rc: RenderContext, cameraX: number): void {
    const { ctx } = rc;
    if (this.bg) ctx.drawImage(this.bg, -cameraX * 0.06, 0);

    const t = this.time;

    // God rays.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 7; i += 1) {
      const base = (i / 7) * GAME_WIDTH + Math.sin(t * 0.11 + i) * 120 - cameraX * 0.1;
      const width = 120 + Math.sin(t * 0.3 + i * 2.1) * 46;
      const alpha = 0.05 + 0.045 * (0.5 + 0.5 * Math.sin(t * 0.42 + i * 1.3));
      const grad = ctx.createLinearGradient(base, 0, base + width * 0.7, GAME_HEIGHT * 0.92);
      grad.addColorStop(0, `rgba(190,240,255,${alpha * 1.5})`);
      grad.addColorStop(0.55, `rgba(120,210,255,${alpha * 0.5})`);
      grad.addColorStop(1, 'rgba(120,210,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(base - width * 0.25, -20);
      ctx.lineTo(base + width * 0.55, -20);
      ctx.lineTo(base + width * 1.9, GAME_HEIGHT);
      ctx.lineTo(base + width * 0.5, GAME_HEIGHT);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Caustic bands near the surface.
    if (this.quality > 0.4) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(190,245,255,0.16)';
      ctx.lineWidth = 3;
      for (let band = 0; band < 5; band += 1) {
        const y = 34 + band * 26;
        ctx.beginPath();
        for (let x = -40; x <= GAME_WIDTH + 40; x += 26) {
          const yy = y + Math.sin(x * 0.014 + t * (0.7 + band * 0.16) + band) * (9 + band * 3);
          if (x === -40) ctx.moveTo(x, yy);
          else ctx.lineTo(x, yy);
        }
        ctx.globalAlpha = 0.5 - band * 0.08;
        ctx.stroke();
      }
      ctx.restore();
    }

    // Drifting plankton.
    ctx.save();
    for (const p of this.plankton) {
      const x = (p.x + Math.sin(t * 0.3 + p.ph) * 26 + t * p.sp * 0.3) % (GAME_WIDTH + 40);
      const y = (p.y - t * p.sp * 0.14 + GAME_HEIGHT) % GAME_HEIGHT;
      ctx.globalAlpha = 0.14 + 0.2 * (0.5 + 0.5 * Math.sin(t * 1.6 + p.ph));
      ctx.fillStyle = '#cdf3ff';
      ctx.beginPath();
      ctx.arc(x - 20, y, p.r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  drawKelp(rc: RenderContext): void {
    const { ctx } = rc;
    const t = this.time;
    ctx.save();
    for (const k of this.kelp) {
      ctx.strokeStyle = `hsla(${k.hue},48%,26%,0.72)`;
      ctx.lineWidth = k.w;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(k.x, k.y);
      const segments = 6;
      for (let i = 1; i <= segments; i += 1) {
        const f = i / segments;
        const sway = Math.sin(t * k.sp + k.ph + f * 2.4) * 26 * f;
        ctx.lineTo(k.x + sway, k.y - k.h * f);
      }
      ctx.stroke();
      ctx.strokeStyle = `hsla(${k.hue},60%,40%,0.3)`;
      ctx.lineWidth = k.w * 0.4;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawFish(
    rc: RenderContext,
    fish: {
      x: number;
      y: number;
      angle: number;
      key: string;
      species: FishConfig | undefined;
      hp: number;
      mhp: number;
      flash: number;
      appear: number;
      phase: number;
      radius: number;
    },
  ): void {
    const sprite = this.sprites.get(fish.species);
    if (!sprite) return;
    const { ctx } = rc;
    const facing = Math.cos(fish.angle) >= 0 ? 1 : -1;
    const targetH = fish.radius * (fish.species?.category === 'BOSS' ? 1.5 : 2.05);
    const scale = targetH / sprite.frameHeight;
    const w = sprite.frameWidth * scale;
    const frame = Math.floor(fish.phase % SPRITE_FRAMES_COUNT) * sprite.frameWidth;

    ctx.save();
    ctx.translate(fish.x, fish.y);
    ctx.globalAlpha = Math.min(1, fish.appear / 0.45);

    // Depth shadow.
    ctx.save();
    ctx.globalAlpha *= 0.25;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(6, 12, w * 0.3, targetH * 0.22, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.scale(facing, 1);
    // When swimming left the sprite is mirrored; keep the body pitch subtle.
    const pitch = facing === 1 ? -fish.angle : Math.PI - fish.angle;
    ctx.rotate(facing === 1 ? -fish.angle * 0.5 : fish.angle * 0.5);
    void pitch;

    ctx.drawImage(sprite.canvas, frame, 0, sprite.frameWidth, sprite.frameHeight, -w / 2, -targetH / 2, w, targetH);

    if (fish.flash > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.85, fish.flash);
      ctx.drawImage(sprite.canvas, frame, 0, sprite.frameWidth, sprite.frameHeight, -w / 2, -targetH / 2, w, targetH);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();

    // Damage ring + health pips for tough fish.
    if (fish.mhp > 1 && fish.hp < fish.mhp) {
      const ratio = Math.max(0, fish.hp / fish.mhp);
      ctx.save();
      ctx.translate(fish.x, fish.y);
      ctx.strokeStyle = `hsla(${ratio > 0.5 ? 150 : ratio > 0.22 ? 45 : 350},95%,62%,0.85)`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, fish.radius + 10, -Math.PI / 2, -Math.PI / 2 + TAU * ratio);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawBossBar(rc: RenderContext, fish: { hp: number; mhp: number; species: FishConfig | undefined } | null, label: string): void {
    if (!fish) return;
    const { ctx } = rc;
    const w = 760;
    const x = (GAME_WIDTH - w) / 2;
    const y = 96;
    const ratio = Math.max(0, Math.min(1, fish.hp / fish.mhp));
    const pal = paletteFor(fish.species);
    ctx.save();
    ctx.fillStyle = 'rgba(2,12,20,0.72)';
    ctx.beginPath();
    ctx.roundRect(x - 12, y - 26, w + 24, 60, 16);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,183,3,0.5)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.font = '700 18px Inter, system-ui, sans-serif';
    ctx.fillStyle = '#ffe9b8';
    ctx.textAlign = 'left';
    ctx.fillText(label.toUpperCase(), x, y - 6);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,233,184,0.75)';
    ctx.fillText(`${Math.max(0, Math.ceil(fish.hp))} / ${fish.mhp}`, x + w, y - 6);
    ctx.textAlign = 'left';

    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.roundRect(x, y + 2, w, 16, 8);
    ctx.fill();
    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, pal.accent);
    grad.addColorStop(1, '#ff7a59');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, y + 2, Math.max(6, w * ratio), 16, 8);
    ctx.fill();
    ctx.restore();
  }

  drawForeground(rc: RenderContext, cameraX: number): void {
    if (!this.fg) return;
    const { ctx } = rc;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this.fg, -cameraX * 0.2, 0);
    ctx.restore();
  }

  /** Vignette + arcade glass. Cheap: uses cached gradients. */
  drawPost(rc: RenderContext): void {
    const { ctx } = rc;
    if (!this.vignette) {
      const v = document.createElement('canvas');
      v.width = 64;
      v.height = 64;
      const vc = v.getContext('2d')!;
      const g = vc.createRadialGradient(32, 30, 8, 32, 32, 44);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.62, 'rgba(0,0,0,0.16)');
      g.addColorStop(1, 'rgba(0,0,0,0.62)');
      vc.fillStyle = g;
      vc.fillRect(0, 0, 64, 64);
      this.vignette = v;
    }
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.drawImage(this.vignette, 0, 0, GAME_WIDTH, GAME_HEIGHT);
    if (this.quality > 0.6) {
      ctx.globalAlpha = 0.05;
      ctx.fillStyle = '#9fd8ff';
      for (let y = 0; y < GAME_HEIGHT; y += 4) ctx.fillRect(0, y, GAME_WIDTH, 1);
    }
    ctx.restore();
  }

  private vignette: HTMLCanvasElement | null = null;

  /** Screen shake helper: caller translates before drawing entities. */
  applyShake(rc: RenderContext, magnitude: number, seed: number): void {
    if (magnitude <= 0.01) return;
    const { ctx } = rc;
    ctx.save();
    ctx.translate(Math.sin(seed * 12.9898) * magnitude, Math.cos(seed * 78.233) * magnitude * 0.7);
  }

  restoreShake(rc: RenderContext, magnitude: number): void {
    if (magnitude <= 0.01) return;
    rc.ctx.restore();
  }
}

const SPRITE_FRAMES_COUNT = 8;
