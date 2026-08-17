-- Self-heal audit + admission control state.

CREATE TABLE IF NOT EXISTS fix_runs (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL,          -- queued | running | done
  outcome TEXT,                  -- fixed | noop | failed
  summary TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS fix_runs_fingerprint_idx ON fix_runs(fingerprint, created_at);
CREATE INDEX IF NOT EXISTS fix_runs_created_idx ON fix_runs(created_at);

-- Kill switch / feature flags. Set `enabled` to anything but "1" to disable.
CREATE TABLE IF NOT EXISTS self_heal_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO self_heal_settings (key, value) VALUES ('enabled', '1');
