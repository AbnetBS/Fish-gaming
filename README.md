# Reef Raiders — *Fish Game*

Next-generation underwater arcade gaming. A complete, self-hosted web platform for
fish-shooting arcade rooms: accounts, a server-authoritative canvas game, a real transaction
ledger, leaderboards, and a full administration panel for the game economy.

> **Virtual currency only.** Every balance, reward and ledger row in this codebase is **DEMO
> COINS** — a virtual credit with no cash value, no deposit rail and no payout path.
> `REAL_MONEY_ENABLED` is `false` and is a hard gate, not a marketing switch. See
> [docs/COMPLIANCE.md](docs/COMPLIANCE.md).

Built as a production-shaped system rather than a demo: the browser never declares a kill, the
wallet is an append-only ledger with atomic balance updates, and every economy number an admin can
change is versioned, audited and applied on the next round.

---

## Contents

- [Try it in 60 seconds](#try-it-in-60-seconds)
- [What actually works](#what-actually-works)
- [How the game is kept honest](#how-the-game-is-kept-honest)
- [Repository layout](#repository-layout)
- [Commands](#commands)
- [Configuration](#configuration)
- [Testing](#testing)
- [Deployment](#deployment)
- [Documentation](#documentation)
- [Assets and originality](#assets-and-originality)

---

## Try it in 60 seconds

Requires **Node.js ≥ 22.12** (the server uses the SQLite engine bundled with Node, so there is no
database to install and no native module to compile).

```bash
npm install
cp .env.example .env      # defaults are sane; nothing to sign up for
npm run dev
```

Open **http://localhost:5173**. On first boot the server creates `packages/server/data/reef-raiders.db`,
applies the schema, seeds 13 fish species / 5 cannons / 4 rooms and creates the bootstrap admin.

| Sign in as | Credentials | You get |
| --- | --- | --- |
| Player | *Register* a new account (10,000 DEMO COINS welcome credit) | Dashboard, rooms, live game, wallet ledger, history, leaderboard |
| Admin | `admin@reefraiders.local` / `ChangeMe!2345` | Everything above **plus** the admin console |

Want the whole product on one port instead of the Vite dev server?

```bash
npm run build && npm start      # API + client on http://localhost:3000
```

---

## What actually works

**Player.** Register → verify-style login with rotating refresh tokens → pick a room → play. The
game screen is an arcade canvas at a 1920×1080 logical resolution scaled to any viewport, with a
top HUD (balance, room, bet, cannon, settings) and bottom controls (cannon selector, FIRE, bet
+/−, special weapon). Portrait phones, tablets, laptops and desktops are all first-class; page
scroll is locked while playing and touch targets are sized for thumbs.

**Gameplay.** Held-fire auto-fire with aim tracking, swept projectile collision, splash damage,
golden fish, treasure coffers with variable payouts, a spawning boss, per-species behaviour,
combo/anti-frustration tuning and screen-filling particle feedback. Rounds are persistent rooms:
players who join mid-round share the same reef, the same fish and the same round id.

**Economy.** `shot → server cost → server-rolled reward → ledger row → balance`, all inside one
SQLite transaction with an idempotency key. Kills credit exactly the configured reward for the
shooter only. Demo top-up plans are clearly labelled and grant virtual credit idempotently.

**Multiplayer.** One authoritative simulation per room, broadcast to every member at a configurable
snapshot rate. Only meaningful events cross the wire (`snapshot`, `shotAck`, `hit`, `explosion`,
`kill`, `bossDefeated`, `playerJoined/Left`, `balance`, `roundRolledOver`) — never physics chatter.

**Admin console.** Full CRUD on fish, cannons, rooms and global settings, each edit staged into a
draft and released as a **published configuration version** with a semantic version and changelog;
in-flight rounds keep the version they started with. Plus user management with status controls,
manual demo-coin adjustments (reason required), round-by-round audit replay of any round against the
exact config it ran on, wallet transaction search, CSV report export, live KPIs, an append-only
audit log, and a maintenance switch that closes rounds cleanly and tells players why.

**Security.** Argon-family bcrypt password hashing, short-lived access tokens revalidated against
the DB session row (so revocation is instant), refresh-token reuse detection, double-submit CSRF
cookies on unsafe methods, strict CORS with credentials, per-user and per-route rate limits,
account lockout, session listing with revoke-all, security headers (CSP/`X-Frame-Options`/HSTS in
production), and error responses that never leak internals — clients get a friendly message plus a
`requestId`, operators get the detail in the log.

**Player protection.** A daily play limit in minutes and a self-exclusion are enforced by the server
in the shot path — not displayed as a preference. See [Responsible gaming](#responsible-gaming).


## How the game is kept honest

```
 browser (React UI + canvas renderer)        node server (the only authority)
 ┌───────────────────────────────┐            ┌────────────────────────────────────────┐
 │ input: aim angle, fire, bet   │  WS / HTTP │ RoundManager — one runtime per room    │
 │ render: interpolation only    │ ─────────▶ │  ├─ RoomSimulation (authoritative sim) │
 │                               │ ◀───────── │  ├─ snapshot / event broadcast          │
 │ no balance, no rng, no reward │            │  └─ wallet.ledger + game_rounds        │
 └───────────────────────────────┘            │        in ONE SQLite transaction       │
                                              └────────────────────────────────────────┘
```

- The client sends **intent** (`fire`, `aim`, `selectCannon`, `setBet`). It can never send a kill,
  a reward, a balance or a role; the server ignores any such field.
- Rewards come from the server's seeded RNG, pinned to the round's configuration version, so a
  round can be replayed and audited exactly.
- `player_shots(user_id, client_ref)` is UNIQUE and `wallet_transactions.idempotency_key` is UNIQUE:
  a replayed packet costs nothing and pays nothing.
- `CHECK (balance >= 0)` and `CHECK (after_balance = before_balance + amount)` make an inconsistent
  wallet impossible at the storage layer; `audit_logs` has `BEFORE UPDATE/DELETE` triggers that raise,
  so the audit trail is append-only.
- Configuration publication never mutates a live round. One `ACTIVE` round per room is enforced by
  a partial unique index.

## Repository layout

```
packages/
  shared/   @reef/shared  — types, protocol messages, economy constants,
                            deterministic sim math, baseline fixtures
  server/   @reef/server  — Fastify 5 API, WebSocket hub, authoritative simulation,
                            SQLite (node:sqlite) storage, migrations, seed, admin modules
    src/
      config/     env parsing + the REAL_MONEY_ENABLED policy gate
      db/         sync DB wrapper, schema.sql, migrator, seed
      security/   password hashing, HS256 tokens, rate/CSRF helpers
      http/       app assembly, auth plumbing, route modules (auth/account/game/admin/public)
      sim/        room-simulation.ts (game rules) + round-manager.ts (wallets, rounds, sockets)
      modules/    users, wallet, game, config, reports, payments — one domain each
      ws/         game socket protocol
    scripts/      e2e-flow.ts (76-check journey), reset-db.ts, copy-assets.mjs
  web/      @reef/web     — React 19 UI + framework-free canvas engine
    src/
      game/       Engine.ts (loop/interpolation), Renderer.ts, Sprites.ts, Particles.ts,
                  Audio.ts, Net.ts — no React inside the render loop
      hooks/      useGameEngine.ts — bridges engine ↔ React state
      pages/      landing, auth, dashboard, rooms, play, wallet, history, leaderboard,
                  profile, settings, responsible gaming, + admin/* (11 screens)
      state/      AuthContext, PlatformContext (config/flags), toast system
docs/             architecture, security, compliance, game design, API, testing,
                  admin guide, deployment, roadmap
```

89 TypeScript/TSX source files, ~18.5k lines. No game code depends on React, and no UI code depends
on the server beyond typed HTTP/WS calls.

## Commands

| Command | Does |
| --- | --- |
| `npm run dev` | API on :3000 + Vite on :5173 (proxies `/api` and `/ws`) |
| `npm run build` | shared → server (incl. asset copy) → web |
| `npm start` | Production mode: API serves the built client |
| `npm test` | Server + web suites (shared: `npm run test -w @reef/shared`) |
| `npm run typecheck` | `tsc --noEmit` across all three packages |
| `npm run e2e:flow` | End-to-end player/admin journey, 76 assertions |
| `npm run db:seed` / `db:reset` | Re-seed baseline economy / drop the dev database |

## Configuration

Everything lives in [`.env.example`](.env.example) — copy it to `.env`. Nothing gameplay-related is
hard-coded in the client: the browser fetches `/api/config` and renders whatever the server says.

The variables that matter most:

| Variable | Default | Notes |
| --- | --- | --- |
| `REAL_MONEY_ENABLED` | `false` | Hard gate. Production refuses to boot with it `true` unless `REAL_MONEY_ATTESTATION` (≥16 chars of signed attestation) is also present. No route bypasses it. |
| `STARTING_DEMO_COINS` | `10000` | Welcome credit, virtual |
| `JWT_SECRET` | dev value | ≥32 random bytes; the server logs a warning if it looks like the dev default |
| `SIM_TICK_MS` / `SNAPSHOT_MS` | 50 / 50 | Authoritative tick and outbound sync rate |
| `ROUND_DURATION_S` | `1800` | Auto rollover to a fresh round (new config version takes effect here) |
| `DB_FILE` | `./data/reef-raiders.db` | Put this on persistent storage |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | 300 / 60000 | Per-user quota |

Room/fish/cannon/simulation *rules* are not env vars — they are database rows managed through the
admin console and released as configuration versions.

## Testing

```bash
npm test                          # server + web
npm run test -w @reef/shared      # economy + sim math
npm run e2e:flow                  # full journey against a throwaway database
```

Latest run on this checkout: **80 server tests + 20 web tests + 16 shared tests passing** (116 total),
**e2e flow 90/90 checks**, clean `typecheck` on all three packages and a green production build.
Coverage concentrates where bugs would be expensive rather than visible: wallet invariants (no
negative balance, ledger/balance reconciliation, replay safety), authority invariants (client-sent
rewards ignored, one shooter paid per kill, a player who leaves cannot shoot with someone else's
seat), configuration versioning (draft isolation, publication only on the next round), auth/session
lifecycle (revocation, refresh-token reuse detection, lockout), player-protection enforcement (a
daily limit actually stops shots, an exclusion cannot be lifted by its author), and the multiplayer
edge cases (shared reef identity, seat allocation, leave/detach).

See [docs/TESTING.md](docs/TESTING.md).


## Deployment

```bash
docker build -t reef-raiders .
docker run -p 3000:3000 -e NODE_ENV=production \
  -e JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
  -v reef-data:/app/data reef-raiders
```

Or `JWT_SECRET=… docker compose up --build` — the compose file wires the same thing with a health
check, a named volume for the data directory, `no-new-privileges` and log rotation. `/api/health`
is the readiness probe; the image runs as an unprivileged user and contains no dev dependencies.
nginx/Caddy reverse-proxy config, backup procedure, scaling notes and CDN options:
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Documentation

| Document | Read it when |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | You want the package map, request lifecycle, sim tick anatomy |
| [GAME-DESIGN.md](docs/GAME-DESIGN.md) | You need fish/cannon/room tuning rules and payout math |
| [API.md](docs/API.md) | Every REST endpoint and WebSocket message, with schemas |
| [SECURITY.md](docs/SECURITY.md) | Threat model, controls, what is deliberately not trusted |
| [COMPLIANCE.md](docs/COMPLIANCE.md) | Anything to do with real money, age, geo, licensing |
| [ADMIN-GUIDE.md](docs/ADMIN-GUIDE.md) | Operating the console: configs, versions, audit, maintenance |
| [TESTING.md](docs/TESTING.md) | What is covered, how to run it, how to add cases |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Local, Docker, reverse proxy, backups, scaling out |
| [ROADMAP.md](docs/ROADMAP.md) | What is intentionally not built yet |

## Assets and originality

Every visual and audio element is generated for this project: fish, cannon, projectiles, bubbles,
coral, HUD icons and the brand mark are drawn procedurally on canvas from code in
`packages/web/src/game/Sprites.ts`; sound effects are synthesised from oscillators and noise buffers
in `Audio.ts`. There are no sprite-sheet downloads, no third-party audio, no font licences to
track, and no attempt to reproduce the art, UI, branding or level layouts of existing commercial
fish-hunting titles. Names, species, rooms and copy are original.

## Responsible gaming

The protections here are enforced in the play path rather than printed on a page:

* **Daily play limit** — the player picks a number of minutes; usage is summed from their real
  `game_sessions` rows for the current UTC day. The allowance becomes an armed deadline the moment
  they attach, so past the budget every further shot is refused on *both* transports and the session
  is closed. A limit changed while someone is mid-round is picked up by a two-second sweep per room.
* **Self-exclusion** — 24 hours to 90 days, startable by the player at any time, effective within
  seconds even mid-round, and impossible to shorten from their own account. Lifting needs an admin
  with user-write permission plus a reason, and is written to the audit log.
* **New sign-in alerts** — the Settings toggle gates a server-side comparison against the player's
  other live sessions, surfaced as a dismissible dashboard notice.
* **No spend pressure** — nothing can be purchased, no loss-recovery affordances, no bonuses that
  require playing more.

Because the currency is virtual these are guardrails for habit-forming design rather than statutory
tools — and they are the seed of what a licensed deployment must grow into. **A real-money version
requires independent licensing, age verification, KYC/AML, geo-restrictions and responsible-gaming
obligations before anything moves value.** That is a policy and legal exercise, not a feature toggle.


## License

UNLICENSED / proprietary. All rights reserved.
