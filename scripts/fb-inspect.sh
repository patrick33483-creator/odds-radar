#!/bin/bash
DB=/var/lib/footbreak/learning/predictions.sqlite

echo "=== 1 whoami + sudo test ==="
whoami
sudo -n true && echo "sudo OK nopass" || echo "sudo NEEDS pass"

echo "=== 2 db access ==="
ls -la $DB 2>&1 | head
sudo ls -la $DB 2>&1 | head

echo "=== 3 rows summary ==="
sudo sqlite3 -header -column $DB "SELECT (SELECT COUNT(*) FROM prediction_snapshots) snap, (SELECT COUNT(*) FROM results) res, (SELECT COUNT(*) FROM grades) grd;" 2>&1

echo "=== 4 grades state ==="
sudo sqlite3 -header -column $DB "SELECT state, COUNT(*) FROM grades GROUP BY state ORDER BY 2 DESC;" 2>&1

echo "=== 5 grades recent ==="
sudo sqlite3 -header -column $DB "SELECT grade_id, snapshot_id, market, target, state, substr(recorded_at,1,19) rec FROM grades ORDER BY grade_id DESC LIMIT 10;" 2>&1

echo "=== 6 results recent ==="
sudo sqlite3 -header -column $DB "SELECT result_id, system, fixture_id, home_score, away_score, terminal_status, substr(recorded_at,1,19) rec FROM results ORDER BY result_id DESC LIMIT 10;" 2>&1

echo "=== 7 snapshot without result (pending 命中) ==="
sudo sqlite3 -header -column $DB "SELECT COUNT(*) pending_no_result FROM prediction_snapshots s LEFT JOIN results r ON r.system=s.system AND r.fixture_id=s.fixture_id WHERE r.result_id IS NULL AND datetime(s.kickoff) < datetime('now');" 2>&1

echo "=== 8 published dashboard json path ==="
sudo grep -rn "CROWN_WEB_ROOT\|write_dashboard\|dashboard.*json\|schema_version.*crown" /opt/footbreak/crown/dashboard_api.py /opt/footbreak/crown/dashboard_data.py 2>&1 | head -20

echo "=== 9 published data files ==="
sudo ls -la /var/www/crown/ 2>&1
sudo find /var/lib/footbreak/crown -name "*.json" 2>&1 | head

echo "=== 10 crown-dashboard-api status ==="
sudo systemctl status crown-dashboard-api.service --no-pager 2>&1 | head -20
