-- ============================================================================
-- Reef Raiders — relational schema (SQLite)
--
-- Conventions
--   * `id` columns are TEXT and hold server-generated ids (ksuid-ish / uuid).
--   * Money-like columns are INTEGER whole DEMO COINS. There is no real-money
--     column anywhere in this schema; see docs/COMPLIANCE.md.
--   * Timestamps are TEXT ISO-8601 UTC.
--   * Every balance mutation must go through the wallet service, which writes
--     a `wallet_transactions` ledger row in the same transaction.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id                    TEXT PRIMARY KEY,
  username              TEXT NOT NULL,
  email                 TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  role                  TEXT NOT NULL DEFAULT 'USER'
                          CHECK (role IN ('USER','ADMIN','SUPER_ADMIN','GAME_ADMIN','FINANCE_ADMIN','SUPPORT_ADMIN','COMPLIANCE_ADMIN')),
  status                TEXT NOT NULL DEFAULT 'ACTIVE'
                          CHECK (status IN ('ACTIVE','PENDING_VERIFICATION','SUSPENDED','CLOSED')),
  avatar_seed           TEXT NOT NULL,
  email_verified        INTEGER NOT NULL DEFAULT 0,
  email_verify_token    TEXT,
  email_verify_expires  TEXT,
  password_reset_token  TEXT,
  password_reset_expiry TEXT,
  password_changed_at   TEXT,
  failed_login_count    INTEGER NOT NULL DEFAULT 0,
  locked_until          TEXT,
  last_active_at        TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email    ON users (lower(email));
CREATE INDEX IF NOT EXISTS ix_users_status          ON users (status);
CREATE INDEX IF NOT EXISTS ix_users_created_at      ON users (created_at);

