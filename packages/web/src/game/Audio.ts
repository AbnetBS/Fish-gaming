/**
 * Procedural audio engine.
 *
 * Every sound is synthesised at runtime with the Web Audio API, so the product
 * ships zero third-party audio and cannot infringe any recording. Autoplay
 * policy is respected: the graph is only created/resumed from a user gesture.
 */

export type SoundName = 'shot' | 'hit' | 'kill' | 'bossKill' | 'reward' | 'click' | 'error' | 'join' | 'wave' | 'level';

interface AudioState {
  ctx: AudioContext;
  master: GainNode;
  sfx: GainNode;
  music: GainNode;
  musicStarted: boolean;
  noiseBuffer: AudioBuffer;
}

const MUSIC_STEPS = [0, 7, 3, 10, 0, 7, 12, 5];
const BASS_STEPS = [0, 0, 5, 3];

export class AudioEngine {
  private state: AudioState | null = null;
  private musicTimer: number | null = null;
  private step = 0;
  private enabled = { sfx: true, music: true };
  private volume = { sfx: 0.8, music: 0.32 };
  private lastPlayed = new Map<SoundName, number>();

  constructor() {
    try {
      const stored = localStorage.getItem('reef.audio');
      if (stored) {
        const parsed = JSON.parse(stored);
        this.enabled = { sfx: parsed.sfx ?? true, music: parsed.music ?? true };
        this.volume = { sfx: parsed.sfxVolume ?? 0.8, music: parsed.musicVolume ?? 0.32 };
      }
    } catch {
      /* private mode */
    }
  }

  get ready(): boolean {
    return this.state !== null;
  }

  /** Must be called from a user gesture (click/tap) to satisfy autoplay rules. */
  async unlock(): Promise<void> {
    if (this.state) {
      if (this.state.ctx.state === 'suspended') await this.state.ctx.resume();
      return;
    }
    const Ctor: typeof AudioContext | undefined =
      (window as any).AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return;
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      return;
    }
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    const sfx = ctx.createGain();
    sfx.gain.value = this.enabled.sfx ? this.volume.sfx : 0;
    sfx.connect(master);
    const music = ctx.createGain();
    music.gain.value = this.enabled.music ? this.volume.music : 0;
    music.connect(master);

    // 1s of white noise, reused for impacts and bubbles.
    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;

