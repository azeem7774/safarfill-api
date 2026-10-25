-- SafarFill licence server database (Cloudflare D1).
-- Run once in the D1 console. Safe to run again: it only creates what is missing.

CREATE TABLE IF NOT EXISTS licences (
  key          TEXT PRIMARY KEY,          -- SF-XXXX-XXXX-XXXX
  agency       TEXT NOT NULL DEFAULT '',
  contact      TEXT NOT NULL DEFAULT '',  -- WhatsApp number
  plan         TEXT NOT NULL,             -- trial | starter | standard | owner
  portals      TEXT NOT NULL DEFAULT '["akbar","alhind","airsial","muqeem"]',
  max_devices  INTEGER NOT NULL DEFAULT 1,
  ai_quota     INTEGER NOT NULL DEFAULT 0, -- AI reads per month (trial: in total); -1 = no limit
  trial_days   INTEGER NOT NULL DEFAULT 0, -- trial: length, counted from first activation
  expires_at   INTEGER,                    -- ms since 1970; NULL = not started (trial) or never (owner)
  status       TEXT NOT NULL DEFAULT 'active', -- active | blocked
  notes        TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  activated_at INTEGER,
  price        INTEGER                    -- monthly price in SAR agreed with this agency; NULL = plan price
);

CREATE TABLE IF NOT EXISTS devices (
  key        TEXT NOT NULL,
  device     TEXT NOT NULL,               -- random id made by the extension at install
  version    TEXT NOT NULL DEFAULT '',
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  PRIMARY KEY (key, device)
);

-- Counts only. No passport data is ever stored.
CREATE TABLE IF NOT EXISTS usage (
  key         TEXT NOT NULL,
  month       TEXT NOT NULL,              -- YYYY-MM (trial uses 'trial')
  parse_count INTEGER NOT NULL DEFAULT 0,
  ai_count    INTEGER NOT NULL DEFAULT 0,
  ai_cost_usd REAL NOT NULL DEFAULT 0,
  fill_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, month)
);

CREATE TABLE IF NOT EXISTS settings (
  name  TEXT PRIMARY KEY,                -- e.g. min_version
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate (
  key    TEXT NOT NULL,
  kind   TEXT NOT NULL,                   -- parse | ai
  minute INTEGER NOT NULL,
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, kind, minute)
);

-- Activity feed: what happened, including refused attempts. `sees` = what the agent was shown.
CREATE TABLE IF NOT EXISTS events (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  at    INTEGER NOT NULL,
  key   TEXT NOT NULL,                    -- licence key, or SYSTEM
  kind  TEXT NOT NULL,                    -- ok | info | warn | bad
  code  TEXT NOT NULL,
  what  TEXT NOT NULL,
  sees  TEXT NOT NULL DEFAULT '',
  done  INTEGER NOT NULL DEFAULT 0        -- 1 once you have acted on it
);
CREATE INDEX IF NOT EXISTS events_at ON events (at);
CREATE INDEX IF NOT EXISTS events_key ON events (key, code, done);
