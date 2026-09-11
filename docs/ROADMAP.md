# Roadmap

Deliberate deferrals, in the order that makes sense for a product like this.

## 1 — Hardening the demo (no new features, less risk)

* CI workflow: typecheck + both test suites + `e2e:flow`, plus a build artifact per PR.
* Load test: 200 sockets across 8 rooms, measure tick drift and p95 snapshot latency; publish the
  numbers so the `maxActiveFish`/`SNAPSHOT_MS` trade-off is evidence-based.
* Device matrix: real iOS Safari and Android Chrome passes (landscape lock, audio unlock,
  reconnect, thermal throttling with adaptive quality).
* Accessibility pass: focus order in the game shell, screen-reader labels for HUD numbers,
  colour-contrast audit on the reward colours, `prefers-contrast` variant.

## 2 — Multiplayer depth

Multiplayer is already the transport model (every room broadcasts events to its members), so this
is about richness rather than plumbing:

* Explicit team/co-op modes and per-seat scoring, with rewards still computed per player.
* Late-join catch-up: incremental state instead of a full snapshot for large rooms.
* Room-level chat/reactions with moderation, reporting and rate limits.
* Fair matchmaking by bet range and cannon level; spectator mode.

## 3 — Game content

* More species and movement patterns; fish behaviours that react to shots (schools that scatter).
* Objectives and missions (daily challenges) evaluated **server-side** from recorded events.
* Progression that never touches the wallet: cosmetics for the cannon skin, catch-log badges.
*jackpots that pay demo coins only, with published odds.
* A certification-friendly "odds sheet" endpoint: per-species spawn share × reward, so any round's
  expected return can be independently recomputed.

## 4 — Platform

* Account recovery via a real mail transport (the reset flow is complete except for sending).
* Email verification enforced as a play precondition, configurable per deployment.
* Two-factor authentication (TOTP) — the `profiles.two_factor_enabled` column already exists.
* Read-model separation: move history/leaderboard/report reads to a replica.
* Observability: OpenTelemetry traces, tick-time and collision-count metrics, a slow-query log.
* Data retention jobs for `game_events` (raw events age out; rounds, shots and the ledger do not).

## 5 — A licensed real-money deployment (separate programme, not a feature)

If — and only if — the operator has the approvals described in `docs/COMPLIANCE.md`. The codebase
already provides the seams; what must be *built* is the regulated part, none of which should ship
without the corresponding licence and evidence:

* Provider implementations of `PaymentProvider`: create/verify deposit, create/verify withdrawal,
  webhook signature verification against the raw body, idempotent crediting, reconciliation.
* KYC/identity integration with document storage and review workflow; AML screening and
  transaction monitoring with alerting.
* Geo-restriction enforcement at registration, funding and play.
* Wallet types for real currency with a separate ledger, segregated from demo coins entirely;
  dual-entry accounting and settlement reports.
* Responsible-gaming enforcement for *money*: pre-commit loss/deposit checks, cooling-off as a
  regulated product feature, self-exclusion with cross-brand propagation, activity statements.
  Time limits, self-exclusion and the play-time readout already exist and already stop play; the
  financial controls and their regulatory reporting do not.
* Game math certification pipeline: published RTP per room, RNG certification, tamper-evident
  configuration, regulator-facing exports.
* Age-gated marketing and promotion rules.

Nothing in this list should be "turned on" by flipping `REAL_MONEY_ENABLED`; that flag is a gate
that stays off until the programme above is complete and audited.
