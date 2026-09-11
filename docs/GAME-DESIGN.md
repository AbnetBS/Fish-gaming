# Game design and economy

All numbers below are the **initial published values** written into the database on first
install. They are configuration, not code: an operator changes them in the admin panel,
publishes a version, and new rounds use the new values. The client fetches them at runtime.

## Core loop

```
aim cannon → fire (spends the shot cost = the bet) → server resolves the shot
   → fish damaged → fish defeated → configured reward credited → balance updates
   → history + ledger + leaderboard rows written
```

## Fish table

| Species | Category | Health | Reward | Speed | Size | Spawn weight | Movement |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Blue Darter | COMMON | 1 | 2 | 230 | 26 | 46 | Straight |
| Silver Sprat | COMMON | 1 | 2 | 265 | 23 | 38 | Sine |
| Coral Wrasse | MEDIUM | 3 | 5 | 185 | 34 | 24 | Wander |
| Sunset Angelfish | MEDIUM | 3 | 6 | 170 | 36 | 18 | Curved |
| Tide Grouper | LARGE | 10 | 20 | 120 | 52 | 10 | Diagonal |
| Reef Sentinel | LARGE | 10 | 22 | 110 | 54 | 8 | Circular |
| Lantern Ray | RARE | 25 | 50 | 95 | 68 | 4 | Wander |
| Abyss Angler | RARE | 30 | 60 | 88 | 64 | 3 | Curved |
| Golden Koi | SPECIAL | 5 | 25 | 320 | 30 | 2.5 | Sine |
| Treasure Coffer | SPECIAL | 14 | 40 | 105 | 44 | 1.6 | Straight |
| Velocity Fin | SPECIAL | 6 | 14 | 460 | 28 | 2 | Straight |
| Puffer Bomb | SPECIAL | 8 | 15 | 140 | 40 | 2 | Wander |
| Leviathan | BOSS | 120 | 260 | 62 | 118 | 0.6 | Boss |

Per-species fields also include `rarity`, `minSpawnIntervalMs` (per-species spacing so one
species cannot flood the reef), `palette` (renderer identity), `enabled`, and `sortOrder`.

### Special mechanics (published, identical for everyone)

* **Golden Koi — `golden`**: pays `reward × 2`. Fast and evasive; a skilled-aim bonus.
* **Treasure Coffer — `treasure`**: pays `reward + uniform(0 … reward × 2)`, drawn from the
  round's seeded RNG.
* **Velocity Fin — `speed`**: 460 units/s, the hardest normal target; no extra payout.
* **Puffer Bomb — `bomb`**: on defeat, deals 8 damage to every fish within 268 units. Fish
  killed by that splash pay their own reward to the player who triggered the bomb; chains are
  capped at 6 to bound the work.
* **Leviathan — `boss`**: crosses the field on a slow sweeping arc, shows a boss health bar, and
  on defeat releases a bonus school for the whole room.

## Cannons — the bet ladder

| Cannon | Level | Power (damage/shot) | Shot cost (bet) | Fire rate | Projectile speed |
| --- | --- | --- | --- | --- | --- |
| Tidecaster | 1 | 1 | 1 | 3.2/s | 1650 |
| Current Blaster | 2 | 2 | 2 | 3.0/s | 1750 |
| Reef Breaker | 3 | 5 | 5 | 2.6/s | 1850 |
| Abyss Cannon | 4 | 10 | 10 | 2.2/s | 1950 |
| Leviathan Mortar | 5 | 20 | 20 | 1.8/s | 2050 |

**The bet is the shot cost.** A room defines the legal range of shot costs, which is how it
controls stakes: choosing a bigger cannon in a deep room is the "higher bet" control, and the
`BET −/+` stepper in the arcade bar walks the legal subset for that room.

## Rooms

| Room | Bet range (demo coins/shot) | Seats | Spawn rate × |
| --- | --- | --- | --- |
| Shallow Lagoon | 1 – 5 | 4 | 1.00 |
| Coral Shelf | 5 – 25 | 4 | 1.15 |
| Kelp Canyon | 10 – 50 | 4 | 1.30 |
| Abyssal Trench | 20 – 100 | 4 | 1.45 |

Rooms also carry an optional `fishPool` (empty = every enabled species), a status flag, and their
own min/max which the API validates independently of the global `minShotValue`/`maxShotValue`.

## Global simulation settings

`maxActiveFish` 45 · `fishSpawnRate` 4.6/s · `maxProjectiles` 90 · `roundDurationS` 1800 ·
`gameSpeed` 1.0 · `waveIntervalS` 45 · `waveSize` 9 · `fishLifetimeS` 28 ·
`minShotValue` 1 · `maxShotValue` 100 · `specialFishEnabled` true · `rtpTarget` 0.90.

## Movement patterns

All motion is a closed-form function of age, so it is smooth, resumable and identical on every
client: `STRAIGHT`, `DIAGONAL`, `SINE` (lateral sine on the heading), `CIRCULAR` (orbit of radius
r at angular rate ω), `CURVED` (exponentially saturating arc), `WANDER` (two incommensurate
sines for organic drift), `BOSS` (slow crawl plus wide sweep).

Fish always spawn outside the visible field and are only despawned once they have left it (or
after a generous grace period), so nothing pops in or out mid-screen.

## Economy reading, honestly

With the seeded values a confirmed kill is profitable: a 1-health fish paying 2 for a cost-1
shot is +100% on that shot; a Tide Grouper (10 HP, reward 20) against a Reef Breaker (power 5,
cost 5) is two shots and +10. **That is intentional for a demo** — the player should feel
skilled, and demo coins have no value — but it also means measured RTP sits well above 100%
while hit rate is high.

The admin dashboard therefore shows measured RTP today, and the round report shows RTP per
round, so an operator can see exactly how generous the current table is. If this economy were
ever attached to value, `rtpTarget` is a reporting benchmark and the reward/health/cost columns
are the levers to bring measured RTP into the certified band. The `rtpTarget` setting does not
and must not alter any individual outcome.

## Fairness guarantees (and how they are tested)

* One shared fish field per room; nobody gets a private deck.
* All randomness comes from a per-round seed consumed in a deterministic order; replaying the
  seed reproduces the spawn sequence.
* Rewards are a pure function of `fishId → configured reward` plus a published special rule.
  Identity, balance, deposit history, prior wins and prior losses are not inputs to any outcome.
* The server never grants a reward the simulation did not compute, and never grants the same
  kill reward twice.

`docs/TESTING.md` lists the tests that pin these properties.
