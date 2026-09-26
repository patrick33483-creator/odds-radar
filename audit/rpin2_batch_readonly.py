"""Authorized full-batch isolated remediation evidence; production SELECT/read only."""
import hashlib
import json
import re
import sqlite3
import time
from pathlib import Path

BATCH = 1789178336151
ROOT = Path("/opt/crown-radar-v2")
out = {"read_only": True, "captured_at_ms": int(time.time()*1000), "batch": BATCH}
deny = re.compile(r"password|passwd|secret|authorization|api.?key|token|chat.?id|private.key", re.I)

def sanitize(value):
    if isinstance(value, dict):
        return {k: sanitize(v) for k, v in value.items() if not deny.search(k)}
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    if isinstance(value, bytes):
        return "[binary omitted]"
    if isinstance(value, str):
        return re.sub(r"\b\d{6,}:[A-Za-z0-9_-]{25,}\b", "[redacted]", value)
    return value

db = sqlite3.connect(f"file:{ROOT}/data/crown.db?mode=ro", uri=True, timeout=2)
db.row_factory = sqlite3.Row
db.execute("PRAGMA query_only=ON")
db.execute("BEGIN")
out["schema"] = [dict(r) for r in db.execute(
    "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name")
    if not deny.search(r["name"])]
schemas = {r["name"]: [c["name"] for c in db.execute('PRAGMA table_info("'+r["name"].replace('"','""')+'")')]
           for r in out["schema"]}

def rows(sql, args=()):
    return [sanitize(dict(r)) for r in db.execute(sql, args)]

out["batch_rows"] = rows("SELECT * FROM finished_matches WHERE fetched_at=? ORDER BY sid", (BATCH,))
out["bridge_timestamp_rows"] = rows("SELECT * FROM finished_matches WHERE fetched_at=? ORDER BY sid", (BATCH+1,))
ids = {str(r["sid"]) for k in ("batch_rows", "bridge_timestamp_rows") for r in out[k]}
batch_ids = {str(r["sid"]) for r in out["batch_rows"]}

def selected(table, column, values):
    result = []
    col = '"' + column.replace('"','""') + '"'
    tbl = '"' + table.replace('"','""') + '"'
    values = sorted(values)
    for start in range(0, len(values), 350):
        chunk = values[start:start+350]
        result.extend(rows(f"SELECT * FROM {tbl} WHERE {col} IN ({','.join('?' for _ in chunk)})", chunk))
    return result

out["titan_mappings"] = selected("titan_matches", "sid", batch_ids)
ids.update(str(r["titan_id"]) for r in out["titan_mappings"] if r.get("titan_id") is not None)
out["related_finished_rows"] = selected("finished_matches", "sid", ids)
out["hkjc_fixtures"] = selected("hkjc_matches", "sid", batch_ids)
out["titan_fixtures"] = selected("matches", "sid", ids)
out["related_tables"] = {}
out["table_counts"] = {}
for table, columns in schemas.items():
    if not re.search(r"strategy|signal|notif|fire|settle|history|bet|corner|snapshot", table, re.I):
        continue
    out["table_counts"][table] = db.execute('SELECT count(*) FROM "'+table.replace('"','""')+'"').fetchone()[0]
    identity = next((c for c in ("sid", "match_id", "match_sid", "event_id", "fixture_id", "titan_id") if c in columns), None)
    if identity:
        found = selected(table, identity, ids)
        out["related_tables"][table] = {"identity_column": identity, "rows": found}
db.rollback()
db.close()

dump_path = Path("/tmp/hkjc_results_dump.json")
raw = dump_path.read_bytes()
dump = json.loads(raw)
out["archive"] = {"path": str(dump_path), "sha256": hashlib.sha256(raw).hexdigest(),
                  "bytes": len(raw), "mtime": dump_path.stat().st_mtime, "matches": []}
bare_ids = {sid.replace("hkjc:", "") for sid in batch_ids}
for day, payload in dump.items():
    for match in payload.get("matches", []):
        if str(match.get("id")) in bare_ids:
            out["archive"]["matches"].append({"query_date": day, "match": sanitize(match)})

# Read source only; never execute imports, app startup, or legacy repair programs.
out["source_files"] = []
for name in ("server.js", "docker-compose.yml", "compose.yml", "strategy.html", "hkjc-strategy.html",
             "rule_matcher.js", "rules_stats.js", "full_sweep.js"):
    path = ROOT / name
    if path.is_file() and path.stat().st_size <= 2_000_000:
        raw = path.read_bytes()
        lines = raw.decode(errors="replace").splitlines()
        clean = []
        for i, line in enumerate(lines):
            if deny.search(line):
                line = "[credential-related line omitted]"
            clean.append({"line": i+1, "text": sanitize(line)})
        out["source_files"].append({"path": str(path), "sha256": hashlib.sha256(raw).hexdigest(), "lines": clean})
out["data_file_inventory"] = []
for base in (ROOT / "data", ROOT / "public"):
    if base.is_dir():
        for p in sorted(base.glob("*")):
            if p.is_file() and not p.is_symlink() and not deny.search(p.name):
                out["data_file_inventory"].append({"path": str(p), "bytes": p.stat().st_size})
out["derived_json"] = []
for p in sorted((ROOT / "data").glob("*.json")):
    if p.stat().st_size <= 2_000_000 and re.match(r"(r_pin2_|rules|hkjc_.*candidates)", p.name):
        raw = p.read_bytes()
        try:
            out["derived_json"].append({"path": str(p), "sha256": hashlib.sha256(raw).hexdigest(),
                                        "data": sanitize(json.loads(raw))})
        except ValueError:
            pass
out["related_project_inventory"] = []
for root in sorted(Path("/opt").glob("*crown*")):
    if root.is_dir() and not root.is_symlink():
        out["related_project_inventory"].append({"path": str(root),
            "entries": sorted(p.name for p in root.iterdir()
                              if not p.name.startswith(".") and not deny.search(p.name))})
print(json.dumps(out, ensure_ascii=False, sort_keys=True))
