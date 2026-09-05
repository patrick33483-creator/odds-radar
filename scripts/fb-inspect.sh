#!/bin/bash
DB=/var/lib/footbreak/learning/predictions.sqlite

echo "=== recent service log (last 200 lines) ==="
sudo journalctl -u crown-dashboard-api.service -n 200 --no-pager 2>&1 | tail -100

echo "=== 5803 pending snapshots — sample 20 recent ==="
sudo sqlite3 -header -column $DB "
SELECT s.snapshot_id, s.fixture_id, substr(s.kickoff,1,16) kick, s.home, s.away
  FROM prediction_snapshots s
  LEFT JOIN results r ON r.system=s.system AND r.fixture_id=s.fixture_id
 WHERE r.result_id IS NULL AND datetime(s.kickoff) < datetime('now')
 ORDER BY s.kickoff DESC
 LIMIT 20;" 2>&1

echo "=== settle attempt trigger ==="
# manually trigger settlement
sudo systemctl status crown-dashboard-api.service --no-pager 2>&1 | head -5
# call the http endpoint
curl -s -X POST http://127.0.0.1:8765/settle 2>&1 | head -c 2000
echo
echo "=== after settle ==="
sudo sqlite3 -header -column $DB "SELECT COUNT(*) results_now FROM results;" 2>&1
