#!/bin/bash
DB=/var/lib/footbreak/learning/predictions.sqlite

echo "=== A. dashboard_api.py first 200 lines ==="
sudo sed -n '1,200p' /opt/footbreak/crown/dashboard_api.py 2>&1

echo "=== B. dashboard_api.py routes (grep) ==="
sudo grep -nE "self\.path|/api|/settle|/tick|def do_|def _handle|url_prefix|route" /opt/footbreak/crown/dashboard_api.py 2>&1

echo "=== C. snapshot schema ==="
sudo sqlite3 $DB ".schema prediction_snapshots"
echo "--- results schema ---"
sudo sqlite3 $DB ".schema results"
