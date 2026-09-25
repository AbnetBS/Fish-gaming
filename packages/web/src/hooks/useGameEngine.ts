import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Engine, type EngineStats } from '../game/Engine';
import { GameSocket, type LinkState } from '../game/Net';
import { audio } from '../game/Audio';
import { apiFetch, ApiError, getAccessToken, tryRefresh } from '../lib/api';
import { useAuth } from '../state/AuthContext';
import { useToast } from '../state/toast';
import type { BetOption, ClientConfig } from '../lib/api';
import type { ServerMessage, TournamentEntryView, TournamentLiveState } from '@reef/shared';

/**
 * Wires the canvas engine to the socket, the wallet and the configuration.
 *
 * The hook is deliberately the only place that knows how a shot travels:
 * UI components call `fire()` / `setAngle()` and render whatever the engine
 * reports. When the socket cannot be established the engine switches to an
 * explicitly labelled practice mode so the product degrades honestly instead of
 * pretending to be online.
 */
export interface UseGameEngineArgs {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  config: ClientConfig | null;
  roomKey: string | null;
  /** Tournament arena mode: joins the match instead of a room. */
  tournamentId?: string | null;
  enabled: boolean;
  /** Landing-page preview: local only, no network at all. */
  practiceOnly?: boolean;
  onBalance?: (balance: number) => void;
  onRound?: (roundId: string, configVersion: string) => void;
  onReward?: (reward: { amount: number; fish: string; x: number; y: number }) => void;
}

export interface UseGameEngineResult {
  engine: Engine | null;
  link: LinkState;
  stats: EngineStats;
  betOptions: BetOption[];
  cannonKey: string;
  setCamera: (cannonKey: string) => void;
  fire: () => void;
  setAutoFire: (on: boolean) => void;
  autoFire: boolean;
  setAngleFromPointer: (clientX: number, clientY: number) => void;
  angle: number;
  roundId: string | null;
  practice: boolean;
  retry: () => void;
  balance: number;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  /** Daily play allowance as the server sees it. */
  limits: PlayLimitsState | null;
  /** Set when the server has blocked play (limit reached, self-exclusion). */
  block: PlayBlock | null;
  /** Clears the local notice after the player acknowledges it. */
  dismissBlock: () => void;
  /** Live match context in tournament mode (null in normal rooms). */
  tournament: TournamentLiveState | null;
  /** Final result once the match settles. */
  tournamentResult: TournamentEndResult | null;
}

export interface PlayLimitsState {
  /** Minutes allowed per UTC day; 0 = no limit. */
  limitMin: number;
  minutesPlayedToday: number;
  /** null = unlimited. */
  minutesRemaining: number | null;
}

export interface PlayBlock {
  kind: 'SESSION_LIMIT' | 'SELF_EXCLUDED' | 'ACCOUNT_BLOCKED';
  message: string;
  until: string | null;
}

export interface TournamentEndResult {
  tournamentId: string;
  winnerUsername: string | null;
  prize: number;
  rake: number;
  standings: TournamentEntryView[];
}

