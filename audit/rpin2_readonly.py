"""Bounded production read-only evidence collection; stdout only."""
import hashlib
import json
import os
import re
import sqlite3
from pathlib import Path

ROOTS = [Path("/opt/crown-radar-v2"), Path("/opt/hkjc-result-sync")]
PATTERN = re.compile(r"finished_matches|homeResult|awayResult|resultType|stageId|matchResult|1789178336151")
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
            wanted = sorted({j for i in hits[:35] for j in range(max(0, i-5), min(len(lines), i+9))})
            out["source_snippets"].append({
                "path": str(p), "sha256": hashlib.sha256(text.encode()).hexdigest(),
                "mtime": stat.st_mtime, "hit_count": len(hits),
                "lines": [{"line": i+1, "text": redact(lines[i])} for i in wanted[:350]],
            })
            if len(out["source_snippets"]) >= 80:
                break
        if len(out["source_snippets"]) >= 80:
            break

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
