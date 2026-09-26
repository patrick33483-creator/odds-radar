"""Bounded production read-only evidence collection; stdout only."""
import hashlib
import json
import os
import re
import sqlite3
from pathlib import Path

ROOTS = [Path("/opt/crown-radar-v2"), Path("/opt/hkjc-result-sync")]
PATTERN = re.compile(r"finished_matches|homeResult|awayResult|resultType|stageId|matchResult|1789178336151|conflicting_final_score")
SKIP = {".git", "node_modules", ".venv", "__pycache__", "site-packages"}
IDS = ("hkjc:50074155", "hkjc:50073981", "hkjc:50073973", "hkjc:50073793", "hkjc:50074050")
out = {"read_only": True, "roots": [], "source_snippets": [], "raw_file_inventory": [], "db_rows": []}

def redact(line):
    if re.search(r"private.key|BEGIN.*PRIVATE|password|passwd|secret|authorization|api.?key|token|chat.?id", line, re.I):
        return "[credential-related line omitted]"
    line = re.sub(r"\b\d{6,}:[A-Za-z0-9_-]{25,}\b", "[redacted]", line)
    line = re.sub(r"(https?://)[^/\s:@]+:[^/\s@]+@", r"\1[redacted]@", line)
    line = re.sub(r"\b(?:gh[pousr]_|github_pat_|dop_v1_)[A-Za-z0-9_]+\b", "[redacted]", line)
    line = re.sub(r"(['\"])[A-Za-z0-9_+/=-]{40,}\1", "'[long literal omitted]'", line)
    return line[:1200]

for root in ROOTS:
    out["roots"].append({"path": str(root), "exists": root.is_dir()})
    if not root.is_dir():
        continue
    for directory, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = [d for d in sorted(dirs) if d not in SKIP and not d.startswith(".")]
        if len(Path(directory).relative_to(root).parts) > 3:
            dirs[:] = []
            continue
        for name in sorted(names):
            p = Path(directory) / name
            if p.is_symlink() or name.startswith(".") or re.search(r"secret|credential|password|\.pem|\.key|\.env", name, re.I):
                continue
            stat = p.stat()
            if re.search(r"hkjc|result|backfill|20260912|2026-09-12", name, re.I):
                out["raw_file_inventory"].append({"path": str(p), "bytes": stat.st_size, "mtime": stat.st_mtime})
            if not re.search(r"\.(?:py|mjs|js|ts|sh)(?:$|\.bak|\.2026)", name) or stat.st_size > 2_000_000:
                continue
            text = p.read_text(errors="replace")
            lines = text.splitlines()
            hits = [i for i, line in enumerate(lines) if PATTERN.search(line)]
            if not hits:
                continue
            wanted = sorted({j for i in hits[:35] for j in range(max(0, i-5), min(len(lines), i+12))})
            out["source_snippets"].append({
                "path": str(p), "sha256": hashlib.sha256(text.encode()).hexdigest(),
                "mtime": stat.st_mtime, "hit_count": len(hits),
                "lines": [{"line": i+1, "text": redact(lines[i])} for i in wanted[:350]],
            })
            if len(out["source_snippets"]) >= 80:
                break
        if len(out["source_snippets"]) >= 80:
            break

# Separately approved /tmp search: depth <=2, matching filenames only.
# No execution of discovered scripts, no shell history, no hidden/symlink files.
out["tmp_inventory"] = []
out["tmp_source_snippets"] = []
out["tmp_selected_results"] = []
target_ids = {sid.split(":")[1] for sid in IDS}
safe_keys = {"id", "matchId", "sid", "kickOffTime", "matchDate", "status",
             "resultType", "stageId", "homeResult", "awayResult",
             "payoutConfirmed", "sequence", "homeScore", "awayScore"}