export function useGameEngine({ canvasRef, config, roomKey, tournamentId = null, enabled, practiceOnly = false, onBalance, onRound, onReward }: UseGameEngineArgs): UseGameEngineResult {
  const { applyBalance, user } = useAuth();
  const toast = useToast();
  const engineRef = useRef<Engine | null>(null);
  const socketRef = useRef<GameSocket | null>(null);
  const [link, setLink] = useState<LinkState>('idle');
  const [practice, setPractice] = useState(false);
  const [stats, setStats] = useState<EngineStats>({
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
  });
  const [betOptions, setBetOptions] = useState<BetOption[]>([]);
  const [cannonKey, setCannonKey] = useState<string>('');
  const [angle, setAngle] = useState(-Math.PI / 2);
  const [autoFire, setAutoFireState] = useState(false);
  const [roundId, setRoundId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [balance, setBalance] = useState(0);
  /** Player-protection budget mirrored from the server (never computed here). */
  const [limits, setLimits] = useState<PlayLimitsState | null>(null);
  /** Non-null means the server has stopped this player: no fire, no autoplay. */
  const [block, setBlock] = useState<PlayBlock | null>(null);
  const [tournament, setTournament] = useState<TournamentLiveState | null>(null);
  const [tournamentResult, setTournamentResult] = useState<TournamentEndResult | null>(null);
  const blockRef = useRef<PlayBlock | null>(null);
  blockRef.current = block;
  const aimThrottle = useRef(0);
  const onRewardRef = useRef(onReward);
  onRewardRef.current = onReward;
  const noticeTimes = useRef(new Map<string, number>());

  const pushNotice = useCallback(
    (level: 'info' | 'warn' | 'error', message: string) => {
      // De-duplicate identical notices: a reconnect can produce the same
      // "room is full" message dozens of times in a second.
      const now = Date.now();
      const last = noticeTimes.current.get(message) ?? 0;
      if (now - last < 2500) return;
      noticeTimes.current.set(message, now);
      if (level === 'error') audio.play('error');
      toast.push(message, level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info');
    },
    [toast],
  );

  /* ------------------------------- engine boot ------------------------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !enabled) return;
    const engine = new Engine(canvas, {
      onSound: (name, intensity) => audio.play(name, { intensity }),
      onNotice: pushNotice,
      onStats: (next) => setStats(next),
      onBalance: (value) => {
        setBalance(value);
        applyBalance(value);
        onBalance?.(value);
      },
      onReward: (reward) => {
        // No wallet round-trip per kill: the authoritative balance already
        // arrives on the socket. This only feeds the on-screen reward ticker.
        onRewardRef.current?.(reward);
      },
      requestFire: (intent) => {
        if (blockRef.current) return; // a limit the server imposed is not renegotiable
        if (practiceOnly || practice) return; // practice resolves locally
        const sent = socketRef.current?.send({ type: 'fire', ...intent, cannonKey });
        if (!sent) {
          // Socket down: the HTTP path runs identical server-side checks.
          void apiFetch('/api/game/fire', { method: 'POST', body: { ...intent, cannonKey } }).catch(() => undefined);
        }
      },
      sendAim: (nextAngle) => {
        const now = performance.now();
        if (now - aimThrottle.current < 45) return;
        aimThrottle.current = now;
        socketRef.current?.send({ type: 'aim', angle: nextAngle });
      },
    });
    engineRef.current = engine;
    if (config) engine.setSpecies(config.fish);
    engine.resize(canvas.clientWidth || 960, canvas.clientHeight || 540);
    engine.start();
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, practiceOnly]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !config) return;
    engine.setSpecies(config.fish);
  }, [config]);

  /* --------------------------------- network --------------------------------- */

  const handleMessage = useCallback(
    (message: ServerMessage) => {
      const engine = engineRef.current;
      if (message.type === 'standings') {
        setTournament((current) =>
          current && current.tournamentId === message.tournamentId
            ? {
                ...current,
                endsAt: message.endsAt,
                prizePool: message.prizePool,
                standings: message.standings,
                myScore: message.standings.find((s) => s.userId === user?.id)?.score ?? current.myScore,
                myRank: message.standings.find((s) => s.userId === user?.id)?.rank ?? current.myRank,
              }
            : current,
        );
        return;
      }
      if (message.type === 'tournamentEnd') {
        setTournamentResult({
          tournamentId: message.tournamentId,
          winnerUsername: message.winnerUsername,
          prize: message.prize,
          rake: message.rake,
          standings: message.standings,
        });
        // The match is over: stop firing, the arena is about to close.
        setAutoFireState(false);
        engine?.setAutoFire(false);
        pushNotice(
          'info',
          message.winnerUsername
            ? `Tournament over — ${message.winnerUsername} wins ${message.prize} demo coins!`
            : 'The tournament has ended.',
        );
        return;
      }
      if (message.type === 'joined') {
        setTournament(message.tournament ?? null);
        setTournamentResult(null);
        setRoundId(message.roundId);
        setBetOptions(message.betOptions);
        setCannonKey(message.cannonKey);
        setPractice(false);
        setBalance(message.balance);
        setLimits(message.limits ? { ...message.limits, minutesRemaining: message.limits.minutesRemaining ?? null } : null);
        setBlock(null);
        onRound?.(message.roundId, message.configVersion);
        engine?.setLocalPlayer({
          id: user?.id ?? 'local',
          cannonKey: message.cannonKey,
          level: message.betOptions.find((o) => o.key === message.cannonKey)?.level ?? 1,
          fireRate: message.betOptions.find((o) => o.key === message.cannonKey)?.fireRate ?? 3,
          x: message.seat.x,
          y: message.seat.y,
        });
      }
      if (message.type === 'round') {
        setRoundId(message.roundId);
        onRound?.(message.roundId, message.configVersion);
      }
      if (message.type === 'limit') {
        // The server has closed the session: stop firing, stop auto-fire and put
        // the reason in front of the player instead of a toast that disappears.
        setBlock({ kind: message.kind, message: message.message, until: message.until });
        setLimits({ limitMin: message.limitMin, minutesPlayedToday: message.minutesPlayedToday, minutesRemaining: 0 });
        setAutoFireState(false);
        engine?.setAutoFire(false);
        pushNotice('warn', message.message);
        return;
      }
      if (message.type === 'notice') pushNotice(message.level, message.message);
      if (message.type === 'balance') {
        setBalance(message.balance);
        applyBalance(message.balance);
      }
      engine?.handle(message);
    },
    [applyBalance, onRound, pushNotice, user?.id],
  );

  const connect = useCallback(() => {
    if (practiceOnly) {
      setPractice(true);
      engineRef.current?.enablePractice(true);
      if (config) {
        const first = config.cannons[0];
        setBetOptions(
          config.cannons.map((c) => ({
            key: c.key,
            name: c.name,
            level: c.level,
            power: c.power,
            shotCost: c.shotCost,
            fireRate: c.fireRate,
            legal: true,
          })),
        );
        if (first) {
          setCannonKey(first.key);
          engineRef.current?.setLocalPlayer({ id: user?.id ?? 'local', cannonKey: first.key, level: first.level, fireRate: first.fireRate });
        }
      }
      return;
    }
    if (!user || (!roomKey && !tournamentId)) return;
    const socket = new GameSocket({
      onMessage: handleMessage,
      onState: (state, detail) => {
        setLink(state);
        if (state === 'reconnecting') pushNotice('warn', 'Connection lost. Reconnecting...');
        if (state === 'failed') {
          pushNotice('warn', detail === 'not-authenticated' ? 'Your session expired. Please sign in again.' : 'Cannot reach the game server. Practice mode is available.');
          setPractice(true);
          engineRef.current?.enablePractice(true);
        }
        if (state === 'open') {
          if (tournamentId) socketRef.current?.send({ type: 'joinTournament', tournamentId });
          else if (roomKey) socketRef.current?.send({ type: 'join', roomId: roomKey });
        }
      },
      getToken: async () => {
        // The in-memory token is used when present; otherwise the httpOnly
        // refresh cookie lets us obtain a new one before connecting.
        const existing = getAccessToken();
        if (existing) return existing;
        const ok = await tryRefresh();
        return ok ? getAccessToken() : null;
      },
    });
    socketRef.current?.dispose();
    socketRef.current = socket;
    setLink('connecting');
    socket.connect();
  }, [config, handleMessage, practiceOnly, pushNotice, roomKey, tournamentId, user]);

  useEffect(() => {
    if (!enabled) return;
    connect();
    return () => {
      socketRef.current?.dispose();
      socketRef.current = null;
      setLink('idle');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, roomKey, tournamentId, user?.id]);

  /* practice-mode defaults when there is no socket */
  useEffect(() => {
    if (!practice || !config) return;
    setBetOptions(
      config.cannons.map((c) => ({ key: c.key, name: c.name, level: c.level, power: c.power, shotCost: c.shotCost, fireRate: c.fireRate, legal: true })),
    );
    const first = config.cannons.find((c) => c.key === cannonKey) ?? config.cannons[0];
    if (first) {
      setCannonKey((current) => current || first.key);
      engineRef.current?.setLocalPlayer({
        id: user?.id ?? 'local',
        cannonKey: first.key,
        level: first.level,
        fireRate: first.fireRate,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [practice, config]);

  /* -------------------------------- controls -------------------------------- */

  const cannon = useMemo(() => betOptions.find((o) => o.key === cannonKey) ?? betOptions[0], [betOptions, cannonKey]);

  const setCamera = useCallback(
    (nextKey: string) => {
      if (practice || practiceOnly) {
        const local = config?.cannons.find((c) => c.key === nextKey);
        if (local) {
          setCannonKey(local.key);
          engineRef.current?.setLocalPlayer({ id: user?.id ?? 'local', cannonKey: local.key, level: local.level, fireRate: local.fireRate });
        }
        return;
      }
      const sent = socketRef.current?.send({ type: 'setCannon', cannonKey: nextKey });
      if (!sent) {
        void apiFetch('/api/game/cannon', { method: 'POST', body: { cannonKey: nextKey } })
          .then(() => setCannonKey(nextKey))
          .catch((err) => pushNotice('warn', err instanceof ApiError ? err.message : 'Could not change cannon.'));
        return;
      }
      setCannonKey(nextKey);
    },
    [config, practice, practiceOnly, pushNotice, user?.id],
  );

  const fire = useCallback(() => {
    if (blockRef.current) {
      pushNotice('warn', blockRef.current.message);
      return;
    }
    void audio.unlock();
    engineRef.current?.tryFire();
  }, [pushNotice]);

  const setAutoFire = useCallback((on: boolean) => {
    setAutoFireState(on);
    engineRef.current?.setAutoFire(on);
  }, []);

  const setAngleFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      const engine = engineRef.current;
      if (!canvas || !engine) return;
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(rect.width / 1920, rect.height / 1080);
      const offsetX = (rect.width - 1920 * scale) / 2;
      const offsetY = (rect.height - 1080 * scale) / 2;
      const logicalX = (clientX - rect.left - offsetX) / scale;
      const logicalY = (clientY - rect.top - offsetY) / scale;
      const next = Math.atan2(logicalY - engine.cannonY, logicalX - engine.cannonX);
      engine.setAim(next);
      setAngle(next);
    },
    [canvasRef],
  );

  /* Auto-fire loop: the engine enforces the cannon's fire rate per shot. */
  useEffect(() => {
    if (!autoFire || paused) return;
    let raf = 0;
    const loop = () => {
      engineRef.current?.tryFire();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [autoFire, paused]);

  /* Pause = stop the render loop; the server keeps the room for other players. */
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (paused) engine.stop();
    else engine.start();
  }, [paused]);

  /* Resize handling keeps the aspect ratio correct on rotation. */
  useEffect(() => {
    if (!enabled) return;
    const onResize = () => {
      const canvas = canvasRef.current;
      const engine = engineRef.current;
      if (!canvas || !engine) return;
      engine.resize(canvas.clientWidth, canvas.clientHeight);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    const observer = new ResizeObserver(onResize);
    if (canvasRef.current) observer.observe(canvasRef.current);
    onResize();
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      observer.disconnect();
    };
  }, [canvasRef, enabled]);

  const retry = useCallback(() => {
    setPractice(false);
    engineRef.current?.enablePractice(false);
    connect();
  }, [connect]);

  useEffect(() => {
    if (socketRef.current) engineRef.current?.setClockOffset(socketRef.current.serverOffset);
  }, [link]);

  return {
    engine: engineRef.current,
    link,
    stats,
    betOptions,
    cannonKey,
    setCamera,
    fire,
    setAutoFire,
    autoFire,
    setAngleFromPointer,
    angle,
    roundId,
    practice: practice || practiceOnly,
    retry,
    balance,
    paused,
    setPaused,
    limits,
    block,
    dismissBlock: () => setBlock(null),
    tournament,
    tournamentResult,
  };
}
