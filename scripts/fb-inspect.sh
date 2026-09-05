#!/bin/bash
DB=/var/lib/footbreak/learning/predictions.sqlite

echo "=== A. dashboard_api.py routes ==="
sudo grep -n "path\|route\|def do_\|self\.path\|def _handle\|POST\|GET\|/api\|/settle\|/tick\|url" /opt/footbreak/crown/dashboard_api.py 2>&1 | head -50

echo "=== B. snapshot schema ==="
sudo sqlite3 $DB ".schema prediction_snapshots" 2>&1 | head -40

echo "=== C. results table home/away? ==="
sudo sqlite3 -header -column $DB "SELECT * FROM results LIMIT 2;" 2>&1

echo "=== D. all endpoint paths in dashboard_api.py ==="
sudo grep -E "\"/[a-z_-]" /opt/footbreak/crown/dashboard_api.py 2>&1 | head -30
