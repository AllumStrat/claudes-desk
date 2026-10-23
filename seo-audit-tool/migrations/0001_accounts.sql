-- Accounts, sign-in, credits, audit history and limits.
-- Apply on Cloudflare with: npx wrangler d1 migrations apply <db name>
-- The local Node server applies this file to its own SQLite database.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',          -- 'free' or 'pro'
  free_used INTEGER NOT NULL DEFAULT 0,       -- 1 once the free audit is spent
  runs_left INTEGER NOT NULL DEFAULT 0,       -- paid audits left this period
  period_end INTEGER,                         -- ms; end of the paid period
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  sub_status TEXT,                            -- Stripe subscription status
  sub_event_at INTEGER NOT NULL DEFAULT 0,    -- created time of the last status event applied
  last_invoice_id TEXT,
  watch_url TEXT,                             -- one saved site for the weekly re-check
  watch_next_at INTEGER
);
CREATE INDEX IF NOT EXISTS users_watch ON users (watch_next_at) WHERE watch_url IS NOT NULL;

-- Free audits are claimed per normalized email (hashed), so a deleted or
-- aliased account (name+1@...) does not get a second free audit.
CREATE TABLE IF NOT EXISTS free_claims (
  email_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS audits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,                         -- 'manual' or 'weekly'
  created_at INTEGER NOT NULL,
  score INTEGER,
  grade TEXT,
  report TEXT NOT NULL                        -- full report JSON
);
CREATE INDEX IF NOT EXISTS audits_user ON audits (user_id, created_at DESC);

-- Stripe webhook events already handled (Stripe can send one more than once).
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

-- Fixed-window counters shared by every server instance.
CREATE TABLE IF NOT EXISTS counters (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,              -- ms
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