def select_results(node, source):
    if isinstance(node, list):
        for item in node:
            select_results(item, source)
    elif isinstance(node, dict):
        identity = next((str(node[k]).replace("hkjc:", "") for k in ("id", "matchId", "sid")
                         if k in node and str(node[k]).replace("hkjc:", "") in target_ids), None)
        if identity:
            selected = {k: v for k, v in node.items()
                        if k in safe_keys and isinstance(v, (str, int, float, bool, type(None)))}
            def result_rows(value):
                rows = []
                if isinstance(value, dict):
                    if "resultType" in value and "stageId" in value:
                        rows.append({k: v for k, v in value.items() if k in safe_keys
                                     and isinstance(v, (str, int, float, bool, type(None)))})
                    else:
                        for child in value.values():
                            rows.extend(result_rows(child))
                elif isinstance(value, list):
                    for child in value:
                        rows.extend(result_rows(child))
                return rows
            selected["result_rows"] = result_rows(node)
            out["tmp_selected_results"].append({"path": source, "match": selected})
        else:
            for value in node.values():
                select_results(value, source)

tmp = Path("/tmp")
for directory, dirs, names in os.walk(tmp, followlinks=False):
    depth = len(Path(directory).relative_to(tmp).parts)
    dirs[:] = [d for d in sorted(dirs) if d not in SKIP and not d.startswith(".")
               and not (Path(directory) / d).is_symlink()] if depth < 2 else []
    for name in sorted(names):
        if not re.search(r"hkjc|backfill|result|20260912", name, re.I):
            continue
        p = Path(directory) / name
        if p.is_symlink() or name.startswith(".") or re.search(
                r"secret|credential|password|history|\.pem|\.key|\.env", name, re.I):
            continue
        try:
            stat = p.stat()
            if not p.is_file():
                continue
            out["tmp_inventory"].append({"path": str(p), "bytes": stat.st_size, "mtime": stat.st_mtime})
            if re.search(r"\.(?:py|mjs|js|ts|sh|log|txt)(?:$|\.bak|\.2026)", name) and stat.st_size <= 2_000_000:
                text = p.read_text(errors="replace")
                lines = text.splitlines()
                hits = [i for i, line in enumerate(lines) if PATTERN.search(line)]
                if hits and len(out["tmp_source_snippets"]) < 80:
                    wanted = sorted({j for i in hits[:35] for j in range(max(0, i-5), min(len(lines), i+12))})
                    out["tmp_source_snippets"].append({
                        "path": str(p), "sha256": hashlib.sha256(text.encode()).hexdigest(),
                        "mtime": stat.st_mtime, "hit_count": len(hits),
                        "lines": [{"line": i+1, "text": redact(lines[i])} for i in wanted[:350]],
                    })
            elif name.endswith(".json") and stat.st_size <= 20_000_000:
                raw = p.read_bytes()
                out["tmp_inventory"][-1]["sha256"] = hashlib.sha256(raw).hexdigest()
                select_results(json.loads(raw), str(p))
        except (OSError, ValueError, RecursionError):
            out.setdefault("tmp_unreadable", []).append(str(p))

for path in (Path("/opt/crown-radar-v2/data/crown.db"),):
    if not path.is_file():
        continue
    try:
        db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=1)
        db.execute("PRAGMA query_only=ON")
        db.row_factory = sqlite3.Row
        columns = {r["name"] for r in db.execute("PRAGMA table_info(finished_matches)")}
        allowed = [c for c in ("sid", "status", "home_score", "away_score", "ht_home_score", "ht_away_score", "fetched_at") if c in columns]
        if "sid" in columns:
            sql = f"SELECT {','.join(allowed)} FROM finished_matches WHERE sid IN ({','.join('?' for _ in IDS)})"
            out["db_rows"] = [dict(r) for r in db.execute(sql, IDS)]
        if "fetched_at" in columns:
            out["batch_row_count_now"] = db.execute(
                "SELECT count(*) FROM finished_matches WHERE fetched_at=?", (1789178336151,)
            ).fetchone()[0]
        db.close()
    except Exception as exc:
        out["db_error_type"] = type(exc).__name__
print(json.dumps(out, ensure_ascii=False, sort_keys=True))
