-- Silent, isolated forward-watch ledger. No execution or Telegram table is
-- referenced by this migration. Runtime migration in store.ts creates the
-- same table and one-time activation watermark.
CREATE TABLE IF NOT EXISTS quote_direction_watch_observations (
  unique_key TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  league TEXT NOT NULL,
  market TEXT NOT NULL CHECK(market IN ('AH','OU')),
  line_key TEXT NOT NULL,
  selection TEXT NOT NULL CHECK(selection IN ('H','A','O','U')),
  decision_stage TEXT NOT NULL CHECK(decision_stage='T30'),
  decision_odds REAL NOT NULL,
  reference_odds REAL,
  odds_gap REAL,
  percentile_low REAL,
  percentile_high REAL,
  baseline_count INTEGER,
  baseline_version TEXT,
  status TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  t5_checked_at INTEGER,
  t5_provider TEXT,
  t5_odds REAL,
  t5_change REAL,
  t5_confirmation TEXT,
  result_status TEXT,
  realized_return REAL,
  realized_pnl REAL,
  final_score TEXT,
  settled_at INTEGER,
  settlement_source TEXT,
  notified_at INTEGER CHECK(notified_at IS NULL)
);
CREATE INDEX IF NOT EXISTS quote_direction_watch_match_idx
  ON quote_direction_watch_observations(match_id,detected_at);
CREATE INDEX IF NOT EXISTS quote_direction_watch_rule_idx
  ON quote_direction_watch_observations(rule_id,status,detected_at);

INSERT OR IGNORE INTO app_state(key,value,updated_at)
VALUES('quote_direction_watch_activated_at', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);
