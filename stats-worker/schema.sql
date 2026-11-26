-- Anonymous usage statistics. No note text, titles, tags, passwords, e-mail addresses or IP addresses are stored.
CREATE TABLE IF NOT EXISTS installs (
  install_id TEXT PRIMARY KEY,          -- random id made on the user's device after they agreed to share statistics
  first_seen TEXT NOT NULL,             -- YYYY-MM-DD (UTC)
  first_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT ''      -- two-letter country from Cloudflare, nothing finer
);
CREATE TABLE IF NOT EXISTS pings (
  install_id TEXT NOT NULL,
  day TEXT NOT NULL,                    -- one row per install per day
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  lang TEXT NOT NULL,
  notes TEXT NOT NULL,                  -- size bucket only: 0, 1-9, 10-49, 50-199, 200+
  linked INTEGER NOT NULL,
  features TEXT NOT NULL,               -- comma separated names from a fixed list
  PRIMARY KEY (install_id, day)
);
CREATE TABLE IF NOT EXISTS milestones (
  install_id TEXT NOT NULL,
  name TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (install_id, name)
);
CREATE INDEX IF NOT EXISTS pings_day ON pings(day);

-- Explicitly submitted feedback and optional screenshots. Removed when the user withdraws.
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created TEXT NOT NULL,
  install_id TEXT NOT NULL,
  kind TEXT NOT NULL,                   -- bug | idea | other
  message TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',     -- optional, only if the person wants an answer
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  lang TEXT NOT NULL,
  screenshot TEXT                       -- optional PNG, JPEG or WebP data URL
);
CREATE INDEX IF NOT EXISTS feedback_install ON feedback(install_id, created);
CREATE TABLE IF NOT EXISTS ai_counts (
  install_id TEXT NOT NULL,
  month TEXT NOT NULL,
  requests INTEGER NOT NULL,
  approvals INTEGER NOT NULL,
  PRIMARY KEY (install_id, month)
);
