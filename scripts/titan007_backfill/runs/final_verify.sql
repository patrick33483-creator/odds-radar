-- READ-ONLY: force WAL checkpoint then report true totals directly on live db
.headers on
.mode column
PRAGMA wal_checkpoint(FULL);
SELECT 'journal_mode' AS check_name;
PRAGMA journal_mode;
SELECT 'total snapshots' AS check_name, count(*) AS n FROM research_timeline_snapshots;
SELECT 'total points' AS check_name, count(*) AS n FROM research_timeline_points;
SELECT 'total results' AS check_name, count(*) AS n FROM results;
SELECT 'snapshots by source_name' AS check_name, source_name, count(*) AS n FROM research_timeline_snapshots GROUP BY source_name ORDER BY n DESC;
SELECT 'target matches results count' AS check_name, count(*) AS n FROM results WHERE match_id LIKE 'hkjc:%' AND fetched_at > 1787900000000;
SELECT 'excluded matches untouched (snapshots)' AS check_name, match_id, count(*) AS n FROM research_timeline_snapshots WHERE match_id IN ('hkjc:50074098','hkjc:50074112','hkjc:50074257') AND source_name='titan007' GROUP BY match_id;
SELECT 'excluded matches untouched (results)' AS check_name, match_id FROM results WHERE match_id IN ('hkjc:50074098','hkjc:50074112','hkjc:50074257');
