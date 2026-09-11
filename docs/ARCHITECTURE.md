# Architecture

Reef Raiders is a fish-shooting arcade platform built as three workspace packages with a
single same-origin deployment surface.

```
                          ┌──────────────────────────────┐
   Browser (phone/tablet/ │  React SPA (packages/web)   │
   desktop)               │  ── lobby, wallet, history, │
                          │     settings, admin console │
                          │                             │
                          │  Canvas 2D game engine      │
                          │  ── render loop, sprites,   │
                          │     particles, input, audio │
                          └──────────┬──────────────────┘
                       REST (JSON)   │   WebSocket (events)
                       /api/*        │   /ws/game
                          ┌──────────▼──────────────────┐
                          │ Fastify API (packages/server)│
                          │  auth · users · wallet ·      │
                          │  game · config · admin ·      │
                          │  payments(demo) · reports     │
                          │                              │
                          │  RoundManager                 │
                          │   └─ RoomSimulation × N rooms │
                          │      fish · projectiles ·     │
                          │      collisions · rewards     │
                          └──────────┬───────────────────┘
                                     │ synchronous, transactional
                          ┌──────────▼───────────────────┐
                          │ SQLite (node:sqlite)         │
                          │ users · profiles · wallets ·  │
                          │ wallet_transactions · fish ·  │
                          │ cannons · game_rooms ·        │
                          │ game_rounds · game_sessions · │
                          │ player_shots · shot_hits ·    │
                          │ game_events · game_history ·  │
                          │ audit_logs · system_settings ·│
                          │ refresh_tokens · idempotency  │
                          └──────────────────────────────┘
```

## Why these technologies

| Concern | Choice | Reason |
| --- | --- | --- |
| Game rendering | Canvas 2D, hand-written engine | The scene is 2D sprites, particles and glow. Canvas 2D hits 60 FPS on mid-range phones, needs no WebGL context-loss handling, no GPU shader pipeline, and adds zero bundle weight. A heavier engine (WebGL/Pixi/Phaser) buys nothing here while costing 100 kB+ and a second learning surface for the team. |
| Game vs UI split | Canvas owns the play field; React owns everything else | The spec's requirement — never build the game from hundreds of DOM nodes — is satisfied structurally: React renders at most a few times per second (HUD numbers), the canvas runs at 60. They communicate through one callback object. |
| UI | React 19 + React Router 7 + CSS | Boring, well-understood, easy to review. No component library, so nothing about the visual identity is templated. |
| API | Fastify 5 | Fastest mainstream Node server, schema-friendly, plugin ecosystem covers cookie/CORS/rate-limit/WebSocket without custom code. |
| Database | SQLite via `node:sqlite` (built into Node 22) | The synchronous driver is the point: a wallet mutation must be a single uninterruptible unit. `BEGIN IMMEDIATE` plus a sync API means "read balance → write ledger → update balance" cannot interleave with another request. Swap the `Database` wrapper for Postgres to scale out; the SQL and constraint design port directly. |
| Validation | Zod, request-boundary only | Every route parses its body/query through a strict schema (`.strict()` rejects unknown keys), so mass-assignment is structurally impossible. |
| Auth | HS256 JWT access token + opaque rotating refresh token | Access tokens are verified synchronously (needed inside wallet transactions); refresh tokens are random 48-byte values stored only as SHA-256 hashes. |
| Realtime | WebSocket, event-level protocol | See below — the protocol is the interesting architectural decision. |
| Testing | Vitest (both packages) + a scripted end-to-end flow | Same runner for unit, integration and protocol tests. |

## The authority model

One rule drives the whole design: **the browser is a thin client that renders and
requests; it never decides.**

* The client sends *intents*: "I aimed at angle θ", "I fired cannon X with reference R".
* The server decides whether the shot exists, what it costs, what it hit, and what it pays.
* The wallet is touched only inside `RoundManager`/`ledger`, in an IMMEDIATE transaction,
  with amounts derived from the round's pinned configuration.
* The client may render a predicted projectile for feel, but a predicted hit is never shown
  as a reward: hit and defeat effects are drawn only from server messages. A prediction that
  the server disproved simply disappears.

Consequences: modifying the client cannot mint coins, and a client that never existed (an
attacker scripting the API directly) is subject to exactly the same rules.

## Deterministic motion: why the network is almost silent

A fish's position is a **pure function** of `(motion parameters, age, speed)`, in
`packages/shared/src/sim.ts`. The server evaluates it to decide collisions; the client
evaluates the same function to draw. So the network carries:

