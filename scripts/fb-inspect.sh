#!/bin/bash
set -e
DB=/var/lib/footbreak/learning/predictions.sqlite
echo "=== grades schema ==="
sudo sqlite3 $DB ".schema grades"
echo "=== results schema ==="
sudo sqlite3 $DB ".schema results"
echo "=== grades count ==="
sudo sqlite3 $DB "SELECT COUNT(*) FROM grades;"
echo "=== results count ==="
sudo sqlite3 $DB "SELECT COUNT(*) FROM results;"
echo "=== grades sample ==="
sudo sqlite3 -header -column $DB "SELECT * FROM grades LIMIT 3;"
echo "=== results sample ==="
sudo sqlite3 -header -column $DB "SELECT * FROM results LIMIT 3;"
echo "=== dashboard_data.py ==="
sudo cat /opt/footbreak/crown/dashboard_data.py 2>/dev/null | head -300
echo "=== settle.py ==="
sudo cat /opt/footbreak/crown/settle.py 2>/dev/null | head -200