CREATE TABLE IF NOT EXISTS profiles (
  user_id            TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  display_name       TEXT,
  country            TEXT,
  birth_date         TEXT,
  bio                TEXT,
  avatar_url         TEXT,
  language           TEXT NOT NULL DEFAULT 'en',
  two_factor_enabled INTEGER NOT NULL DEFAULT 0,
  login_notify       INTEGER NOT NULL DEFAULT 1,
  -- Responsible-gaming controls (enforced server-side when real money is ever licensed)
  deposit_limit      INTEGER,
  loss_limit         INTEGER,
  session_limit_min  INTEGER,
  self_excluded_until TEXT,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_accounts (
  user_id    TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  admin_role TEXT NOT NULL
               CHECK (admin_role IN ('ADMIN','SUPER_ADMIN','GAME_ADMIN','FINANCE_ADMIN','SUPPORT_ADMIN','COMPLIANCE_ADMIN')),
  notes      TEXT,
  granted_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  granted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  user_agent  TEXT,
  ip_address  TEXT,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  replaced_by TEXT,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_refresh_token_hash ON refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS ix_refresh_user              ON refresh_tokens (user_id, revoked_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  ip_address TEXT,
  success    INTEGER NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_login_attempts_lookup ON login_attempts (lower(email), created_at);
CREATE INDEX IF NOT EXISTS ix_login_attempts_ip     ON login_attempts (ip_address, created_at);

CREATE TABLE IF NOT EXISTS email_verifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_email_verif_token ON email_verifications (token_hash);

-- ---------------------------------------------------------------------------
-- Wallet + ledger
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS wallets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  currency   TEXT NOT NULL DEFAULT 'DEMO' CHECK (currency = 'DEMO'),
  version    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  wallet_id       TEXT NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('DEMO_CREDIT','BET','WIN','REFUND','ADMIN_ADJUSTMENT')),
  amount          INTEGER NOT NULL,               -- signed, whole DEMO COINS
  balance_before  INTEGER NOT NULL,
  balance_after   INTEGER NOT NULL,
  reference_id    TEXT,
  game_round_id   TEXT,
  idempotency_key TEXT,
  status          TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('PENDING','COMPLETED','FAILED','REVERSED')),
  description     TEXT,
  created_at      TEXT NOT NULL,
  CHECK (balance_after = balance_before + amount)
);
-- The ledger is the source of truth for "was this already applied?".
CREATE UNIQUE INDEX IF NOT EXISTS ux_tx_idempotency ON wallet_transactions (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_tx_user_created ON wallet_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_tx_type_created ON wallet_transactions (type, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_tx_round        ON wallet_transactions (game_round_id);

-- ---------------------------------------------------------------------------
-- Game configuration (economy lives here, never in client code)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fish (
  id                   TEXT PRIMARY KEY,
  key                  TEXT NOT NULL,
  name                 TEXT NOT NULL,
  category             TEXT NOT NULL CHECK (category IN ('COMMON','MEDIUM','LARGE','RARE','BOSS','SPECIAL_GOLDEN','SPECIAL_TREASURE','SPECIAL_SPEED','SPECIAL_BOMB')),
  health               INTEGER NOT NULL CHECK (health > 0),
  reward               INTEGER NOT NULL CHECK (reward >= 0),
  speed                REAL    NOT NULL CHECK (speed > 0),
  size                 REAL    NOT NULL CHECK (size > 0),
  rarity               REAL    NOT NULL DEFAULT 1,
  spawn_weight         REAL    NOT NULL DEFAULT 1 CHECK (spawn_weight >= 0),
  movement_pattern     TEXT    NOT NULL CHECK (movement_pattern IN ('STRAIGHT','DIAGONAL','SINE','CIRCULAR','CURVED','WANDER','BOSS')),
  palette              INTEGER NOT NULL DEFAULT 0,
  min_spawn_interval_ms INTEGER NOT NULL DEFAULT 0,
  special              TEXT,
  enabled              INTEGER NOT NULL DEFAULT 1,
  sort_order           INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_fish_key ON fish (key);
CREATE INDEX IF NOT EXISTS ix_fish_enabled ON fish (enabled, spawn_weight);

CREATE TABLE IF NOT EXISTS cannons (
  id              TEXT PRIMARY KEY,
  key             TEXT NOT NULL,
  name            TEXT NOT NULL,
  level           INTEGER NOT NULL CHECK (level > 0),
  power           INTEGER NOT NULL CHECK (power > 0),
  shot_cost       INTEGER NOT NULL CHECK (shot_cost > 0),
  fire_rate       REAL    NOT NULL CHECK (fire_rate > 0),
  projectile_speed REAL   NOT NULL CHECK (projectile_speed > 0),
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cannons_key   ON cannons (key);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cannons_level ON cannons (level);

CREATE TABLE IF NOT EXISTS game_rooms (
  id                    TEXT PRIMARY KEY,
  key                   TEXT NOT NULL,
  name                  TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  min_bet               INTEGER NOT NULL CHECK (min_bet > 0),
  max_bet               INTEGER NOT NULL CHECK (max_bet >= min_bet),
  max_players           INTEGER NOT NULL CHECK (max_players > 0),
  fish_pool             TEXT NOT NULL DEFAULT '[]',
  spawn_rate_multiplier REAL NOT NULL DEFAULT 1 CHECK (spawn_rate_multiplier > 0),
  status                TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_rooms_key ON game_rooms (key);

CREATE TABLE IF NOT EXISTS game_configs (
  version      TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,
  notes        TEXT,
  is_active    INTEGER NOT NULL DEFAULT 0,
  published_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  published_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_game_configs_active ON game_configs (is_active) WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS system_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Rounds, sessions, shots, events, history
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS game_rounds (
  id             TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL REFERENCES game_rooms (id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','ACTIVE','PAUSED','ENDED')),
  seed           INTEGER NOT NULL,
  config_version TEXT NOT NULL,
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  total_shots    INTEGER NOT NULL DEFAULT 0,
  total_wagered  INTEGER NOT NULL DEFAULT 0,
  total_rewarded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_rounds_room_status ON game_rounds (room_id, status);
CREATE INDEX IF NOT EXISTS ix_rounds_started     ON game_rounds (started_at DESC);

CREATE TABLE IF NOT EXISTS game_sessions (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  room_id        TEXT NOT NULL REFERENCES game_rooms (id) ON DELETE CASCADE,
  round_id       TEXT NOT NULL REFERENCES game_rounds (id) ON DELETE CASCADE,
  cannon_id      TEXT REFERENCES cannons (id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ENDED','ABANDONED')),
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  total_shots    INTEGER NOT NULL DEFAULT 0,
  total_wagered  INTEGER NOT NULL DEFAULT 0,
  total_rewarded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_sessions_user    ON game_sessions (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_sessions_round   ON game_sessions (round_id);
CREATE INDEX IF NOT EXISTS ix_sessions_status  ON game_sessions (status, started_at);

CREATE TABLE IF NOT EXISTS player_shots (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES game_sessions (id) ON DELETE CASCADE,
  round_id         TEXT NOT NULL REFERENCES game_rounds (id) ON DELETE CASCADE,
  room_id          TEXT NOT NULL REFERENCES game_rooms (id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  cannon_id        TEXT NOT NULL REFERENCES cannons (id) ON DELETE CASCADE,
  -- Replay protection: a client reference can only ever be spent once per user.
  client_ref       TEXT NOT NULL,
  cost             INTEGER NOT NULL CHECK (cost >= 0),
  damage           INTEGER NOT NULL CHECK (damage >= 0),
  angle            REAL    NOT NULL,
  origin_x         REAL    NOT NULL,
  origin_y         REAL    NOT NULL,
  projectile_id    INTEGER,
  result           TEXT    NOT NULL DEFAULT 'MISSED' CHECK (result IN ('MISSED','HIT','KILL')),
  reward           INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_shots_client_ref ON player_shots (user_id, client_ref);
CREATE INDEX IF NOT EXISTS ix_shots_user_created ON player_shots (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_shots_round        ON player_shots (round_id);
CREATE INDEX IF NOT EXISTS ix_shots_created      ON player_shots (created_at);

CREATE TABLE IF NOT EXISTS shot_hits (
  id                TEXT PRIMARY KEY,
  shot_id           TEXT NOT NULL REFERENCES player_shots (id) ON DELETE CASCADE,
  round_id          TEXT NOT NULL,
  fish_instance_id  INTEGER NOT NULL,
  fish_key          TEXT NOT NULL,
  damage            INTEGER NOT NULL,
  killed            INTEGER NOT NULL DEFAULT 0,
  reward            INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_shot_hits_shot ON shot_hits (shot_id);

CREATE TABLE IF NOT EXISTS game_events (
  id             TEXT PRIMARY KEY,
  round_id       TEXT NOT NULL,
  room_id        TEXT NOT NULL,
  user_id        TEXT,
  event_type     TEXT NOT NULL CHECK (event_type IN ('ROUND_STARTED','ROUND_ENDED','PLAYER_JOINED','PLAYER_LEFT','PLAYER_SHOT','FISH_SPAWNED','FISH_HIT','FISH_DEFEATED','REWARD_GRANTED','SPECIAL_EFFECT','WAVE_STARTED')),
  config_version TEXT,
  metadata       TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_round ON game_events (round_id, created_at);
CREATE INDEX IF NOT EXISTS ix_events_type  ON game_events (event_type, created_at);

-- Player-facing game history (denormalised for fast reads; derived from shots).
CREATE TABLE IF NOT EXISTS game_history (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES game_sessions (id) ON DELETE CASCADE,
  round_id   TEXT NOT NULL,
  room_id    TEXT NOT NULL REFERENCES game_rooms (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  cannon_id  TEXT NOT NULL REFERENCES cannons (id) ON DELETE CASCADE,
  shot_cost  INTEGER NOT NULL,
  fish_key   TEXT,
  fish_name  TEXT,
  reward     INTEGER NOT NULL DEFAULT 0,
  result     TEXT NOT NULL CHECK (result IN ('MISSED','HIT','KILL')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_history_user_created ON game_history (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_history_round        ON game_history (round_id);
CREATE INDEX IF NOT EXISTS ix_history_created      ON game_history (created_at DESC);

-- ---------------------------------------------------------------------------
-- Tournaments (entry-fee matches, winner takes the pot minus operator rake)
--
-- Each tournament owns one hidden arena row in `game_rooms` (excluded from the
-- public room list): sessions, rounds and shots reference the arena exactly
-- like a normal room, while entry fees, scores and payouts live here. Money
-- columns are whole DEMO COINS, like everywhere else in this schema.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tournaments (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'LOBBY'
                   CHECK (status IN ('LOBBY','RUNNING','SETTLED','CANCELLED')),
  arena_room_id  TEXT NOT NULL UNIQUE REFERENCES game_rooms (id) ON DELETE CASCADE,
  entry_fee      INTEGER NOT NULL CHECK (entry_fee > 0),
  min_players    INTEGER NOT NULL CHECK (min_players >= 2),
  max_players    INTEGER NOT NULL CHECK (max_players >= min_players AND max_players <= 8),
  duration_s     INTEGER NOT NULL CHECK (duration_s >= 60 AND duration_s <= 3600),
  rake_bps       INTEGER NOT NULL CHECK (rake_bps >= 0 AND rake_bps <= 9000),
  cannon_key     TEXT NOT NULL,
  config_version TEXT NOT NULL DEFAULT '',
  prize_pool     INTEGER NOT NULL DEFAULT 0 CHECK (prize_pool >= 0),
  rake_amount    INTEGER NOT NULL DEFAULT 0 CHECK (rake_amount >= 0),
  winner_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  lobby_ends_at  TEXT NOT NULL,
  starts_at      TEXT,
  ends_at        TEXT,
  settled_at     TEXT,
  created_by     TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tournaments_status ON tournaments (status, lobby_ends_at);
CREATE INDEX IF NOT EXISTS ix_tournaments_arena  ON tournaments (arena_room_id);

CREATE TABLE IF NOT EXISTS tournament_entries (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  score         INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
  kills         INTEGER NOT NULL DEFAULT 0 CHECK (kills >= 0),
  shots         INTEGER NOT NULL DEFAULT 0 CHECK (shots >= 0),
  prize         INTEGER NOT NULL DEFAULT 0 CHECK (prize >= 0),
  rank          INTEGER CHECK (rank IS NULL OR rank > 0),
  joined_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tournament_entries ON tournament_entries (tournament_id, user_id);
CREATE INDEX IF NOT EXISTS ix_tournament_entries_user ON tournament_entries (user_id);

-- ---------------------------------------------------------------------------
-- Audit (append-only: mutations blocked by trigger)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_logs (
  id             TEXT PRIMARY KEY,
  admin_id       TEXT,
  admin_username TEXT,
  action         TEXT NOT NULL,
  entity         TEXT NOT NULL,
  entity_id      TEXT,
  previous_value TEXT,
  new_value      TEXT,
  metadata       TEXT,
  ip_address     TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_entity  ON audit_logs (entity, entity_id);
CREATE INDEX IF NOT EXISTS ix_audit_admin   ON audit_logs (admin_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only');
END;

-- ---------------------------------------------------------------------------
-- Generic idempotency store (deposits/withdrawals/admin ops)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  user_id    TEXT,
  response   TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_idem_scope ON idempotency_keys (scope, created_at);
