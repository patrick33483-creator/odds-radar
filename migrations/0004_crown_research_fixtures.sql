-- Crown/Titan research fixture identity. Runtime deploys also execute the
-- equivalent guarded rebuild in server/lib/store.ts.
BEGIN;

DROP INDEX IF EXISTS matches_kickoff_idx;
DROP INDEX IF EXISTS matches_pinnacle_idx;
ALTER TABLE matches RENAME TO matches_pre_crown;
CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  hkjc_id TEXT,
  fixture_source TEXT NOT NULL DEFAULT 'hkjc'
    CHECK(fixture_source IN ('hkjc','crown')),
  titan_id TEXT,
  pinnacle_match_id TEXT,
  league TEXT NOT NULL,
  league_en TEXT,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  home_team_en TEXT,
  away_team_en TEXT,
  kickoff_utc INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PREEVENT',
  inplay INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
INSERT INTO matches
SELECT id,hkjc_id,'hkjc',NULL,pinnacle_match_id,league,league_en,home_team,away_team,
       home_team_en,away_team_en,kickoff_utc,status,inplay,updated_at
FROM matches_pre_crown;
DROP TABLE matches_pre_crown;
CREATE INDEX matches_kickoff_idx ON matches(kickoff_utc);
CREATE INDEX matches_pinnacle_idx ON matches(pinnacle_match_id);

DROP INDEX IF EXISTS research_results_fetched_idx;
ALTER TABLE research_results RENAME TO research_results_pre_crown;
CREATE TABLE research_results (
  match_id TEXT PRIMARY KEY,
  hkjc_id TEXT,
  home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL,
  corners_total INTEGER,
  source TEXT NOT NULL,
  result_source TEXT NOT NULL DEFAULT 'hkjc',
  source_match_id TEXT,
  fetched_at INTEGER NOT NULL
);
INSERT INTO research_results
SELECT match_id,hkjc_id,home_score,away_score,corners_total,source,'hkjc',hkjc_id,fetched_at
FROM research_results_pre_crown;
DROP TABLE research_results_pre_crown;
CREATE INDEX research_results_fetched_idx ON research_results(fetched_at);

UPDATE matches
SET titan_id=(SELECT p.titan_id FROM pinnacle_source_map p WHERE p.match_id=matches.id)
WHERE titan_id IS NULL;

-- Runtime migration additionally removes duplicate research rows only when the
-- two HKJC rows represent the same teams. This portable migration keeps one
-- deterministic owner and detaches every other legacy mapping.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY titan_id
           ORDER BY updated_at DESC,id DESC
         ) AS owner_rank
  FROM matches
  WHERE titan_id IS NOT NULL
)
UPDATE pinnacle_source_map
SET titan_id=NULL,titan_reversed=0,
    active_source=CASE WHEN active_source='titan' THEN NULL ELSE active_source END
WHERE match_id IN (SELECT id FROM ranked WHERE owner_rank>1);

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY titan_id
           ORDER BY updated_at DESC,id DESC
         ) AS owner_rank
  FROM matches
  WHERE titan_id IS NOT NULL
)
UPDATE matches
SET titan_id=NULL
WHERE id IN (SELECT id FROM ranked WHERE owner_rank>1);

CREATE UNIQUE INDEX matches_titan_uniq ON matches(titan_id) WHERE titan_id IS NOT NULL;
COMMIT;
