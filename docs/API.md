# API reference

Base URL: same origin as the client (`/api`). All request and response bodies are JSON.
Validation is strict: unknown keys in a body are a `400`, not silently dropped.

## Error envelope

Every non-2xx response has the same shape, and never contains SQL, stack traces, file paths or
secrets:

```json
{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "Not enough demo coins.", "requestId": "mtw6j55ebcydcz" } }
```

`requestId` correlates with the server log line, so a user can report a message and staff can
find the cause without exposing internals to the browser.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | Schema or range violation |
| `UNAUTHENTICATED` | 401 | Missing, expired or revoked token |
| `FORBIDDEN` | 403 | Authenticated but lacking the capability (or CSRF mismatch) |
| `REAL_MONEY_DISABLED` | 403 | Value-transfer endpoint; always, in this build |
| `INSUFFICIENT_FUNDS` | 402 | Wallet cannot cover the shot |
| `NOT_FOUND` | 404 | Unknown resource or route |
| `ROOM_FULL` / `INVALID_SESSION` / `MAINTENANCE` / `ROOM_UNAVAILABLE` / `BET_OUT_OF_RANGE` / `WEAPON_UNAVAILABLE` / `NO_ACTIVE_SESSION` / `GAME_UNAVAILABLE` | 409 | Gameplay preconditions |
| `ACCOUNT_SUSPENDED` | 403 | Account is suspended |
| `RATE_LIMITED` | 429 | Too fast; may include `details.waitMs` |
| `INTERNAL` | 500 | Unexpected — logged in full server-side only |

## Authentication

All protected routes accept `Authorization: Bearer <accessToken>`. The SPA also receives an
httpOnly `rr_at` access cookie, an httpOnly `rr_rt` refresh cookie (path `/api/auth`) and a
readable `rr_csrf` token that must be echoed in `X-CSRF-Token` for cookie-authenticated writes.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | `username, email, password, acceptTerms` | 201; creates profile + wallet + welcome demo credit (idempotent per user); returns tokens |
| POST | `/api/auth/login` | `identifier, password` | `identifier` is email or username; rate limited 12/5 min; lockout after 8 failures |
| POST | `/api/auth/refresh` | – (cookie) or `refreshToken` | Rotates; reuse revokes the token family |
| POST | `/api/auth/logout` | – | Revokes the current session |
| GET | `/api/auth/me` | – | User, profile, wallet, resolved permissions |
| POST | `/api/auth/forgot-password` | `email` | Identical response whether or not the account exists; dev-only `devResetToken` outside production |
| POST | `/api/auth/reset-password` | `token, password` | Single use; revokes all sessions |
| POST | `/api/auth/verify-email` | `token` | Flips `PENDING_VERIFICATION` → `ACTIVE` |
| GET | `/api/auth/sessions` | – | Active session list (IP, UA, times) |
| POST | `/api/auth/sessions/revoke-all` | – | Sign out everywhere |

## Account and wallet

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/me` | User, profile, wallet, lifetime demo totals |
| PATCH | `/api/me/profile` | `displayName, country, bio, language, loginNotify, sessionLimitMin` — the last two change server behaviour, not just stored text |
| POST | `/api/me/password` | `currentPassword, newPassword`; revokes other sessions; audited |
| POST | `/api/me/security/logout-all` | Revoke all sessions |
| GET | `/api/me/limits` | Player-protection state as the server enforces it: `{ limitMin, minutesPlayedToday, minutesRemaining, selfExcludedUntil }` |
| POST | `/api/me/self-exclusion` | `duration: 24h\|7d\|30d\|90d`; starts an exclusion, closes any live round, audited. Cannot be shortened by the player |
| GET | `/api/wallet` | `{ wallet, totals }` |
| GET | `/api/wallet/transactions` | `page, limit, type` — ledger rows with before/after balances |
| GET | `/api/history` | `page, limit, roomId` — per-shot results |
| GET | `/api/sessions` | Per-round summaries: shots, wagered, rewarded, kills, config version |
| GET | `/api/leaderboard/:window` | `daily` \| `weekly` \| `alltime`; rank, username, demo earned, rounds |
| GET | `/api/rooms/:roomKey/bets` | Legal cannon ladder for that room, with reasons for any rejection |

Wallet types in the ledger: `DEMO_CREDIT`, `BET`, `WIN`, `REFUND`, `ADMIN_ADJUSTMENT`. Amounts
are signed integers in whole demo coins; `balance_after = balance_before + amount` is a database
constraint.

## Game

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/api/game/rooms` | – | Rooms with live seat counts and current round id |
| POST | `/api/game/join` | `roomKey, cannonKey?` | Creates/joins the room's ACTIVE round and a session; picks the first legal cannon; 409 on full/closed/maintenance |
| POST | `/api/game/leave` | – | Ends the session, returns the summary |
| GET | `/api/game/session` | – | Active session + latest authoritative snapshot (reconnect path) |
| POST | `/api/game/fire` | `clientRef, cannonKey?, angle, originX, originY` | HTTP fallback for a shot — identical validation to the socket, idempotent on `clientRef` |
| POST | `/api/game/cannon` | `cannonKey` | Change equipped cannon for the session |
| GET | `/api/game/status` | – | Tick rates, live rooms, online count, maintenance flag |

