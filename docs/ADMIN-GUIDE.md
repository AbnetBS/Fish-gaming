# Operator guide

Sign in at `/login` and open `/admin`. The bootstrap administrator is created on first run from
`BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` — change that password immediately in
**Settings**, or rotate it in the environment and re-seed.

Every screen shows the role you are signed in as and the active configuration version. If a
capability is missing for your role the section is hidden *and* the API will refuse it; hiding is
convenience, the refusal is the control.

## Dashboard

Total users, active users, active rooms, games today, shots today, demo coins wagered today,
demo rewards today, measured demo RTP today, and players online. Charts: signups per day,
shots per day, popular rooms, most-caught fish, activity by hour.

Two things to actually look at:

* **Ledger reconciliation** — "N wallets reconcile exactly" means every wallet balance equals the
  sum of its ledger rows. A mismatch here means something outside the application wrote to the
  database; the offending users are listed.
* **Measured RTP** — rewarded ÷ wagered for today. On the seeded demo table this is well above
  100% by design; the note on the card says so. It is a reporting figure, never a control.

If you changed something and have not published, the card shows *unpublished configuration changes
pending*.

## Fish

The fish table is the economy. Inline editing per species:

| Field | Effect |
| --- | --- |
| Health | Damage points the fish absorbs before it dies |
| Reward | Demo coins paid to whoever lands the killing shot |
| Speed | Logical units per second (scaled by the global game speed) |
| Size | Sprite scale and collision radius — bigger size means an easier target |
| Spawn weight | Share of the spawn lottery; 0 removes it from natural spawning |
| Min spawn interval | Per-species cooldown so one species cannot flood the reef |
| Movement | Straight, diagonal, sine, circular, curved, wander, boss |
| Palette | Renderer identity (13 built-in palettes) |
| Special | `golden` (×2), `treasure` (random bonus), `speed`, `bomb` (splash), `boss` (bonus school) |
| Enabled | Off stops spawning it; existing history keeps its labels |

A preview canvas shows the actual in-game sprite, live, so what you edit is what players see.
Deleting is a soft disable — history rows keep referencing the species.

**Rule of thumb while tuning:** reward ÷ (health ÷ cannon power × cannon cost) is the return on a
perfectly played kill. At 1.0 a break-even table has the same RTP as the shot cost; above it,
kills are profitable and misses are the only drain.

## Cannons

Level, power (damage per shot), shot cost (**this is the bet**), fire rate, projectile speed,
enabled. Levels are unique, and the room bet ranges select which cannons are usable where. A
cannon above a room's `maxBet` is simply not legal there — the room card says why rather than
showing a dead button.

## Rooms

Name, description, min/max bet, capacity, spawn multiplier, optional species pool, status. Setting
a room to `INACTIVE` closes its live round immediately and notifies everyone inside it.

## Game settings

Global simulation parameters: max active fish, spawns per second, max projectiles, round duration,
game speed, wave interval and size, min/max shot value, fish lifetime, special-fish toggle, RTP
target (reporting benchmark only).

## Configuration versioning

Edits land in a working copy. **Publish** freezes a snapshot, bumps the version
(`1.0.4 → 1.0.5`) and marks it active. Rounds already in play keep the version they started with;
new rounds pick up the new one. Under *Configuration history* every version can be **Inspected**
to see the exact fish/cannon/settings table it contained, and every round in Reports can be traced
to one.

Always add a change note: it goes into the audit log and into the published version itself.

## Users

Search by username or email, filter by status. Per account: balance, lifetime wagered/rewarded,
transaction count, recent ledger rows, recent sessions. Actions:

* **Suspend / reactivate** — requires a reason, revokes sessions, is audited. You cannot suspend
  your own account.
* **Demo coins** — a signed adjustment with a mandatory reason. It is only ever virtual coins;
  there is no equivalent operation for money, and there is no way to create one from this panel.
* **Player protection** — the panel shows the same numbers the game enforces: minutes played today
  against the player's daily limit, and any active self-exclusion. Suspending an account also removes
  the player from their live round (it is not a "next login" effect). **Lift exclusion** is available
  only while an exclusion is running, requires a reason, and writes `admin.self_exclusion.lift` to
  the audit log. There is no equivalent action for setting or shortening a player's limit: those are
  the player's own controls, and the design intent is that staff cannot weaken them.

Passwords are never displayed anywhere in the product, because only bcrypt hashes are stored.

## History, transactions, reports

* **Game history** — every shot across all players, filterable by result and room, CSV export.
* **Transactions** — the demo ledger with before/after balances, filterable by type, plus the
  reconciliation badge. CSV export.
* **Reports** — round-by-round table; **Audit** on any round gives totals, measured RTP, per-player
  reconciliation, the round's seed and the full configuration snapshot it ran with. That page is
  what you hand someone who disputes a result: seed + configuration + shot rows are enough to
  re-derive the outcome.

## Audit log

Filter by entity or action. Each entry shows actor, timestamp, what changed as a before/after
diff, and the affected record. The table is append-only at the database level (UPDATE and DELETE
raise), so this view cannot be scrubbed.

## System settings

Maintenance mode toggle (with a reason), runtime facts (currency, starting balance, active config,
tick rate, logical resolution), the raw `system_settings` table, and the flags in force. Enabling
maintenance closes live rounds, blocks joining, and tells connected players why.

## Before a "release" checklist

1. Reconcile: dashboard shows zero ledger mismatches.
2. Publish: no unpublished changes pending.
3. Sanity-play one round in each room at the extremes of the bet ladder.
4. Check measured RTP for the day is inside the band you intend to document.
5. Skim the audit log for the changes you expected and nothing else.
6. `npm run test && npm run e2e:flow -w @reef/server` green.
