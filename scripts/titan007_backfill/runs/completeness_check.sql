.headers on
.mode column
SELECT '=== titan007 snapshots: market/stage/selection breakdown ===' AS s;
SELECT market, stage, selection, count(*) AS n FROM research_timeline_snapshots WHERE source_name='titan007' GROUP BY market, stage, selection ORDER BY market, stage, selection;

SELECT '=== per-match snapshot row count distribution ===' AS s;
SELECT cnt AS rows_per_match, count(*) AS num_matches FROM (
  SELECT match_id, count(*) AS cnt FROM research_timeline_snapshots WHERE source_name='titan007' GROUP BY match_id
) GROUP BY cnt ORDER BY cnt;

SELECT '=== distinct matches with titan007 snapshots ===' AS s;
SELECT count(DISTINCT match_id) AS n FROM research_timeline_snapshots WHERE source_name='titan007';

SELECT '=== results NULL check (should be zero rows - NOT NULL columns) ===' AS s;
SELECT count(*) AS n FROM results WHERE home_score IS NULL OR away_score IS NULL;

SELECT '=== results with corners_total populated ===' AS s;
SELECT count(*) AS n FROM results WHERE corners_total IS NOT NULL;

SELECT '=== results with NULL corners_total ===' AS s;
SELECT count(*) AS n FROM results WHERE corners_total IS NULL;

SELECT '=== decimal_odds sanity: min/max/null count for titan007 rows ===' AS s;
SELECT min(decimal_odds) AS min_o, max(decimal_odds) AS max_o, sum(CASE WHEN decimal_odds IS NULL THEN 1 ELSE 0 END) AS null_count FROM research_timeline_snapshots WHERE source_name='titan007';

SELECT '=== line_key sample for AH ===' AS s;
SELECT DISTINCT line_key FROM research_timeline_snapshots WHERE source_name='titan007' AND market='AH' LIMIT 10;

SELECT '=== line_key sample for OU ===' AS s;
SELECT DISTINCT line_key FROM research_timeline_snapshots WHERE source_name='titan007' AND market='OU' LIMIT 10;