## Public

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | Liveness, DB check, maintenance |
| GET | `/api/meta` | Brand, currency label, feature flags, legal statements, resolution |
| GET | `/api/config` | The client-safe published configuration: version, fish, cannons, rooms, renderer settings |
| GET | `/api/rooms` | Public room list |
| GET | `/api/leaderboard/:window` | Public board |
| GET | `/api/payments/plans` | Free demo packs, `price: null` |
| POST | `/api/payments/demo-topup` | `planId` — free grant, idempotent per user/plan/hour |
| POST | `/api/payments/deposit` \| `/withdraw` | Always `403 REAL_MONEY_DISABLED` in this build |

## WebSocket `GET /ws/game`

Authenticate first: `{ "type": "auth", "token": "<accessToken>" }` (or the `rr_at` cookie).
Unauthenticated sockets are closed after 10 s. Oversize frames (>2 kB) and >60 msg/s are
dropped.

Client → server:

| Type | Payload | Meaning |
| --- | --- | --- |
| `join` | `roomId` (id or key) | Enter a room; creates or resumes the session |
| `fire` | `clientRef, cannonKey, angle, originX, originY` | Intent to shoot |
| `aim` | `angle` | Update cannon aim (throttled client-side; excess is dropped, never queued) |
| `setCannon` | `cannonKey` | Change weapon |
| `resync` | – | Ask for a full snapshot (after a reconnect) |
| `leave`, `ping` | – / `t` | |

Server → client: `welcome`, `authError`, `rooms`, `joined` (seat, bet options, snapshot,
balance), `snapshot`, `delta` (`add`/`rm`/`hp`), `shot` (ack), `shotBroadcast`, `hit`,
`defeat`, `explosion`, `bossDefeated`, `wave`, `playerJoined`, `playerLeft`, `playerMoved`,
`round`, `balance`, `time`, `notice`, `pong`.

Fish motion is deterministic: a spawn message carries the motion parameters and the server
timestamp, and both sides evaluate the same function, so the wire never carries per-frame
positions.

## Admin

Every route below requires the named capability, resolved from the role stored in the database.
Writes produce audit entries with before/after values.

| Method | Path | Capability |
| --- | --- | --- |
| GET | `/api/admin/dashboard` | `admin:panel` |
| GET | `/api/admin/users` · `/users/:id` | `users:read` |
| POST | `/api/admin/users/:id/status` | `users:write` |
| POST | `/api/admin/users/:id/demo-coins` | `transactions:write` |
| GET | `/api/admin/users/:id/limits` | `users:read` — that player's limit usage and exclusion state |
| POST | `/api/admin/users/:id/limits/lift` | `users:write`, `reason` required — the only way a self-exclusion ends early; audited |
| GET/POST/PATCH/DELETE | `/api/admin/fish[/:id]` | `fish:read` / `fish:write` |
| GET/POST/PATCH | `/api/admin/cannons[/:id]` | `cannons:read` / `cannons:write` |
| GET/POST/PATCH | `/api/admin/rooms[/:id]` | `rooms:read` / `rooms:write` |
| GET/PATCH | `/api/admin/settings` | `config:read` / `config:write` |
| GET | `/api/admin/config/versions[/:version]` | `config:read` |
| POST | `/api/admin/config/publish` | `config:write` |
| GET | `/api/admin/history` | `history:read` |
| GET | `/api/admin/rounds` · `/rounds/:id/audit` | `reports:read` |
| GET | `/api/admin/transactions` | `transactions:read` |
| GET | `/api/admin/reports/overview` · `/reports/export.csv` | `reports:read` |
| GET | `/api/admin/audit` | `audit:read` |
| PATCH | `/api/admin/system-settings` | `settings:write` |
| POST | `/api/admin/maintenance` | `maintenance:write` |
