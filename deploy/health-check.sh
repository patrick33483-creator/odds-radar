#!/usr/bin/env bash
set -euo pipefail

cd /opt/odds-radar
set -a
. ./.env
set +a

echo "=== radar production health $(TZ=Asia/Hong_Kong date '+%F %T %Z') ==="

for name in RADAR_ACCESS_USER RADAR_ACCESS_PASSWORD PINNAPI_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
  [ -n "${!name:-}" ] || {
    echo "FAIL missing $name" >&2
    exit 1
  }
  echo "OK credential/config $name"
done

running="$(docker compose ps --status running --services)"
grep -qx radar <<<"$running" || {
  echo "FAIL radar container not running" >&2
  docker compose ps >&2
  exit 1
}
container_id="$(docker compose ps -q radar)"
health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"
[ "$health" = healthy ] || {
  echo "FAIL radar container health=$health" >&2
  exit 1
}
echo "OK radar container running and healthy"

for name in RADAR_AUTO_SCAN RADAR_HOURLY_PREWARM; do
  value="$(docker compose exec -T radar printenv "$name")"
  [ "$value" = 1 ] || {
    echo "FAIL runtime $name=$value" >&2
    exit 1
  }
  echo "OK runtime $name=1"
done

curl --fail --silent --show-error --max-time 15 \
  http://127.0.0.1:5001/healthz >/dev/null
echo "OK /healthz"

window_json="$(curl --fail --silent --show-error --max-time 30 \
  --user "$RADAR_ACCESS_USER:$RADAR_ACCESS_PASSWORD" \
  http://127.0.0.1:5001/api/scan/window)"
status_json="$(curl --fail --silent --show-error --max-time 30 \
  --user "$RADAR_ACCESS_USER:$RADAR_ACCESS_PASSWORD" \
  http://127.0.0.1:5001/api/status)"

python3 - "$window_json" "$status_json" <<'PY'
import json
import sys

window = json.loads(sys.argv[1])
status = json.loads(sys.argv[2])
config = window.get("config") or {}
if config.get("windowMinutes") != 30:
    raise SystemExit(f"FAIL scan window={config.get('windowMinutes')}")
if config.get("intervalSec") != 30:
    raise SystemExit(f"FAIL scan interval={config.get('intervalSec')}")
print(
    "OK dense scan "
    f"window={config.get('windowMinutes')}m interval={config.get('intervalSec')}s "
    f"in_window={len(window.get('inWindow') or [])}"
)
print("OK radar status keys=" + ",".join(sorted(status)[:12]))
PY

if docker compose logs --since 15m radar 2>&1 | grep -Eq \
  '"event":"(auto_window_scan_error|hourly_prewarm_error)"'; then
  echo "FAIL recent automatic scan error" >&2
  docker compose logs --since 15m radar 2>&1 | grep -E \
    '"event":"(auto_window_scan_error|hourly_prewarm_error)"' >&2
  exit 1
fi
echo "OK no recent automatic scan errors"
echo "=== radar production health PASS ==="
