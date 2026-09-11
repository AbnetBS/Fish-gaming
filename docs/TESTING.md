# Testing

```bash
npm test                     # both packages
npm run test:server          # 80 integration + unit tests
npm run e2e:flow -w @reef/server   # scripted full-product journey (90 checks)
```

## Server — `packages/server/tests/platform.test.ts`

Real SQLite files in a temp directory, real services, no mocks: the properties that matter only
hold if the actual transactions and constraints behave.

| Area | What is pinned |
| --- | --- |
| Registration & login | wallet + welcome credit created atomically; duplicate username/email rejection; password policy; no hash ever returned; refresh rotation; **re-use of a rotated token revokes the family**; lockout after N failures; suspension blocks login and refresh; single-use reset token; no enumeration |
| Session revocation | a cryptographically valid access token is refused the moment its session row is revoked |
| Ledger | negative balance impossible (service + CHECK constraint); idempotent credit/debit; `before + amount = after` for every row and contiguous across rows; integer-only amounts; free demo pack idempotency; admin adjustment requires a reason, is audited, cannot go below zero |
| Configuration | seeded baseline; edit does not affect the published version until publish; version bump; old snapshots retrievable; every field validated; audit diff recorded; **audit table is append-only at the engine level**; settings round-trip |
| Rooms & sessions | join binds session → round → config version; bet-range legality; room with no legal cannon cannot be entered; closed room and maintenance refused; one active session per player; leave summarises |
| Simulation | damage/kill/reward maths; a kill needs exactly its health; misses pay nothing; fish leave the field continuously; `maxActiveFish` and `maxProjectiles` caps hold under 400 ticks; **same seed ⇒ same spawn sequence**; **rewards identical across different players** for the same shot sequence; bomb splash credits each fish once |
| Round manager authority | cost charged per shot and recorded against the round; unknown/disabled cannon refused; out-of-range bet refused; **duplicate `clientRef` charges once**; rate limiting rejects before any money moves; insufficient funds leaves no shot row; angles clamped server-side; kill credits once, writes history, reconciles; duplicate reward attempt never pays twice; room capacity enforced at attach; rollover ends/re-opens/pins config and migrates spectators; **a mid-round config publish cannot change a live round**; four concurrent shooters serialise safely; the HTTP shot path runs the same checks as the socket |
| Reporting | leaderboards computed from the ledger only, no private fields leaked; admin stats count demo activity; round audit exposes totals, per-player reconciliation and the exact configuration used |
| Authorisation | role→capability maps are least-privilege per role; role/status resolved from the DB not the token; tampered/expired/malformed tokens rejected; every real-money entry point blocked; a registered "real" provider still cannot be used while the flag is off |
| Query safety | quote-shaped input is data (table survives, no rows); LIKE wildcards escaped; no cross-player read path |
| HTTP surface | ~35 assertions over the real routes: envelopes, 401/403 boundaries, idempotent fire over HTTP, maintenance gating, publish → config visible to clients, admin audit entries, security headers, no internal leakage in errors |

## Client — `packages/web/tests/`

* `engine.test.ts` — deterministic motion: identical parameters ⇒ identical poses for every
  pattern; continuous movement (no teleport per 50 ms step); spawn points outside the visible
  field; speed/game-speed scaling; angle normalisation and shortest-path lerp; circle overlap;
  particle pool capacity, recycling and ageing; presentation formatters.
* `render.test.ts` — headless render smoke test against a recording canvas double: every species
  bakes, sprite caching, a full frame (background, kelp, fish, projectiles, cannon, particles,
  boss bar, foreground, post), aspect-fit scaling for phone/monitor/tall viewports, low-quality
  path, and the engine's handling of `joined`/`delta`/`hit`/`defeat`/`shot`/`shotBroadcast`/
  `playerJoined`/`playerLeft`/`notice`/`explosion`/`bossDefeated`/unknown messages — including
  that a rejected shot rolls back the local prediction and that aim is clamped like the server.

## End-to-end flow — `packages/server/scripts/e2e-flow.ts`

Boots the real server on an ephemeral port and walks the journeys the product promises,
printing a pass/fail line per check. It is deliberately the same flow a reviewer would click
through:

1. health, meta (currency label, real-money flag, starting balance)
2. register → 201, token, wallet = 10,000, duplicate email rejected
3. room list → join → round id + legal cannon set
4. **live WebSocket play**: auth, join, aim, 45-shot volley, asserts snapshot/delta delivery,
   accepted shots, fish spawned, balance moved, at least one kill and reward
5. wallet, ledger (types present, no duplicate idempotency keys, contiguous balances), history
   rows, session summary, `game_events` per round type, round stores its config version
6. duplicate/`clientRef` replay protection, strict schema rejects an invented `reward`/`cost`,
   forged token rejected, unknown cannon refused
7. leaderboard correctness and privacy
8. admin: login, dashboard stats, ledger reconciliation, permission denial for a player token,
   edit fish → publish new version → audit entry with before/after → new version served to
   clients, room reconfiguration, invalid values rejected, maintenance on/blocked/off/reopen,
   round report and per-round configuration audit
9. a new round is pinned to the newly published version
10. return to dashboard, logout, and the revoked session cannot be used again

Exit code is non-zero if any check fails, so it drops into CI as-is.

## Manual checklist (touch devices)

There is no device farm here, so these are worth doing by hand before a release:

- [ ] Phone in landscape: controls reachable by thumb, page cannot scroll, canvas fills the
      viewport with letterboxing only where the aspect ratio demands it.
- [ ] Phone in portrait: rotate hint appears and "play in portrait" still works.
- [ ] Tap-to-fire registers on the first tap (audio unlock gesture).
- [ ] Airplane-mode mid-round → "Reconnecting…" banner, shots blocked, state re-synchronised,
      no duplicate charges after recovery.
- [ ] Two devices in the same room: both see each other's shots, hits and floating rewards;
      a kill by one player pays only that player.
- [ ] Reduced-motion OS setting: landing animation calms down.
