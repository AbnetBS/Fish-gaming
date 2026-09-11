import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useGameEngine } from '../hooks/useGameEngine';
import { usePlatform } from '../state/PlatformContext';
import { useAuth } from '../state/AuthContext';
import { api } from '../lib/api';
import { Button, Modal, Toggle, formatCoins } from '../components/ui';
import { audio } from '../game/Audio';

/**
 * The arcade cabinet.
 *
 * Top bar: balance · room · bet · cannon · settings.
 * Centre: the canvas (letterboxed 1920x1080 logical view).
 * Bottom bar: cannon rail · FIRE · bet stepper · special weapon.
 *
 * Page scroll is locked while this screen is mounted and the pointer is captured
 * on the canvas, which is what makes it behave like a cabinet rather than a web
 * page.
 */

interface FeedItem {
  id: number;
  amount: number;
  fish: string;
  at: number;
}

export function Play(): JSX.Element {
  const { roomKey = '' } = useParams();
  const navigate = useNavigate();
  const { config, meta, reload } = usePlatform();
  const { wallet, user, applyBalance } = useAuth();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const [musicOn, setMusicOn] = useState(audio.isEnabled('music'));
  const [sfxOn, setSfxOn] = useState(audio.isEnabled('sfx'));
  const [autoFireOn, setAutoFireOn] = useState(false);
  const [session, setSession] = useState<{ startedAt: number; wagered: number; rewarded: number; shots: number }>({
    startedAt: Date.now(),
    wagered: 0,
    rewarded: 0,
    shots: 0,
  });
  const [pointerDown, setPointerDown] = useState(false);
  const [landscapeHint, setLandscapeHint] = useState(false);

  const handleReward = useCallback((reward: { amount: number; fish: string }) => {
    setFeed((current) => [{ id: Math.random(), amount: reward.amount, fish: reward.fish, at: Date.now() }, ...current].slice(0, 5));
  }, []);

  const engine = useGameEngine({
    canvasRef,
    config,
    roomKey: roomKey || null,
    enabled: true,
    onBalance: (balance) => applyBalance(balance),
    onReward: handleReward,
  });

  const cannon = useMemo(() => engine.betOptions.find((option) => option.key === engine.cannonKey) ?? engine.betOptions[0], [engine.betOptions, engine.cannonKey]);
  const legalOptions = engine.betOptions.filter((option) => option.legal);

  /* --------------------------- session accounting --------------------------- */
  const statsRef = useRef(engine.stats);
  statsRef.current = engine.stats;
  useEffect(() => {
    const timer = window.setInterval(() => {
      setSession((current) => ({
        ...current,
        wagered: statsRef.current.wagered,
        rewarded: statsRef.current.rewarded,
        shots: statsRef.current.shotsFired,
      }));
    }, 700);
    return () => window.clearInterval(timer);
  }, []);

  /* ------------------------------- scroll lock ------------------------------- */
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    const onContext = (event: Event) => event.preventDefault();
    document.addEventListener('contextmenu', onContext);
    return () => {
      document.body.style.overflow = previous;
      document.documentElement.style.overflow = '';
      document.removeEventListener('contextmenu', onContext);
    };
  }, []);

  useEffect(() => {
    const check = () => setLandscapeHint(window.innerHeight > window.innerWidth * 1.15 && window.innerWidth < 900);
    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, []);

  /* -------------------------------- input -------------------------------- */
  const aimFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      engine.setAngleFromPointer(clientX, clientY);
    },
    [engine],
  );

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' || pointerDown) aimFromEvent(event.clientX, event.clientY);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    void audio.unlock();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPointerDown(true);
    aimFromEvent(event.clientX, event.clientY);
    if (event.pointerType === 'touch') {
      engine.fire();
    }
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    setPointerDown(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.code === 'Space') {
        event.preventDefault();
        engine.fire();
        return;
      }
      if (event.key.toLowerCase() === 'f') {
        const next = !autoFireOn;
        setAutoFireOn(next);
        engine.setAutoFire(next);
        return;
      }
      if (event.key === 'Escape') {
        setSettingsOpen(false);
        setConfirmExit(true);
        return;
      }
      if (event.key === '+') stepBet(1);
      if (event.key === '-') stepBet(-1);
      const index = Number.parseInt(event.key, 10);
      if (!Number.isNaN(index) && legalOptions[index - 1]) engine.setCamera(legalOptions[index - 1]!.key);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, autoFireOn, legalOptions]);

  const stepBet = (direction: 1 | -1): void => {
    const options = legalOptions;
    if (!options.length) return;
    const current = options.findIndex((option) => option.key === engine.cannonKey);
    const next = Math.max(0, Math.min(options.length - 1, (current < 0 ? 0 : current) + direction));
    const target = options[next];
    if (target && target.key !== engine.cannonKey) {
      engine.setCamera(target.key);
      audio.play('level');
    }
  };

  /* --------------------------------- exit --------------------------------- */
  const leave = useCallback(async () => {
    try {
      await api.leave();
    } catch {
      /* the socket detach already ends the session */
    }
    navigate('/dashboard');
  }, [navigate]);

  const linkLabel = engine.practice
    ? 'PRACTICE'
    : engine.link === 'open'
      ? 'LIVE'
      : engine.link === 'connecting' || engine.link === 'reconnecting'
        ? 'RECONNECTING'
        : 'OFFLINE';

  return (
    <div className="game-screen" data-practice={engine.practice}>
      <div className="game-topbar">
        <div className="hud-chip" data-tone="gold">
          <span className="k">Demo coins</span>
          <span className="v">{formatCoins(wallet?.balance ?? 0)}</span>
        </div>
        <div className="hud-chip" data-tone="cyan">
          <span className="k">Room</span>
          <span className="v" style={{ fontSize: '0.9rem' }}>
            {config?.rooms.find((room) => room.key === roomKey)?.name ?? roomKey}
          </span>
        </div>
        <div className="hud-chip">
          <span className="k">Bet / shot</span>
          <span className="v" style={{ color: '#ffd166' }}>
            {cannon?.shotCost ?? '—'}
          </span>
        </div>
        {engine.limits && engine.limits.limitMin > 0 ? (
          <div className="hud-chip" data-tone={engine.limits.minutesRemaining !== null && engine.limits.minutesRemaining <= 2 ? 'gold' : 'cyan'}>
            <span className="k">Play time today</span>
            <span className="v" style={{ fontSize: '0.9rem' }}>
              {engine.limits.minutesPlayedToday}/{engine.limits.limitMin} min
            </span>
          </div>
        ) : null}
        <div className="hud-chip hide-mobile">
          <span className="k">Cannon</span>
          <span className="v" style={{ fontSize: '0.9rem' }}>
            {cannon?.name ?? '—'} · P{cannon?.power ?? 0}
          </span>
        </div>
        <div className="hud-chip hide-mobile" data-tone={session.rewarded - session.wagered >= 0 ? 'green' : 'warn'}>
          <span className="k">Session</span>
          <span className="v">
            {session.rewarded - session.wagered >= 0 ? '+' : '−'}
            {formatCoins(Math.abs(session.rewarded - session.wagered))}
          </span>
        </div>

        <div className="grow" />

        <span className={`link-pill link-pill-${engine.practice ? 'practice' : engine.link}`} title={`Link: ${engine.link}`}>
          <i aria-hidden="true" />
          {linkLabel}
        </span>
        <button className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="Game settings">
          ⚙
        </button>
        <button className="icon-btn" onClick={() => setConfirmExit(true)} aria-label="Leave game">
          ✕
        </button>
      </div>

      <div
        className="game-stage"
        ref={stageRef}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        data-cursor={pointerDown ? 'grab' : 'crosshair'}
      >
        <canvas ref={canvasRef} className="game-canvas" />

        {engine.stats.combo > 1 ? (
          <div className="combo-meter">
            <div className="n">×{engine.stats.combo}</div>
            <div className="l">chain (visual only)</div>
          </div>
        ) : null}

        <div className="reward-feed" aria-live="polite">
          {feed.map((item) => (
            <span className="item" key={item.id}>
              <b>+{item.amount}</b>
              <span className="tiny dim">{item.fish}</span>
            </span>
          ))}
        </div>

        {engine.link !== 'open' && !engine.practice ? (
          <div className="link-banner" data-state={engine.link}>
            {engine.link === 'failed' ? (
              <>
                <span>Connection lost.</span>
                <button className="btn btn-sm btn-ghost" onClick={engine.retry}>
                  Retry
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setConfirmExit(true)}>
                  Exit
                </button>
              </>
            ) : (
              <>
                <i className="spin" aria-hidden="true">◌</i> Reconnecting…
              </>
            )}
          </div>
        ) : null}

        {engine.practice ? <div className="practice-tag">Practice mode — no coins, no server</div> : null}

        {landscapeHint ? (
          <div className="rotate-hint">
            <div>
              <div className="phone" aria-hidden="true" />
              <h3 style={{ marginTop: '1rem' }}>Rotate for the full cabinet</h3>
              <p className="small muted">Landscape gives you the widest view of the reef. Tap anywhere to play in portrait anyway.</p>
              <Button className="btn-sm" variant="ghost" onClick={() => setLandscapeHint(false)}>
                Play in portrait
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="game-controls">
        <div className="cannon-rail" role="tablist" aria-label="Cannon selection">
          {engine.betOptions.map((option) => (
            <button
              key={option.key}
              role="tab"
              aria-selected={option.key === engine.cannonKey}
              className="cannon-chip"
              data-active={option.key === engine.cannonKey}
              disabled={!option.legal}
              title={option.legal ? `${option.name} — ${option.shotCost} demo coins per shot` : option.reason}
              onClick={() => {
                engine.setCamera(option.key);
                audio.play('level');
              }}
            >
              <span className="lvl">C{option.level}</span>
              <span>{option.shotCost} ◈</span>
            </button>
          ))}
        </div>

        <div className="grow" />

        <div className="bet-stepper">
          <button onClick={() => stepBet(-1)} disabled={legalOptions.length < 2} aria-label="Lower bet">
            −
          </button>
          <div className="value">
            <div className="k">Bet</div>
            <div className="v">{cannon?.shotCost ?? 0}</div>
          </div>
          <button onClick={() => stepBet(1)} disabled={legalOptions.length < 2} aria-label="Raise bet">
            +
          </button>
        </div>

        <button
          className="fire-button"
          data-on={autoFireOn}
          data-blocked={engine.block ? 'true' : undefined}
          disabled={!!engine.block}
          onPointerDown={(event) => {
            event.preventDefault();
            if (engine.block) {
              void engine.block; // the server stopped play; the card below explains why
              return;
            }
            void audio.unlock();
            engine.fire();
          }}
          onDoubleClick={() => {
            const next = !autoFireOn;
            setAutoFireOn(next);
            engine.setAutoFire(next);
          }}
          aria-label="Fire. Hold a mouse button or press F for auto-fire."
        >
          {autoFireOn ? 'AUTO' : 'FIRE'}
        </button>

        <button
          className="ability-button"
          data-ready={!engine.practice && (wallet?.balance ?? 0) >= (cannon?.shotCost ?? 0) * 5}
          onClick={() => {
            // "Full salvo" is five shots on the same aiming line: it is still
            // five ordinary, separately-priced, server-validated shots.
            if (engine.practice) {
              for (let i = 0; i < 5; i += 1) setTimeout(() => engine.fire(), i * 90);
              return;
            }
            for (let i = 0; i < 5; i += 1) setTimeout(() => engine.fire(), i * 110);
          }}
          title="Fire five shots in quick succession along your current aim"
        >
          FULL
          <br />
          SALVO
        </button>

        <div className="hide-mobile row" style={{ gap: '0.35rem' }}>
          <button className="icon-btn" onClick={() => { const next = !autoFireOn; setAutoFireOn(next); engine.setAutoFire(next); }} title="Toggle auto-fire (F)">
            {autoFireOn ? '⏹' : '⟳'}
          </button>
        </div>
      </div>

      {engine.block ? (
        <div className="game-overlay" style={{ zIndex: 20 }} role="alertdialog" aria-live="assertive" aria-label="Play stopped">
          <div className="box card">
            <div className="tag">{engine.block.kind === 'SELF_EXCLUDED' ? 'SELF-EXCLUSION ACTIVE' : engine.block.kind === 'ACCOUNT_BLOCKED' ? 'ACCOUNT BLOCKED' : 'DAILY LIMIT REACHED'}</div>
            <h2 style={{ margin: '0.35rem 0 0.5rem' }}>Play stopped by your own setting</h2>
            <p className="small muted" style={{ margin: 0 }}>
              {engine.block.message}
            </p>
            {engine.block.until ? (
              <p className="tiny dim" style={{ marginTop: '0.6rem' }}>
                Ends {new Date(engine.block.until).toLocaleString()}
              </p>
            ) : (
              <p className="tiny dim" style={{ marginTop: '0.6rem' }}>
                Your session was closed and {formatCoins(session.wagered)} was wagered today. Nothing else was charged.
              </p>
            )}
            <div className="row" style={{ gap: '0.6rem', justifyContent: 'center', marginTop: '1.1rem' }}>
              <Button variant="primary" size="sm" onClick={() => void leave()}>
                Back to dashboard
              </Button>
              <Button variant="ghost" size="sm" onClick={engine.dismissBlock}>
                Stay and watch the reef
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <Modal open={settingsOpen} title="Game settings" onClose={() => setSettingsOpen(false)}>
        <div className="col" style={{ gap: '0.9rem' }}>
          <div className="row-between">
            <div>
              <strong>Sound effects</strong>
              <div className="tiny dim">Cannon, hits and rewards</div>
            </div>
            <Toggle
              on={sfxOn}
              onChange={(value) => {
                setSfxOn(value);
                audio.setEnabled('sfx', value);
              }}
              label="Sound effects"
            />
          </div>
          <div className="row-between">
            <div>
              <strong>Music</strong>
              <div className="tiny dim">Ambient underwater bed</div>
            </div>
            <Toggle
              on={musicOn}
              onChange={(value) => {
                setMusicOn(value);
                audio.setEnabled('music', value);
              }}
              label="Music"
            />
          </div>
          <div className="row-between">
            <div>
              <strong>Auto-fire</strong>
              <div className="tiny dim">Keep firing while the button is held (F)</div>
            </div>
            <Toggle
              on={autoFireOn}
              onChange={(value) => {
                setAutoFireOn(value);
                engine.setAutoFire(value);
              }}
              label="Auto-fire"
            />
          </div>
          <hr className="divider" />
          <div className="row-between tiny">
            <span className="dim">Graphics quality (adaptive)</span>
            <span className="num">{Math.round(engine.stats.quality * 100)}%</span>
          </div>
          <div className="row-between tiny">
            <span className="dim">Frame rate</span>
            <span className="num">{Math.round(engine.stats.fps)} fps</span>
          </div>
          <div className="row-between tiny">
            <span className="dim">Fish / bullets on screen</span>
            <span className="num">
              {engine.stats.fish} / {engine.stats.projectiles}
            </span>
          </div>
          <div className="row-between tiny">
            <span className="dim">Configuration</span>
            <span className="num">{meta?.configVersion ?? '—'}</span>
          </div>
          <div className="row-between tiny">
            <span className="dim">Round</span>
            <span className="num">{engine.roundId ?? '—'}</span>
          </div>
          <hr className="divider" />
          <div className="row" style={{ gap: '0.5rem' }}>
            <Button size="sm" variant="ghost" onClick={() => void reload()}>
              Reload configuration
            </Button>
            <Button size="sm" variant="danger" onClick={() => setConfirmExit(true)}>
              Leave room
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={confirmExit}
        title="Leave the room?"
        onClose={() => setConfirmExit(false)}
        footer={
          <div className="row-between">
            <span className="tiny dim">Your demo coins and history are saved automatically.</span>
            <div className="row" style={{ gap: '0.5rem' }}>
              <Button variant="ghost" size="sm" onClick={() => setConfirmExit(false)}>
                Keep playing
              </Button>
              <Button variant="primary" size="sm" onClick={() => void leave()}>
                Leave room
              </Button>
            </div>
          </div>
        }
      >
        <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.6rem' }}>
          <div className="stat-tile">
            <div className="k">Shots</div>
            <div className="v">{formatCoins(session.shots)}</div>
          </div>
          <div className="stat-tile">
            <div className="k">Wagered</div>
            <div className="v" style={{ color: 'var(--coral)' }}>
              {formatCoins(session.wagered)}
            </div>
          </div>
          <div className="stat-tile">
            <div className="k">Rewarded</div>
            <div className="v" style={{ color: 'var(--aqua)' }}>
              {formatCoins(session.rewarded)}
            </div>
          </div>
        </div>
        <p className="small muted" style={{ marginTop: '0.9rem' }}>
          {user?.username}, the reef keeps running for anyone else in the room. Leaving does not refund an in-progress bet.
        </p>
      </Modal>
    </div>
  );
}
