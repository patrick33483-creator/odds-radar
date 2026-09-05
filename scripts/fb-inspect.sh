#!/bin/bash
set -e
echo "=== grades schema ==="
sudo sqlite3 /var/lib/footbreak/learning/predictions.sqlite ".schema grades"
echo "=== grades row count ==="
sudo sqlite3 /var/lib/footbreak/learning/predictions.sqlite "SELECT COUNT(*) FROM grades;"
echo "=== grades cols ==="
sudo sqlite3 -header /var/lib/footbreak/learning/predictions.sqlite "SELECT * FROM grades LIMIT 3;"
echo "=== grades distinct outcome/status ==="
sudo sqlite3 -header /var/lib/footbreak/learning/predictions.sqlite "SELECT DISTINCT * FROM (SELECT name FROM pragma_table_info('grades'));"
echo "=== dashboard_api.py full ==="
sudo cat /opt/footbreak/crown/dashboard_api.py
