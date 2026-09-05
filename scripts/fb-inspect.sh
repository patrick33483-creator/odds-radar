#!/bin/bash
set -e
echo "=== published dashboard data path ==="
sudo grep -rn "crown-dashboard-v2\|CROWN_WEB_ROOT\|dashboard_public\|dashboard\.json\|write_dashboard_data" /opt/footbreak/crown/*.py | head -30

echo "=== web root ==="
sudo ls /var/www/crown/ 2>/dev/null

echo "=== dashboard json file ==="
sudo find /var/www/crown -name "*.json" 2>/dev/null | head
sudo find /var/lib/footbreak -name "*.json" 2>/dev/null | head

echo "=== sim_ledger.json first 5000 chars ==="
sudo head -c 5000 /opt/footbreak/system/sim_ledger.json 2>/dev/null

echo "=== sim_ledger.json size + structure ==="
sudo wc -c /opt/footbreak/system/sim_ledger.json 2>/dev/null
sudo python3 -c "
import json
with open('/opt/footbreak/system/sim_ledger.json') as f:
    d = json.load(f)
print('top keys:', list(d.keys()) if isinstance(d, dict) else 'list len ' + str(len(d)))
if isinstance(d, dict):
    for k,v in d.items():
        if isinstance(v,list): print(f'  {k}: list[{len(v)}]')
        elif isinstance(v,dict): print(f'  {k}: dict keys={list(v.keys())[:5]}')
        else: print(f'  {k}: {type(v).__name__}')
"