    this.state = { ctx, master, sfx, music, musicStarted: false, noiseBuffer };
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
    this.startMusic();
  }

  setEnabled(kind: 'sfx' | 'music', on: boolean): void {
    this.enabled[kind] = on;
    this.persist();
    if (!this.state) return;
    const bus = kind === 'sfx' ? this.state.sfx : this.state.music;
    bus.gain.setTargetAtTime(on ? this.volume[kind] : 0, this.state.ctx.currentTime, 0.05);
    if (kind === 'music' && on) this.startMusic();
  }

  setVolume(kind: 'sfx' | 'music', value: number): void {
    this.volume[kind] = Math.max(0, Math.min(1, value));
    this.persist();
    if (this.state && this.enabled[kind]) {
      const bus = kind === 'sfx' ? this.state.sfx : this.state.music;
      bus.gain.setTargetAtTime(this.volume[kind], this.state.ctx.currentTime, 0.05);
    }
  }

  isEnabled(kind: 'sfx' | 'music'): boolean {
    return this.enabled[kind];
  }

  private persist(): void {
    try {
      localStorage.setItem('reef.audio', JSON.stringify({ ...this.enabled, ...this.volume }));
    } catch {
      /* ignore */
    }
  }

  /** Rate-limited so a burst of hits cannot machine-gun the mix. */
  play(name: SoundName, opts: { intensity?: number; rate?: number } = {}): void {
    const state = this.state;
    if (!state || !this.enabled.sfx) return;
    const minGap: Partial<Record<SoundName, number>> = { shot: 45, hit: 40, kill: 60, reward: 90, error: 220 };
    const gap = minGap[name] ?? 0;
    const now = performance.now();
    if (gap && now - (this.lastPlayed.get(name) ?? -1e9) < gap) return;
    this.lastPlayed.set(name, now);

    switch (name) {
      case 'shot':
        this.shot(state, opts.rate ?? 1);
        break;
      case 'hit':
        this.hit(state, opts.intensity ?? 0.5);
        break;
      case 'kill':
        this.kill(state, opts.intensity ?? 0.5);
        break;
      case 'bossKill':
        this.bossKill(state);
        break;
      case 'reward':
        this.reward(state, opts.intensity ?? 0.5);
        break;
      case 'click':
        this.blip(state, 720, 0.04, 0.16);
        break;
      case 'error':
        this.error(state);
        break;
      case 'join':
        this.blip(state, 480, 0.14, 0.2, 1.35);
        break;
      case 'wave':
        this.swell(state);
        break;
      case 'level':
        this.blip(state, 620, 0.12, 0.22, 1.5);
        break;
    }
  }

  /* ------------------------------ voices ------------------------------ */

  private tone(state: AudioState, freq: number, dur: number, gain: number, type: OscillatorType = 'sine', detune = 0, delay = 0): void {
    const { ctx, sfx } = state;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    osc.detune.value = detune;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(sfx);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private blip(state: AudioState, freq: number, dur: number, gain: number, slide = 1): void {
    const { ctx, sfx } = state;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(60, freq * slide), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(sfx);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private noise(state: AudioState, dur: number, gain: number, filterType: BiquadFilterType, freq: number, q = 1, sweepTo?: number): void {
    const { ctx, sfx, noiseBuffer } = state;
    const t0 = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.playbackRate.value = 0.8 + Math.random() * 0.5;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(freq, t0);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t0 + dur);
    filter.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(g).connect(sfx);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  private shot(state: AudioState, rate: number): void {
    // Arcade "cannon": filtered noise transient + fast pitch-down body.
    this.noise(state, 0.09, 0.16, 'highpass', 900 * rate, 0.7, 2600);
    const { ctx, sfx } = state;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(340 * rate, t0);
    osc.frequency.exponentialRampToValueAtTime(70 * rate, t0 + 0.13);
    g.gain.setValueAtTime(0.16, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
    osc.connect(g).connect(sfx);
    osc.start(t0);
    osc.stop(t0 + 0.18);
  }

  private hit(state: AudioState, intensity: number): void {
    this.noise(state, 0.07 + intensity * 0.05, 0.1 + intensity * 0.1, 'bandpass', 1500 + intensity * 900, 2.2, 620);
    this.tone(state, 240 + intensity * 160, 0.09, 0.09, 'triangle');
  }

  private kill(state: AudioState, intensity: number): void {
    this.noise(state, 0.22, 0.16, 'lowpass', 1800, 1.1, 200);
    const base = 320 + intensity * 200;
    for (let i = 0; i < 3; i += 1) {
      this.tone(state, base * Math.pow(1.26, i), 0.16, 0.1, 'triangle', 0, i * 0.05);
    }
  }

  private reward(state: AudioState, intensity: number): void {
    const notes = [784, 988, 1175, 1568];
    const count = intensity > 0.75 ? 4 : intensity > 0.4 ? 3 : 2;
    for (let i = 0; i < count; i += 1) {
      this.tone(state, notes[i]!, 0.19, 0.09, 'sine', 4, i * 0.055);
    }
  }

  private bossKill(state: AudioState): void {
    this.noise(state, 0.85, 0.3, 'lowpass', 1400, 0.8, 70);
    for (let i = 0; i < 6; i += 1) {
      this.tone(state, 196 * Math.pow(1.19, i), 0.4, 0.13, 'sawtooth', -6, i * 0.085);
    }
  }

  private error(state: AudioState): void {
    this.tone(state, 180, 0.16, 0.11, 'square');
    this.tone(state, 120, 0.22, 0.09, 'square', 0, 0.07);
  }

  private swell(state: AudioState): void {
    this.noise(state, 0.7, 0.1, 'bandpass', 300, 1.2, 1800);
    this.tone(state, 130, 0.6, 0.1, 'sine', 0, 0);
  }

  /* ------------------------------- music ------------------------------- */

  /**
   * A slow ambient bed plus a sparse arpeggio, generated from a minor scale.
   * Deliberately minimal so it reads as "underwater ambience" rather than a
   * melodic cue that could resemble an existing work.
   */
  private startMusic(): void {
    const state = this.state;
    if (!state || state.musicStarted || !this.enabled.music) return;
    state.musicStarted = true;
    const { ctx, music } = state;

    // Continuous low drone.
    for (const [freq, detune, gain] of [[55, -4, 0.16], [82.4, 3, 0.09], [110, 0, 0.05]] as const) {
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      filter.type = 'lowpass';
      filter.frequency.value = 420;
      g.gain.value = gain;
      // Slow amplitude LFO for a breathing feel.
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 0.05 + Math.random() * 0.05;
      lfoGain.gain.value = gain * 0.4;
      lfo.connect(lfoGain).connect(g.gain);
      osc.connect(filter).connect(g).connect(music);
      osc.start();
      lfo.start();
    }

    const tick = () => {
      if (!this.state) return;
      this.step += 1;
      const s = this.step;
      if (s % 2 === 0) {
        const degree = MUSIC_STEPS[(s / 2) % MUSIC_STEPS.length]!;
        const freq = 220 * Math.pow(2, degree / 12);
        this.pluck(freq, 0.9, 0.05);
      }
      if (s % 8 === 0) {
        this.pluck(110 * Math.pow(2, BASS_STEPS[(s / 8) % BASS_STEPS.length]! / 12), 1.4, 0.09);
      }
      this.musicTimer = window.setTimeout(tick, 520);
    };
    const pluck = (freq: number, dur: number, gain: number) => {
      const ctx2 = this.state?.ctx;
      if (!ctx2) return;
      const t0 = ctx2.currentTime;
      const osc = ctx2.createOscillator();
      const g = ctx2.createGain();
      const filter = ctx2.createBiquadFilter();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      filter.type = 'lowpass';
      filter.frequency.value = 1200;
      filter.Q.value = 3;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(gain, t0 + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(filter).connect(g).connect(music);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    };
    this.pluckFn = pluck;
    tick();
  }

  private pluckFn: ((freq: number, dur: number, gain: number) => void) | null = null;

  private pluck(freq: number, dur: number, gain: number): void {
    this.pluckFn?.(freq, dur, gain);
  }

  suspend(): void {
    if (this.musicTimer) window.clearTimeout(this.musicTimer);
    this.musicTimer = null;
    this.state?.ctx.suspend().catch(() => undefined);
  }

  async resume(): Promise<void> {
    if (this.state?.ctx.state === 'suspended') {
      try {
        await this.state.ctx.resume();
      } catch {
        /* ignore */
      }
    }
  }

  dispose(): void {
    if (this.musicTimer) window.clearTimeout(this.musicTimer);
    this.musicTimer = null;
    this.state?.ctx.close().catch(() => undefined);
    this.state = null;
  }
}

export const audio = new AudioEngine();
