# Deployment

## Requirements

* **Node.js ≥ 22.12** — the server uses the SQLite engine bundled with Node (`node:sqlite`);
  there is no native module to compile and no database server to run.
* npm 10+.
* TLS termination in front of the app (production).

## Local development

```bash
npm install
cp .env.example .env         # defaults work as-is
npm run dev                  # API on :3000, Vite dev server on :5173 (proxies /api and /ws)
```

Open http://localhost:5173. The first boot creates `data/reef-raiders.db`, applies the schema,
seeds the baseline configuration and creates the bootstrap admin from `.env`.

Useful scripts: `npm run db:reset` (drop the dev database), `npm run db:seed`, `npm run build`,
`npm start`, `npm run typecheck`, `npm test`, `npm run e2e:flow -w @reef/server`.

## Production, single node

The API serves the built client itself, so one process on one port is the whole product:

```bash
npm ci
npm run build                # shared -> server -> web
NODE_ENV=production PORT=3000 npm start
```

`/api/health` is the readiness probe. The server logs JSON and exits non-zero if the
real-money policy check fails at boot.

### Environment

| Variable | Notes |
| --- | --- |
| `NODE_ENV` | `production` enables HSTS, a strict CSP, secure cookies and the boot-time policy assertion |
| `PORT`, `HOST`, `PUBLIC_URL` | `HOST=0.0.0.0` inside containers |
| `CORS_ORIGINS` | Exact comma-separated origins if the client is served from a different host |
| `DB_FILE` | Path to the SQLite file; put it on persistent storage |
| `JWT_SECRET` | ≥ 32 random bytes. The server warns in the log if it looks like the dev default |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` | 900 s / 30 d defaults |
| `COOKIE_SECURE` | `true` behind HTTPS |
| `STARTING_DEMO_COINS` | Welcome demo credit (virtual) |
| `SIM_TICK_MS` / `SNAPSHOT_MS` | 50/50 defaults; raise `SNAPSHOT_MS` to cut bandwidth |
| `ROUND_DURATION_S` | Round length before automatic rollover |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | Per-user global quota |
| `REAL_MONEY_ENABLED` | **Leave `false`.** See `docs/COMPLIANCE.md` |
| `LOG_LEVEL` | `debug` also enables per-request logging |

## Docker

```bash
docker build -t reef-raiders .
docker run -p 3000:3000 -e NODE_ENV=production -e JWT_SECRET="$(openssl rand -base64 48)" \
  -v reef-data:/app/data reef-raiders
```

`docker-compose.yml` wires the same thing with a health check and a named volume for the data
directory.

## Reverse proxy

WebSockets must be proxied. nginx example:

```nginx
server {
  listen 443 ssl http2;
  server_name play.example.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
  }
}
```

`trustProxy` is enabled, so rate limiting and lockouts key off the real client IP.

## Operations

* **Backups** — `sqlite3 data/reef-raiders.db ".backup backup.db"` on a schedule, or snapshot the
  volume. The audit log and ledger are the records an operator must retain; treat them as
  compliance data.
* **Integrity** — the admin dashboard reconciles every wallet against its ledger rows on load; a
  mismatch is displayed with the affected accounts.
* **Maintenance** — flip the toggle in *Admin → System*; live rounds close cleanly, players get a
  notice, and joining is blocked with an explicit reason instead of a hang.
* **Rolling config** — publish a configuration version *after* testing values in a low-stakes
  room; in-flight rounds are unaffected by design.
* **Logs** — structured JSON; errors carry a `requestId` that is also returned to the client so a
  support agent can find the server-side detail without exposing it to the user.

## Scaling out

The API is stateless apart from (a) room simulation ownership and (b) the rate-limit counters.
To run several nodes: move room ownership to a registry and publish room events over Redis/NATS so
any node can host any room; move rate limiting to a shared store. For very large deployments,
replace SQLite with Postgres (the `Database` wrapper is the only file that changes) and add
`SELECT … FOR UPDATE` on the wallet row instead of relying on the serialised write lock.

## Vercel (static frontend)

Vercel hosts the **frontend only**. The API is a long-lived Fastify process with WebSockets and a
SQLite file, which does not fit Vercel's serverless model — run it on Render, Railway, Fly.io, a
VPS or Docker, and point the Vercel site at it.

The repo ships a `vercel.json`, so a Vercel project needs no dashboard build tweaks:

* **Root Directory:** the repository root (the default — do *not* set it to `packages/web`,
  the client depends on the `@reef/shared` workspace package).
* Build, output directory and SPA rewrites come from `vercel.json`.
* **Environment variable:** `VITE_API_BASE=https://your-api-host` (no trailing slash). Without
  it the site renders a static preview of the landing page with a "Preview mode" banner; logins,
  rooms and live play need the API.

On the API host, allow the Vercel origin explicitly:

```bash
CORS_ORIGINS=https://your-site.vercel.app
COOKIE_SECURE=true
COOKIE_SAMESITE=none     # required: browsers won't send Lax cookies cross-origin
```

`SameSite=None` cookies require HTTPS, which the server enforces automatically.

## Static hosting alternative

If you want the client on a plain CDN instead: set `VITE_API_BASE` to the API origin at build
time, build `@reef/web`, upload `packages/web/dist`, and set `CORS_ORIGINS` / `COOKIE_SAMESITE`
as above. Keep `/api` and `/ws/game` on the same host as each other — the WebSocket derives its
URL from `VITE_API_BASE` and reuses the session cookie.
