import { useEffect, useRef } from 'react';
import { bakeFishSprite, drawCannon, paletteFor, SPRITE_FRAMES } from '../game/Sprites';
import type { CannonConfig, FishConfig } from '@reef/shared';

/** Live canvas previews of the real sprite art — used on the landing, room and admin screens. */

export function FishPreview({ species, size = 96, animate = true }: { species: FishConfig; size?: number; animate?: boolean }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const sprite = bakeFishSprite(species);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = size * 2;
    const height = size;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let raf = 0;
    let frame = Math.floor(Math.random() * SPRITE_FRAMES);
    let last = performance.now();

    const draw = (now: number) => {
      const dt = now - last;
      last = now;
      if (animate && dt > 90) {
        frame = (frame + 1) % SPRITE_FRAMES;
      }
      ctx.clearRect(0, 0, width, height);
      const h = height * 0.86;
      const w = (sprite.frameWidth / sprite.frameHeight) * h;
      const bob = animate ? Math.sin(now / 520 + species.size) * height * 0.045 : 0;
      ctx.drawImage(sprite.canvas, frame * sprite.frameWidth, 0, sprite.frameWidth, sprite.frameHeight, width / 2 - w / 2, height / 2 - h / 2 + bob, w, h);
      if (animate) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [species, size, animate]);

  return <canvas ref={ref} className="fish-preview" style={{ width: size * 2, height: size }} aria-label={`${species.name} preview`} role="img" />;
}

export function FishAvatarSprite({ species, size = 54 }: { species: FishConfig | null; size?: number }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    if (!species) {
      ctx.fillStyle = 'rgba(126,190,226,0.2)';
      ctx.beginPath();
      ctx.ellipse(size / 2, size / 2, size * 0.32, size * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const sprite = bakeFishSprite(species);
    const h = size * 0.9;
    const w = (sprite.frameWidth / sprite.frameHeight) * h;
    ctx.drawImage(sprite.canvas, 0, 0, sprite.frameWidth, sprite.frameHeight, size / 2 - w / 2, size / 2 - h / 2, w, h);
  }, [species, size]);
  return <canvas ref={ref} style={{ width: size, height: size }} aria-hidden="true" />;
}

export function CannonPreview({ cannon, width = 150, height = 110 }: { cannon: CannonConfig; width?: number; height?: number }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    let raf = 0;
    let t = 0;
    const draw = () => {
      t += 0.016;
      const angle = -Math.PI / 2 + Math.sin(t * 0.8) * 0.5;
      drawCannon(ctx, {
        x: width / 2,
        y: height * 0.86,
        angle,
        level: cannon.level,
        recoil: Math.max(0, Math.sin(t * 1.6)) * 0.4,
        color: paletteFor(undefined).body1,
        accent: 'rgba(160,240,255,0.9)',
        local: false,
      });
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [cannon, width, height]);
  return <canvas ref={ref} style={{ width, height }} aria-label={`${cannon.name} preview`} role="img" />;
}
