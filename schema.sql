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
  price        INTEGER,                   -- monthly price in SAR = plan + add-ons − discount (worked out by the server)
  rules_tester INTEGER NOT NULL DEFAULT 0, -- 1 = gets rules versions sent to testers
  discount     TEXT NOT NULL DEFAULT ''   -- '' | '20' (SAR) | '10%'
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

-- Price quotes sent to agencies (Q-0001 ...). lines = the price breakdown as quoted.
CREATE TABLE IF NOT EXISTS quotes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  agency      TEXT NOT NULL DEFAULT '',
  contact     TEXT NOT NULL DEFAULT '',
  plan        TEXT NOT NULL,
  portals     TEXT NOT NULL,
  max_devices INTEGER NOT NULL,
  ai_quota    INTEGER NOT NULL,
  discount    TEXT NOT NULL DEFAULT '',
  lines       TEXT NOT NULL,
  price       INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'sent',  -- sent | accepted | declined
  key         TEXT,                          -- licence made from it
  notes       TEXT NOT NULL DEFAULT ''
);

-- One row per /v1/ai call (counts and result only; never the image or passport details).
CREATE TABLE IF NOT EXISTS ai_calls (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  key     TEXT NOT NULL,
  device  TEXT NOT NULL,                 -- from the pass
  version TEXT NOT NULL DEFAULT '',      -- SafarFill version from the pass
  result  TEXT NOT NULL,                 -- ok | no_details | quota | ai_not_in_plan | other error code
  ai_left INTEGER,                       -- after the call; NULL = no limit or unknown
  size    INTEGER NOT NULL DEFAULT 0,    -- image size in bytes (approx.)
  ip      TEXT NOT NULL DEFAULT '',
  city    TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ai_calls_key ON ai_calls (key, at);
CREATE INDEX IF NOT EXISTS ai_calls_dev ON ai_calls (key, device, at);

-- Names given to computers in the dashboard (kept when a computer is removed).
CREATE TABLE IF NOT EXISTS device_names (
  key    TEXT NOT NULL,
  device TEXT NOT NULL,
  name   TEXT NOT NULL,
  PRIMARY KEY (key, device)
);

-- Computers removed in the dashboard (v1.9.3). They cannot join again with the saved key
-- until "Allow again" deletes the row.
CREATE TABLE IF NOT EXISTS removed_devices (
  key        TEXT NOT NULL,
  device     TEXT NOT NULL,
  removed_at INTEGER NOT NULL,
  last_try   INTEGER,
  tries      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, device)
);

-- Rules bundles (data only): { schema: 1, airlines, messages, portals }. status: draft | test | released | retired.
CREATE TABLE IF NOT EXISTS rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft',
  note        TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL,
  released_at INTEGER
);

-- Messages shown to agents in SafarFill. target_type: all | plan | licence.
CREATE TABLE IF NOT EXISTS announcements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  text        TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'info',     -- info | warning | urgent
  link        TEXT NOT NULL DEFAULT '',
  until       INTEGER,
  target_type TEXT NOT NULL DEFAULT 'all',
  target      TEXT NOT NULL DEFAULT ''
);

-- Security log, kept 90 days (daily Cron Trigger). Never passport details or images.
CREATE TABLE IF NOT EXISTS activity (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  key     TEXT NOT NULL,
  device  TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  ip      TEXT NOT NULL DEFAULT '',
  city    TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  action  TEXT NOT NULL,                   -- session | parse page | fill | refused
  detail  TEXT NOT NULL DEFAULT ''         -- portal, or "<what>: <error code>"
);
CREATE INDEX IF NOT EXISTS activity_key ON activity (key, at);
CREATE INDEX IF NOT EXISTS activity_at ON activity (at);

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
