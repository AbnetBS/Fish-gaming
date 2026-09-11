# Security design

Threat model: a hostile player with full control of their browser and network requests, plus
an untrusted network path. The product is a virtual-coin demo, so the assets worth protecting
are account access, the integrity of the demo economy, the admin boundary, and operator data.

## 1. Trust boundaries

```
browser  ──►  API  ──►  database
   ✗           ✓           ✓
```

Everything to the left of the API is attacker-controlled. The API is the only place where a
value becomes true. Concretely, the server never accepts: balances, rewards, fish identities,
hit outcomes, cannon prices, room settings, roles, or configuration.

## 2. Authentication

| Control | Implementation |
| --- | --- |
| Password storage | bcrypt, cost 12, per-account salt. Verifier-only read; hashes never leave the DB layer and are stripped at the service boundary so a route cannot serialise them by accident. |
| Timing of login | A real bcrypt comparison runs against a dummy hash for unknown emails, so response time does not reveal registration. |
| User enumeration | Login, forgot-password and register all return identical shapes/messages for unknown vs. wrong-credential cases. |
| Brute force | Per-account counter with 15-minute lockout after 8 failures, plus `login_attempts` records (email, IP, success, reason) for detection, plus per-route rate limits (12/5 min on login, 8/10 min on register). |
| Access token | HS256 JWT, 15 min default, `sub` + `sid` only. Verified with `crypto.timingSafeEqual`. Issuer, audience, expiry, algorithm pinned (`alg: HS256` only — `none` and key-confusion are rejected) and the `typ` claim must be `access`. |
| Refresh token | 48 random bytes, httpOnly + SameSite=Lax cookie scoped to `/api/auth`, stored only as a SHA-256 hash, rotated on every use, `replaced_by` linked. |
| Reuse detection | Presenting an already-rotated token revokes the whole token family for that account and logs the event. |
| Server-side revocation | The access token's `sid` maps to a session row; logout, password change, suspension and admin action revoke it, so a stolen bearer token dies immediately rather than at expiry. |
| Password change | Requires the current password, re-hashes, and revokes every *other* session. |
| Reset tokens | Single-use, 1-hour expiry, stored hashed, cleared on use, all sessions revoked. |

Roles are read from the `users` row on every request. A JWT never contains a role, so no
client-supplied value can influence authorisation. Suspending an account takes effect on the
next request even if a token is still valid.

## 3. Authorisation

Capability-based. Each route names the permission it needs (`fish:write`,
`transactions:read`, `maintenance:write`, …); roles map to permission sets in
`packages/shared/src/permissions.ts`, resolved from the database role. Least privilege by
default: `SUPPORT_ADMIN` can read the ledger but cannot touch the economy; `GAME_ADMIN` can
edit fish but cannot write transactions; `FINANCE_ADMIN` cannot edit the game. The generic
`ADMIN` role is deliberately limited to support-shaped powers.

Tests assert the mapping, that a player token gets 401/403 on admin routes, and that a
suspended caller resolves to no user at all.

## 4. CSRF

The API is dual-mode:

