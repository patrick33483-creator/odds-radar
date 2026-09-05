#!/bin/bash
DB=/var/lib/footbreak/learning/predictions.sqlite
echo "=== results now ==="
sudo sqlite3 -header -column $DB "SELECT COUNT(*) rows, MAX(recorded_at) latest FROM results;"
echo "=== data.json mtime ==="
sudo ls -la /var/www/crown/data.json /var/www/crown/data-health.json
echo "=== check if settle is still holding lock ==="
sudo ls -la /var/www/crown/.data.json.publish.lock 2>&1
sudo lsof /var/www/crown/.data.json.publish.lock 2>&1 | head
echo "=== crown-dashboard-api journal last 30 ==="
sudo journalctl -u crown-dashboard-api.service -n 30 --no-pager 2>&1 | tail -20
echo "=== python processes ==="
ps aux | grep -E "python|crown" | grep -v grep | head -10
