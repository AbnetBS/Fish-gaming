# syntax=docker/dockerfile:1
# =============================================================================
# Reef Raiders — production image
#
# One container runs the whole product: the Fastify API, the authoritative
# room simulation/WebSocket hub, the built React client and the SQLite engine
# bundled with Node (no database server, no native modules to compile).
#
#   docker build -t reef-raiders .
#   docker run -p 3000:3000 -e NODE_ENV=production \
#     -e JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
#     -v reef-data:/app/data reef-raiders
#
# Real-money play stays disabled in every image built from this file; see
# docs/COMPLIANCE.md before changing anything around that flag.
# =============================================================================

# --- stage 1: install + build everything -----------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV npm_config_update_notifier=false

# Manifests first so dependency installation is cached independently of source.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY packages ./packages
# shared -> server (tsc + copy-assets for schema.sql) -> web (vite)
RUN npm run build && npm run typecheck

# --- stage 2: runtime, production dependencies only ------------------------
FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    npm_config_update_notifier=false

# Only what `npm ci --omit=dev` needs to resolve the workspace layout.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output; no sources, no toolchain, no dev dependencies in the image.
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist  packages/server/dist
COPY --from=build /app/packages/web/dist     packages/web/dist

# The SQLite file, its WAL siblings and any future uploads live here. Mount a
# volume on /app/data or the ledger dies with the container.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV HOST=0.0.0.0 \
    PORT=3000 \
    DB_FILE=./data/reef-raiders.db \
    REAL_MONEY_ENABLED=false \
    LOG_LEVEL=info

EXPOSE 3000

# Uses Node's built-in fetch so the image needs no curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
