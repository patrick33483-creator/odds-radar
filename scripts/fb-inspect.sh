#!/bin/bash
set -e
DB=/var/lib/footbreak/learning/predictions.sqlite

echo "=== rows summary ==="
sudo sqlite3 -header -column $DB "SELECT (SELECT COUNT(*) FROM prediction_snapshots) snap, (SELECT COUNT(*) FROM results) res, (SELECT COUNT(*) FROM grades) grd;"

echo "=== grades state distribution ==="
sudo sqlite3 -header -column $DB "SELECT state, COUNT(*) FROM grades GROUP BY state ORDER BY 2 DESC;"

echo "=== prediction_snapshots schema ==="
sudo sqlite3 $DB ".schema prediction_snapshots"

echo "=== crown module python files ==="
sudo ls /opt/footbreak/crown/*.py 2>/dev/null

echo "=== settle.py full ==="
sudo cat /opt/footbreak/crown/settle.py 2>/dev/null
