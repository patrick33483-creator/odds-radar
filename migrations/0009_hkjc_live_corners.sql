-- Live corner capture.
--
-- HKJC's historic matchResult query always returns ttlCornerResult = -1, and
-- ended fixtures drop out of the pre-match matchList feed entirely, so a
-- fixture's corner count is only observable while it is in play. This table
-- records the running corner count seen during each poll so corner research
-- stops losing data irrecoverably.
--
-- It is deliberately separate from research_results: corner settlement still
-- requires HKJC's official confirmed figure, and nothing here is allowed to
-- pass as that.
CREATE TABLE IF NOT EXISTS hkjc_live_corners (
  match_id TEXT PRIMARY KEY,
  hkjc_id TEXT NOT NULL,
  corner INTEGER NOT NULL,
  home_corner INTEGER,
  away_corner INTEGER,
  last_status TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hkjc_live_corners_observed_idx ON hkjc_live_corners(observed_at);