* one message when a fish spawns (its motion parameters + birth timestamp),
* one message when it despawns,
* one message per hit/defeat,
* throttled deltas that are usually empty.

It never carries per-frame positions. A four-player room with 45 fish and 90 projectiles
generates roughly 1–3 kB/s per client instead of ~100 kB/s for a naive 20 Hz full snapshot,
and every client sees fish in exactly the place the authoritative simulation put them,
because they are the same computation.

That shared module is also what makes the practice mode and the replay-based audit possible:
given a round's seed and configuration, the whole spawn sequence can be re-derived.

## Room, round, session — three separate lifetimes

| Object | Lifetime | Owner |
| --- | --- | --- |
| `game_rooms` | Until an operator changes it | Configuration |
| `game_rounds` | One round per room, ACTIVE until duration/idle/manual close | Created on demand by `ensureActiveRound()` |
| `game_sessions` | A player's visit to a room | Created by join, ended by leave/disconnect/round close |

`ensureActiveRound()` is the single place that creates a round, and both entry points
(REST join and the socket) call it. A room therefore has at most one ACTIVE round, and a
session can never reference a round that does not exist.

Rollover ends the round, creates a fresh one, and moves the spectators across **without
ending their sessions** — otherwise a routine round boundary would log everyone out.

## Configuration versioning

Economy tables (`fish`, `cannons`, `game_rooms`, `system_settings`) are the operator's
working copy. Publishing freezes them into an immutable `game_configs.payload` and marks it
active. A round stores `config_version` at creation and the running simulation keeps using
that pinned snapshot — so an edit never changes a round in progress, and every historical
round can still be reconciled against the exact numbers it ran with.

`admin → reports → rounds → audit` shows a round with its totals, per-player reconciliation,
seed and full configuration snapshot. That is the artefact a regulator or auditor asks for.

## Idempotency and money-safety

Three independent layers, because one of them being bypassed should not be fatal:

1. **`player_shots (user_id, client_ref)` UNIQUE.** A retried shot is detected before the
   rate limiter and before the balance check, and is answered with the original result. This
   is what makes "reconnect and resend" safe for the client.
2. **`wallet_transactions.idempotency_key` UNIQUE.** Bets use `bet:<shotId>`; rewards use
   `win:<shotId>:<fishKey>`. A duplicate credit is a no-op read of the original row.
3. **`wallets.balance >= 0` and `balance_after = balance_before + amount` CHECK constraints.**
   Even a bug in application code cannot produce a negative balance or a ledger row that
   disagrees with the balance it claims to have produced.

Plus: all mutations run inside one `BEGIN IMMEDIATE` transaction, and the single-threaded
Node event loop plus synchronous driver means there is no await point inside the critical
section to interleave with.

## Realtime layer

`packages/server/src/sim/round-manager.ts` owns a map of room runtimes and one `setInterval`
loop that ticks them all. Rooms with no spectators are frozen and closed, so an idle server
costs essentially nothing instead of simulating empty reefs. Messages per socket are capped
by a token bucket; oversize payloads are refused at the transport; every handler is wrapped so
one bad frame cannot kill the loop.

Multiplayer is therefore not a mode to add later: solo play is a room with one member. The
same broadcast path that currently notifies nobody extra already sends every other player's
shots, hits and defeats.

## Scaling path

Deliberate seams:

* **Multiple API nodes.** Room ownership must move from process memory to a registry
  (Redis/NATS) and the tick loop to a dedicated simulation process per room. The protocol,
  the sim module and the wallet boundary do not change: the sim is already isolated behind
  `RoomSimulation`, and every wallet write is already a single SQL transaction.
* **Postgres.** Replace `Database`'s four methods (`get`/`all`/`run`/`transaction`) with a
  pooled client, and swap `BEGIN IMMEDIATE` for `SELECT … FOR UPDATE` on the wallet row.
  The `CHECK` constraints and unique indexes carry over verbatim.
* **Read replicas** for history/leaderboard/report queries, which are already separated from
  the write path.
* **Snapshot offloading**: leaderboards and reports are aggregate queries that can be moved to
  a scheduled job without touching gameplay.

## What is *not* built, on purpose

* No real deposits, withdrawals, pricing or payment-provider integration. `PaymentProvider`
  exists as an interface plus `DemoPaymentProvider` (which rejects value transfers by design).
  `REAL_MONEY_ENABLED` is read from the environment at boot, and starting production with it
  `true` without a compliance attestation aborts the process. See `docs/COMPLIANCE.md`.
* No per-player outcome adjustment of any kind. There is no code path where identity,
  balance, or previous results feed into a reward calculation — see the fairness tests.
