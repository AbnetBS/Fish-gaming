import { Link, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { BrandMark } from '../components/BrandMark';
import { OceanBackdrop } from '../components/OceanBackdrop';
import { Button } from '../components/ui';
import { useAuth } from '../state/AuthContext';
import { usePlatform } from '../state/PlatformContext';
import { Engine } from '../game/Engine';
import { api } from '../lib/api';
import { audio } from '../game/Audio';

const FAQ = [
  {
    q: 'Is this gambling?',
    a: 'No. Reef Raiders is a skill-and-reflex arcade game played with virtual DEMO COINS. Coins cannot be bought, cashed out or transferred, and there is no prize of any kind. Nothing on this site represents money.',
  },
  {
    q: 'How many demo coins do I start with, and what happens when I run out?',
    a: 'Every new account starts with a welcome balance of 10,000 DEMO COINS, credited automatically by the server. When you run low you can claim another free demo pack from the wallet at any time.',
  },
  {
    q: 'Does it really work on a phone?',
    a: 'Yes. The renderer targets 1920×1080 logical pixels and scales to any viewport, controls are thumb-sized, and the whole screen locks to landscape play with no page scrolling while a round is live.',
  },
  {
    q: 'Who decides what a fish is worth?',
    a: 'The server does. Every fish, cannon, room and spawn parameter lives in the admin-controlled configuration system. Each round records the exact configuration version it used, so results can be re-derived and audited after the fact.',
  },
  {
    q: 'Is the game multiplayer?',
    a: 'Rooms are built for shared, server-authoritative play: shots, spawns, hits and defeats are broadcast as events and every player sees the same reef. Solo demo play uses the same engine, so you can practice alone in an identical room.',
  },
  {
    q: 'Can I play for real money?',
    a: 'No. Real-money mode is permanently disabled in this build by a deployment-level feature flag, and enabling it is not a configuration change — it would require independent licensing, age verification, KYC/AML, geographic and responsible-gaming approval first.',
  },
];

const FEATURES = [
  { icon: '🌊', title: 'Living underwater arena', body: 'Layered reef, drifting light shafts, caustics, bubbles and 13 original procedurally drawn species.' },
  { icon: '🎯', title: 'Frame-precise aiming', body: 'The cannon tracks your pointer or thumb with smooth rotation, a reticle and a live aim guide.' },
  { icon: '💥', title: 'Destruction that pays', body: 'Every hit flashes, bursts into bubbles and debris, and floats a reward number as the ledger updates.' },
  { icon: '🐠', title: 'Boss and special fish', body: 'Golden Koi, Treasure Coffer, Velocity Fin, Puffer Bomb and the Leviathan each have explicit, published mechanics.' },
  { icon: '📱', title: 'Built for touch first', body: 'Landscape play, thumb-sized controls, no page scroll, and adaptive effects that hold 60 FPS on mid-range phones.' },
  { icon: '🛡️', title: 'Server-authoritative economy', body: 'Balance, cost and reward are never taken from the browser. Shots are idempotent so a retry cannot double-spend.' },
  { icon: '📊', title: 'Auditable configuration', body: 'Versioned configs with before/after audit entries for every change an operator makes to the game.' },
  { icon: '🏆', title: 'Daily, weekly, all-time', body: 'Leaderboards are computed from the transaction ledger, so rankings reflect recorded results, not client claims.' },
  { icon: '🔊', title: 'Synthesised arcade audio', body: 'All sound is generated in the browser — no third-party samples — with independent music and SFX switches.' },
];

const STEPS = [
  { title: 'Create an account', body: 'Register with a username, email and password. Your demo wallet is created at the same moment.' },
  { title: 'Pick a room', body: 'Four reefs from Shallow Lagoon to Abyssal Trench. Each has its own bet range and density.' },
  { title: 'Aim and shoot', body: 'Drag to rotate the cannon, tap or hold to fire. Every shot spends the bet shown on the bar.' },
  { title: 'Bank the reward', body: 'Defeat fish to earn demo coins. History, transactions and the leaderboard update as you play.' },
];

export function Landing(): JSX.Element {
  const navigate = useNavigate();
  const { isAuthed } = useAuth();
  const { meta, config } = usePlatform();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rooms, setRooms] = useState<Awaited<ReturnType<typeof api.rooms>>['rooms']>([]);

  // A real, live slice of the game engine plays behind the hero copy.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !config) return;
    const engine = new Engine(canvas, {
      onSound: (name, intensity) => audio.play(name, { intensity }),
    });
    engine.setSpecies(config.fish);
    engine.enablePractice(true);
    engine.setAutoFire(true);
    engine.setLocalPlayer({ id: 'hero', cannonKey: 'reef_breaker', level: 3, fireRate: 2.2 });
    engine.resize(canvas.clientWidth || 640, canvas.clientHeight || 360);
    engine.start();
    const onResize = () => engine.resize(canvas.clientWidth, canvas.clientHeight);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      engine.destroy();
    };
  }, [config]);

  useEffect(() => {
    api
      .rooms()
      .then((payload) => setRooms(payload.rooms))
      .catch(() => setRooms([]));
  }, []);

  const start = (): void => {
    navigate(isAuthed ? '/play' : '/register');
  };

  return (
    <div className="landing">
      <div className="ocean-backdrop-wrap">
        <OceanBackdrop density={1.1} />
      </div>

      <nav className="landing-nav">
        <div className="inner">
          <BrandMark />
          <div className="links">
            <a className="text" href="#how-it-works">
              How it works
            </a>
            <a className="text" href="#features">
              Features
            </a>
            <a className="text" href="#rooms">
              Rooms
            </a>
            <a className="text" href="#how-to-play">
              Controls
            </a>
            <a className="text" href="#faq">
              FAQ
            </a>
            {isAuthed ? (
              <Button size="sm" variant="primary" onClick={() => navigate('/dashboard')}>
                Dashboard
              </Button>
            ) : (
              <>
                <Button size="sm" variant="ghost" onClick={() => navigate('/login')}>
                  Log in
                </Button>
                <Button size="sm" variant="primary" onClick={() => navigate('/register')}>
                  Register
                </Button>
              </>
            )}
          </div>
        </div>
      </nav>

      <header className="hero">
        <div className="container">
          <div>
            <span className="hero-eyebrow">
              <span className="dot" aria-hidden="true" />
              Underwater arcade · demo coins only
            </span>
            <p className="brand-line">Fish Game</p>
            <h1>Reef Raiders</h1>
            <p className="subtitle">Next-generation underwater arcade gaming.</p>
            <p className="muted" style={{ marginTop: '0.8rem', maxWidth: '46ch', lineHeight: 1.6 }}>
              Aim a cannon, hunt a living reef and climb the leaderboard — on the phone in your pocket or the monitor on your desk.
              No downloads, no purchases, no cash: every coin you see is a virtual demo coin.
            </p>
            <div className="hero-cta">
              <Button size="lg" variant="primary" onClick={start}>
                ▶ Play demo
              </Button>
              <Button size="lg" variant="gold" onClick={() => navigate('/register')}>
                Register
              </Button>
              <Button size="lg" variant="ghost" onClick={() => navigate('/login')}>
                Log in
              </Button>
            </div>
            <div className="hero-meta">
              <div className="item">
                <div className="k">Welcome balance</div>
                <div className="v">10,000 <span style={{ fontSize: '0.72rem', color: 'var(--gold)' }}>DEMO</span></div>
              </div>
              <div className="item">
                <div className="k">Species in the reef</div>
                <div className="v">{config?.fish.length ?? 13}</div>
              </div>
              <div className="item">
                <div className="k">Game rooms</div>
                <div className="v">{rooms.length || config?.rooms.length || 4}</div>
              </div>
              <div className="item">
                <div className="k">Real-money mode</div>
                <div className="v" style={{ color: 'var(--coral)' }}>Disabled</div>
              </div>
            </div>
          </div>

          <div className="hero-card">
            <span className="badge badge-cyan ribbon">Live engine preview</span>
            <canvas ref={canvasRef} />
            <div className="overlay">
              <span className="dot" aria-hidden="true" />
              <span>
                Rendering {config?.settings.maxActiveFish ?? 45} fish max · config {meta?.configVersion ?? '—'} · deterministic client
                prediction
              </span>
            </div>
          </div>
        </div>
      </header>

      <section className="section" id="how-it-works">
        <div className="container">
          <div className="section-head">
            <span className="kicker">How it works</span>
            <h2>Four steps to your first catch</h2>
            <p>The whole loop is designed so a first-time player is shooting within about ten seconds of arriving.</p>
          </div>
          <div className="steps">
            {STEPS.map((step) => (
              <article className="step" key={step.title}>
                <h4>{step.title}</h4>
                <p>{step.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-alt" id="features">
        <div className="container">
          <div className="section-head">
            <span className="kicker">Game features</span>
            <h2>Built like an arcade cabinet, shipped like a web app</h2>
          </div>
          <div className="features">
            {FEATURES.map((feature) => (
              <article className="feature" key={feature.title}>
                <span className="ico" aria-hidden="true">
                  {feature.icon}
                </span>
                <div>
                  <h4>{feature.title}</h4>
                  <p>{feature.body}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="rooms">
        <div className="container">
          <div className="section-head">
            <span className="kicker">Game rooms</span>
            <h2>Choose your depth</h2>
            <p>
              Bet ranges below are configured by the operator, not hard-coded — these are the live values from the running
              configuration.
            </p>
          </div>
          <div className="rooms-grid">
            {(rooms.length ? rooms : (config?.rooms ?? [])).map((room, index) => (
              <article className="room-card" key={room.id ?? room.key}>
                <span className="depth" aria-hidden="true" />
                <span className="depth-tag">Zone {index + 1}</span>
                <h4>{room.name}</h4>
                <p>{room.description}</p>
                <div className="bet">
                  <span className="tiny dim upper">Min bet</span>
                  <b>{room.minBet}</b>
                  <span className="tiny dim">to {room.maxBet} demo coins</span>
                </div>
                <div className="row" style={{ marginTop: '0.5rem' }}>
                  <span className="badge">{room.maxPlayers} seats</span>
                  <span className="badge badge-cyan">1080p logical</span>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-alt" id="mobile">
        <div className="container mobile-split">
          <div>
            <span className="kicker">Mobile gaming</span>
            <h2 style={{ fontSize: 'clamp(1.6rem,4vw,2.4rem)', marginTop: '0.5rem' }}>Designed for thumbs, not for mice bolted to phones</h2>
            <p className="muted" style={{ marginTop: '0.9rem', lineHeight: 1.65 }}>
              Drag anywhere on the reef to rotate the cannon. Tap the fire ring to shoot, or hold it for continuous fire at the
              cannon's rated cadence. The bet stepper and weapon rail sit under your thumbs, the page cannot scroll during play, and
              the whole interface rotates to landscape. On a weaker device the renderer quietly drops glow and scanline passes before
              it ever drops frames.
            </p>
            <ul className="col" style={{ marginTop: '1.1rem', gap: '0.5rem', listStyle: 'none', padding: 0 }}>
              {[
                'Landscape-first arcade layout with safe-area insets',
                'Touch targets sized for fingers, never for cursors',
                'Adaptive quality: 60 FPS target with graceful degradation',
                'Reconnects automatically and re-synchronises authoritative state',
              ].map((point) => (
                <li key={point} className="row" style={{ gap: '0.5rem', color: 'var(--muted)', fontSize: '0.92rem' }}>
                  <span style={{ color: 'var(--aqua)' }}>✓</span>
                  {point}
                </li>
              ))}
            </ul>
            <div style={{ marginTop: '1.4rem' }}>
              <Button variant="primary" onClick={start}>
                Open the game
              </Button>
            </div>
          </div>
          <div className="phone-demo">
            <div className="phone-frame">
              <span className="notch" aria-hidden="true" />
              <OceanBackdrop density={0.6} />
              <div className="fake-hud" aria-hidden="true">
                <span className="pad" />
                <span className="fire" />
                <span className="pad" />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="how-to-play">
        <div className="container">
          <div className="section-head">
            <span className="kicker">How to play</span>
            <h2>Controls</h2>
          </div>
          <div className="features">
            {[
              { k: 'Aim — desktop', v: 'Move the mouse anywhere on the reef. The cannon rotates toward the pointer.' },
              { k: 'Shoot — desktop', v: 'Click to fire once, hold to fire continuously. Keys 1–5 select cannons, Space fires, F toggles auto-fire, Esc exits.' },
              { k: 'Aim — mobile', v: 'Drag a finger across the play area; the cannon follows it.' },
              { k: 'Shoot — mobile', v: 'Tap the big FIRE ring for one shot; hold it for sustained fire.' },
              { k: 'Bet — either', v: 'Use BET − / + or tap a cannon chip. The number shown is the cost of every shot in that room.' },
              { k: 'Exit', v: 'Leave returns you to the dashboard with your session totals; the reef keeps running for other players.' },
            ].map((row) => (
              <article className="feature" key={row.k}>
                <div>
                  <h4>{row.k}</h4>
                  <p>{row.v}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-alt" id="faq">
        <div className="container">
          <div className="section-head">
            <span className="kicker">FAQ</span>
            <h2>Straight answers</h2>
          </div>
          <div className="faq">
            {FAQ.map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                <div className="body">{item.a}</div>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="section" id="responsible">
        <div className="container grid" style={{ gap: '1rem' }}>
          <div className="section-head" style={{ marginBottom: 0 }}>
            <span className="kicker">Responsible gaming</span>
            <h2>Play for fun, not for money</h2>
          </div>
          <div className="notice-box">
            <strong style={{ color: 'var(--gold)' }}>This version uses virtual DEMO COINS only.</strong>
            <p className="muted" style={{ marginTop: '0.5rem', lineHeight: 1.6 }}>
              Demo coins have no cash value and cannot be purchased, withdrawn, exchanged or transferred. There are no prizes. Time
              limits and self-exclusion controls exist in the account settings and are enforced by the server, so the same guardrails
              are already in place if a licensed operator ever enables real-money play under their own regulatory approvals. This is an
              entertainment product for players 18 and over.
            </p>
          </div>
          <div className="row wrap" style={{ gap: '0.6rem' }}>
            <Link className="btn btn-ghost btn-sm" to="/responsible-gaming">
              Read the full policy
            </Link>
            <span className="tiny dim">18+ · No purchase necessary · Nothing here is a wager</span>
          </div>
        </div>
      </section>

      <section className="section section-alt" id="contact">
        <div className="container">
          <div className="section-head">
            <span className="kicker">Contact</span>
            <h2>Talk to the crew</h2>
          </div>
          <div className="contact-grid">
            {[
              { title: 'Player support', body: 'Account, wallet and gameplay questions. Replies within one business day.', mail: 'support@reefraiders.example' },
              { title: 'Operator / compliance', body: 'Licensing, configuration auditing, data retention and audit-log requests.', mail: 'compliance@reefraiders.example' },
              { title: 'Press & partnerships', body: 'Arcade deployments, venue demos and integration questions.', mail: 'hello@reefraiders.example' },
            ].map((card) => (
              <article className="card card-pad" key={card.title}>
                <h4>{card.title}</h4>
                <p className="small muted" style={{ marginTop: '0.4rem', lineHeight: 1.55 }}>
                  {card.body}
                </p>
                <a className="btn btn-ghost btn-sm" style={{ marginTop: '0.8rem' }} href={`mailto:${card.mail}`}>
                  {card.mail}
                </a>
              </article>
            ))}
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <div className="container col" style={{ gap: '0.5rem' }}>
          <div className="row-between wrap">
            <BrandMark />
            <span className="tiny">© {new Date().getFullYear()} Reef Raiders — a fictional demo product.</span>
          </div>
          <p className="tiny" style={{ lineHeight: 1.6 }}>
            Reef Raiders is an arcade-style entertainment game using virtual DEMO COINS. It is not a gambling product, offers no
            prizes, and does not accept deposits or process withdrawals. Real-money play is disabled at the platform level and would
            require separate legal authorisation. All artwork, audio and code are original to this project.
          </p>
          <div className="row wrap tiny">
            <Link to="/responsible-gaming">Responsible gaming</Link>
            <span className="dim">·</span>
            <Link to="/login">Log in</Link>
            <span className="dim">·</span>
            <Link to="/register">Create an account</Link>
            <span className="dim">·</span>
            <span>18+</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
