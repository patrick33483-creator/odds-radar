-- Third-party corner results for research.
--
-- HKJC never publishes a past match's corner count through any readable field
-- (historic ttlCornerResult is always -1, and ended fixtures leave the
-- pre-match feed), so corner research needs an external result source.
-- titan007 keeps a per-match statistics page that stays readable after
-- kickoff and is reachable through matches.titan_id.
--
-- Deliberately separate from research_results: corner settlement must keep
-- requiring HKJC's own confirmed figure, so a third-party count can never
-- reach canSettleCornerMarket. Research joins this table explicitly.
CREATE TABLE IF NOT EXISTS research_corner_results (
  match_id TEXT PRIMARY KEY,
  titan_id TEXT NOT NULL,
  home_corners INTEGER NOT NULL,
  away_corners INTEGER NOT NULL,
  corners_total INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'titan007',
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS research_corner_results_titan_idx
  ON research_corner_results(titan_id);
CREATE INDEX IF NOT EXISTS research_corner_results_fetched_idx
  ON research_corner_results(fetched_at);
