import { useEffect, useRef } from 'react';
import { bakeFishSprite, SPRITE_FRAMES } from '../game/Sprites';
import type { FishConfig } from '@reef/shared';

/**
 * Decorative underwater backdrop for marketing pages.
 *
 * It deliberately reuses the game's own procedural fish sprites and motion math,
 * so the landing page shows the *real* artwork rather than a mock. The loop
 * pauses when the tab is hidden and stops entirely for reduced-motion users.
 */

const SHOWCASE: Array<Partial<FishConfig> & { key: string }> = [
  { key: 'blue_darter', name: 'Blue Darter', category: 'COMMON', health: 1, reward: 2, speed: 150, size: 30, rarity: 1, spawnWeight: 40, movementPattern: 'STRAIGHT', palette: 0, minSpawnIntervalMs: 0, special: null, enabled: true, sortOrder: 0 },
  { key: 'coral_wrasse', name: 'Coral Wrasse', category: 'MEDIUM', health: 3, reward: 5, speed: 110, size: 40, rarity: 2, spawnWeight: 20, movementPattern: 'SINE', palette: 2, minSpawnIntervalMs: 0, special: null, enabled: true, sortOrder: 0 },
  { key: 'sunset_angelfish', name: 'Sunset Angelfish', category: 'MEDIUM', health: 3, reward: 6, speed: 95, size: 44, rarity: 2, spawnWeight: 18, movementPattern: 'SINE', palette: 3, minSpawnIntervalMs: 0, special: null, enabled: true, sortOrder: 0 },
  { key: 'tide_grouper', name: 'Tide Grouper', category: 'LARGE', health: 10, reward: 20, speed: 70, size: 62, rarity: 4, spawnWeight: 10, movementPattern: 'SINE', palette: 4, minSpawnIntervalMs: 0, special: null, enabled: true, sortOrder: 0 },
  { key: 'golden_koi', name: 'Golden Koi', category: 'SPECIAL_GOLDEN', health: 5, reward: 25, speed: 130, size: 36, rarity: 12, spawnWeight: 3, movementPattern: 'SINE', palette: 8, minSpawnIntervalMs: 0, special: 'golden', enabled: true, sortOrder: 0 },
  { key: 'lantern_ray', name: 'Lantern Ray', category: 'RARE', health: 25, reward: 50, speed: 55, size: 78, rarity: 8, spawnWeight: 3, movementPattern: 'SINE', palette: 6, minSpawnIntervalMs: 0, special: null, enabled: true, sortOrder: 0 },
];

interface Swimmer {
  sprite: { canvas: HTMLCanvasElement; frameWidth: number; frameHeight: number };
  x: number;
  y: number;
  speed: number;
  size: number;
  dir: 1 | -1;
  phase: number;
  amp: number;
  freq: number;
  baseY: number;
  depth: number;
}

interface Bubble {
  x: number;
  y: number;
  r: number;
  vy: number;
  drift: number;
  phase: number;
}

export function OceanBackdrop({ density = 1, className = '' }: { density?: number; className?: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let time = 0;
    let last = performance.now();

    const swimmers: Swimmer[] = [];
    const bubbles: Bubble[] = [];
    const count = Math.round(7 * density);
    for (let i = 0; i < count; i += 1) {
      const species = SHOWCASE[i % SHOWCASE.length] as FishConfig;
      const sprite = bakeFishSprite(species);
      const depth = 0.35 + Math.random() * 0.65;
      swimmers.push({
        sprite,
        x: Math.random() * 1600,
        y: 0,
        baseY: 0.12 + Math.random() * 0.72,
        speed: (36 + Math.random() * 60) * depth,
        size: species.size * (0.72 + depth * 0.6),
        dir: Math.random() < 0.5 ? 1 : -1,
        phase: Math.random() * SPRITE_FRAMES,
        amp: 8 + Math.random() * 26,
        freq: 0.4 + Math.random() * 0.8,
        depth,
      });
    }

    const resize = (): void => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const s of swimmers) s.y = s.baseY * height;
      bubbles.length = 0;
      const bubbleCount = Math.round((width * height) / 46000);
      for (let i = 0; i < bubbleCount; i += 1) {
        bubbles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          r: 1 + Math.random() * 3.4,
          vy: 12 + Math.random() * 34,
          drift: (Math.random() - 0.5) * 16,
          phase: Math.random() * 7,
        });
      }
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (document.hidden) return;
      time += dt;

      const water = ctx.createLinearGradient(0, 0, 0, height);
      water.addColorStop(0, '#0a4a6e');
      water.addColorStop(0.42, '#06304a');
      water.addColorStop(1, '#020d16');
      ctx.fillStyle = water;
      ctx.fillRect(0, 0, width, height);

      // Light shafts.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 5; i += 1) {
        const x = ((i + 0.5) / 5) * width + Math.sin(time * 0.16 + i) * 60;
        const w = width * 0.1;
        const grad = ctx.createLinearGradient(x, 0, x + w, height);
        grad.addColorStop(0, 'rgba(180,240,255,0.14)');
        grad.addColorStop(1, 'rgba(120,210,255,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + w, 0);
        ctx.lineTo(x + w * 2.4, height);
        ctx.lineTo(x + w * 1.1, height);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      // Bubbles.
      ctx.save();
      ctx.strokeStyle = 'rgba(190,240,255,0.4)';
      ctx.lineWidth = 1;
      for (const b of bubbles) {
        b.y -= b.vy * dt;
        b.x += Math.sin(time * 1.4 + b.phase) * 10 * dt + b.drift * dt;
        if (b.y < -10) {
          b.y = height + 10;
          b.x = Math.random() * width;
        }
        ctx.globalAlpha = 0.14 + 0.3 * (1 - b.y / height);
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();

      // Fish silhouettes (real baked sprites).
      for (const s of swimmers) {
        if (!reduce) {
          s.x += s.speed * s.dir * dt;
          s.phase += dt * (3 + s.depth * 5);
        }
        if (s.dir === 1 && s.x > width + 200) s.x = -200;
        if (s.dir === -1 && s.x < -200) s.x = width + 200;
        const y = s.baseY * height + Math.sin(time * s.freq + s.baseY * 9) * s.amp;
        const frame = Math.floor(Math.abs(s.phase) % SPRITE_FRAMES) * s.sprite.frameWidth;
        const h = s.size * 2.1;
        const w = (s.sprite.frameWidth / s.sprite.frameHeight) * h;
        ctx.save();
        ctx.globalAlpha = 0.28 + s.depth * 0.5;
        ctx.translate(s.x, y);
        ctx.scale(s.dir, 1);
        ctx.drawImage(s.sprite.canvas, frame, 0, s.sprite.frameWidth, s.sprite.frameHeight, -w / 2, -h / 2, w, h);
        ctx.restore();
      }

      // Coral skyline at the bottom.
      ctx.save();
      ctx.fillStyle = 'rgba(2,16,26,0.9)';
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let x = 0; x <= width; x += 18) {
        const y = height - (18 + Math.sin(x * 0.012) * 10 + Math.sin(x * 0.05) * 7);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [density]);

  return <canvas ref={canvasRef} className={`ocean-backdrop ${className}`} aria-hidden="true" />;
}
