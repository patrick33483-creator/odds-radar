#!/bin/bash
DB=/var/lib/footbreak/learning/predictions.sqlite

echo "=== E. before results count ==="
sudo sqlite3 -header -column $DB "SELECT COUNT(*) results, MAX(recorded_at) latest FROM results;" 2>&1

echo "=== F. trigger settlement via /api/settle ==="
curl -sS -X POST \
  -H "X-Crown-Action: settle-simulation" \
  -H "Content-Type: application/json" \
  -d '{"confirm":"simulation-only"}' \
  http://127.0.0.1:8765/api/settle -o /tmp/settle_resp.json -w "HTTP %{http_code}\n"
echo "--- response head ---"
head -c 4000 /tmp/settle_resp.json
echo

echo "=== G. after results count ==="
sudo sqlite3 -header -column $DB "SELECT COUNT(*) results, MAX(recorded_at) latest FROM results;" 2>&1

echo "=== H. dashboard data.json mtime + rule search ==="
sudo ls -la /var/www/crown/data.json
sudo python3 -c "
import json
d=json.load(open('/var/www/crown/data.json'))
print('schema_version', d.get('schema_version'))
print('generated_at', d.get('generated_at'))
print('top keys:', list(d.keys())[:20])
# search
def find(o, target):
    if isinstance(o,dict):
        if o.get('rule_id')==target or o.get('id')==target: return o
        for v in o.values():
            r=find(v,target)
            if r: return r
    elif isinstance(o,list):
        for i in o:
            r=find(i,target)
            if r: return r
    return None
r = find(d, 'S-HIL-T5-OVER-185')
if r:
    print('rule found')
    for k,v in r.items():
        if isinstance(v,(int,float,str,bool)) and len(str(v))<80:
            print(f'  {k}={v}')
else:
    print('rule NOT in payload — grep entire payload for rule text')
    import re
    matches = re.findall(r'S-HIL-T5-OVER-\d+', json.dumps(d))
    print('all HIL rules found:', set(matches))
" 2>&1
