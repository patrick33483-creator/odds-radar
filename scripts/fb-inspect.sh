#!/bin/bash
DB=/var/lib/footbreak/learning/predictions.sqlite

echo "=== A. recent service journal (last 200 lines) ==="
sudo journalctl -u crown-dashboard-api.service -n 200 --no-pager 2>&1 | tail -120

echo "=== B. pending snapshots without result (sample 20) ==="
sudo sqlite3 -header -column $DB "
SELECT s.snapshot_id, s.fixture_id, substr(s.kickoff,1,16) kick, s.home, s.away
  FROM prediction_snapshots s
  LEFT JOIN results r ON r.system=s.system AND r.fixture_id=s.fixture_id
 WHERE r.result_id IS NULL AND datetime(s.kickoff) < datetime('now')
 ORDER BY s.kickoff DESC LIMIT 20;" 2>&1

echo "=== C. discover endpoints ==="
curl -s http://127.0.0.1:8765/ 2>&1 | head -c 500
echo
echo "--- try /health ---"
curl -s http://127.0.0.1:8765/health 2>&1 | head -c 300
echo
echo "--- try /settle POST ---"
curl -s -X POST http://127.0.0.1:8765/settle 2>&1 | head -c 1000
echo

echo "=== D. after settle ==="
sudo sqlite3 -header -column $DB "SELECT COUNT(*) results_now FROM results;" 2>&1
