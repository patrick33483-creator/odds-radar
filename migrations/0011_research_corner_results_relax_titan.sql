-- Relax research_corner_results.titan_id from NOT NULL so name+date fallback
-- rows can be stored when a fixture has no matches.titan_id.
--
-- Why:
--   backfill-corner-results-titan.ts previously required matches.titan_id, so
--   ~266 past fixtures with corner odds but no direct titan link could not be
--   recovered. The new fallback resolves titan_id by team name + kickoff date
--   from Titan's Next_/Over_ schedule pages. When even that fails but a match
--   is later confirmed via another source, we still want to store the corner
--   count with source clearly labelled — hence nullable titan_id + widened
--   source enum.
--
-- Data integrity is preserved: source column already carries the recovery
-- path ('titan007' | 'titan007-namedate'), and corner settlement continues to
-- read HKJC's confirmed figure only (see canSettleCornerMarket).

-- SQLite cannot ALTER COLUMN, so we rebuild the table. Preserve existing rows.
CREATE TABLE IF NOT EXISTS research_corner_results_new (
  match_id TEXT PRIMARY KEY,
  titan_id TEXT,
  home_corners INTEGER NOT NULL,
  away_corners INTEGER NOT NULL,
  corners_total INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'titan007',
  fetched_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO research_corner_results_new
  (match_id, titan_id, home_corners, away_corners, corners_total, source, fetched_at)
SELECT match_id, titan_id, home_corners, away_corners, corners_total, source, fetched_at
  FROM research_corner_results;

DROP TABLE research_corner_results;
ALTER TABLE research_corner_results_new RENAME TO research_corner_results;

CREATE INDEX IF NOT EXISTS research_corner_results_titan_idx
  ON research_corner_results(titan_id);
CREATE INDEX IF NOT EXISTS research_corner_results_fetched_idx
  ON research_corner_results(fetched_at);
CREATE INDEX IF NOT EXISTS research_corner_results_source_idx
  ON research_corner_results(source);