* `Authorization: Bearer` (the SPA's normal mode) is not ambient, so a cross-site form
  cannot carry it. Requests authenticated this way are exempt from CSRF checks.
* Cookie-authenticated writes additionally require an `X-CSRF-Token` header matching the
  readable `rr_csrf` double-submit cookie; the check runs in an `onRequest` hook for
  POST/PUT/PATCH/DELETE, so a forged cross-site request fails before reaching a handler.

Cookies are `SameSite=Lax`, `Secure` in production, and the refresh cookie is path-scoped.

## 5. Injection

* **SQL**: every query is a prepared statement with bound parameters. Dynamic fragments are
  limited to `WHERE` clauses assembled from fixed strings plus `?` placeholders; there is no
  string interpolation of user data anywhere in the data layer. Identifiers come from static
  column maps, never from input. Search terms are `LIKE`-escaped (`%`, `_`, `\`) so wildcards
  cannot be used to enumerate rows.
* **XSS**: React escapes by default. There is no `dangerouslySetInnerHTML` in the codebase.
  The admin audit viewer renders stored JSON through `JSON.stringify`, which is escaped like
  any other text node.
* **CSP**: `default-src 'self'`, `script-src 'self'` (no `unsafe-eval`, no inline scripts),
  `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
  `img-src 'self' data: blob:` and `media-src 'self' blob: data:` for generated audio.
* **Headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=()`,
  `Cross-Origin-Opener-Policy: same-origin`, `Cache-Control: no-store` on auth responses, and
  HSTS in production.
* **Mass assignment**: Zod schemas are `.strict()`, so an extra field such as `reward: 999999`
  in a fire request is a 400, not a silently ignored input. (Asserted in the e2e flow.)

## 6. Economic abuse

| Attack | Defence |
| --- | --- |
| "I killed a fish, give me 100 coins" | No such endpoint exists. Rewards are produced only by the server-side collision pass. |
| Replaying a shot | Unique `(user_id, client_ref)`; the retry is answered with the original ack. |
| Replaying a reward | Unique idempotency key `win:<shotId>:<fishKey>`. |
| Race between two concurrent shots | `BEGIN IMMEDIATE` + synchronous driver: one transaction commits before the next reads the balance. |
| Driving the balance negative | `wallets.balance >= 0` CHECK, enforced by the engine, plus a pre-check for a friendly message. |
| Ledger forgery | `CHECK (balance_after = balance_before + amount)`; a reconciliation job compares every wallet to the sum of its rows and the admin dashboard shows the result. |
| Shot spam as DoS | Per-cannon fire-rate gate before the database is touched, per-socket token bucket, per-route rate limits, hard caps on projectiles and fish. |
| Manipulating the aim to shoot the floor | Angle is normalised and clamped to the playable hemisphere server-side; origins are clamped into the field. |
| Playing after suspension | Session revocation + per-request status check + live socket detach. |

## 7. Player protection controls

Responsible-gaming controls are server-enforced state, not client preferences:

* `profiles.session_limit_min` is read when a player attaches to a room and turns into an in-memory
  deadline; `RoundManager.fire()` refuses shots past it and closes the session, so no client —
  including the HTTP transport and any hand-rolled caller — can spend past the budget. Because the
  deadline is armed on attach, a limit changed by an operator *during* a round takes effect on the
  next two-second sweep rather than on the next shot.
* `profiles.self_excluded_until` blocks join, attach and fire, and a 2 s sweep per room removes a
  player who started an exclusion mid-round. Only `users:write` (or a super/compliance admin) can
  clear it, and the write is audited with a reason.
* Minutes are summed from `game_sessions` rows for the current UTC day, i.e. from the same rows the
  ledger and history are derived from, not from a timer the browser controls.
* `POST /api/payments/deposit` and withdrawal remain absent; the exclusion machinery has no
  financial lever to protect, which is exactly why it is safe to ship in a demo product.

## 8. Realtime transport

* No URL query tokens: authentication happens as the first frame, so access tokens never reach
  access logs.
* 10-second auth window, then close.
* `maxPayload` 8 kB at the transport, 2 kB application limit.
* Message token bucket (60/s) and a separate, cheaper budget for aim updates, which are
  silently dropped rather than queued.
* One throwing handler per message: a malformed frame produces a notice, never a crash.
* Unknown message types are ignored rather than trusted.
* Reconnect re-synchronises from a full snapshot; the client refuses to fire while the link is
  not `open`, which is what prevents duplicate shots during a flap.

## 9. Data protection and privacy

* Private reads are keyed by the authenticated user's id; there is no route that takes another
  user's id for a read of their data.
* Leaderboards expose rank, username and demo coins earned — nothing else. Closed accounts are
  excluded.
* Admin user detail is read-only apart from status changes and demo adjustments, each audited.
* Passwords, tokens and secrets are redacted from logs by a key allowlist in the logger.
* The database file lives outside the served static root and is git-ignored; `.env` is ignored
  and only `.env.example` is committed.

## 10. Auditability

`audit_logs` is append-only, enforced by `BEFORE UPDATE`/`BEFORE DELETE` triggers that raise —
history cannot be quietly rewritten even with SQL access to the application account. Every
privileged mutation records actor, action, entity, entity id, previous value, new value, IP and
timestamp, and the admin UI renders the before/after diff directly from it.

## 11. Operational checklist

1. Set a strong `JWT_SECRET` (≥ 32 random bytes) — the server logs a warning if it still looks
   like the development default.
2. `NODE_ENV=production`, `COOKIE_SECURE=true`, `CORS_ORIGINS` limited to the exact origins.
3. Terminate TLS at the edge and keep HSTS on.
4. Put the API behind a WAF/rate limiter if it is internet-exposed; the app has per-process
   limits which are a second line, not the first.
5. Back up the database file (or the Postgres cluster after migration) and keep audit exports.
6. Review `docs/COMPLIANCE.md` before considering any change to real-money posture.
