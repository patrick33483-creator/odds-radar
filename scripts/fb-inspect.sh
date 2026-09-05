#!/bin/bash
set -e
echo "=== LEARNING DB path check ==="
sudo ls -la /var/lib/footbreak/learning/ 2>&1 | head -10
echo "=== predictions.sqlite tables ==="
sudo sqlite3 /var/lib/footbreak/learning/predictions.sqlite ".tables" 2>&1
echo "=== predictions.sqlite schema for key tables ==="
sudo sqlite3 /var/lib/footbreak/learning/predictions.sqlite ".schema" 2>&1 | head -200
echo "=== sim_ledger.json head ==="
sudo head -c 3000 /opt/footbreak/system/sim_ledger.json 2>/dev/null | head -50
echo "=== result cache count ==="
sudo ls /opt/footbreak/system/cache/results/ 2>/dev/null | wc -l
sudo ls /opt/footbreak/system/cache/results/ 2>/dev/null | head -10
echo "=== crown module files ==="
sudo ls /opt/footbreak/crown/ 2>/dev/null
echo "=== dashboard_api.py first 100 lines ==="
sudo head -100 /opt/footbreak/crown/dashboard_api.py 2>/dev/null
