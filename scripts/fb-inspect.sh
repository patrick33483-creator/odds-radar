#!/bin/bash
set -e
DB=/var/lib/footbreak/learning/predictions.sqlite

echo "=== rows summary ==="
sudo sqlite3 -header -column $DB "SELECT (SELECT COUNT(*) FROM prediction_snapshots) snap, (SELECT COUNT(*) FROM results) res, (SELECT COUNT(*) FROM grades) grd;"

echo "=== grades state distribution ==="
sudo sqlite3 -header -column $DB "SELECT state, COUNT(*) FROM grades GROUP BY state ORDER BY 2 DESC;"

echo "=== recent snapshots without result ==="
sudo sqlite3 -header -column $DB "
SELECT s.snapshot_id, s.fixture_id, s.valid_from, s.home, s.away, s.kickoff
  FROM prediction_snapshots s
  LEFT JOIN results r ON r.system=s.system AND r.fixture_id=s.fixture_id
 WHERE r.result_id IS NULL AND s.kickoff < strftime('%Y-%m-%dT%H:%M', 'now') || 'Z'
 ORDER BY s.kickoff DESC LIMIT 20;" 2>&1

echo "=== prediction_snapshots schema ==="
sudo sqlite3 $DB ".schema prediction_snapshots"

echo "=== crown module python files ==="
sudo ls /opt/footbreak/crown/*.py 2>/dev/null

echo "=== settle.py full ==="
sudo cat /opt/footbreak/crown/settle.py 2>/dev/null

echo "=== engine.py head ==="
sudo head -150 /opt/footbreak/crown/engine.py 2>/dev/null
