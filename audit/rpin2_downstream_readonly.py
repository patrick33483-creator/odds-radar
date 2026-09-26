"""Read-only Crown V3/V4 dependency discovery; no imports of application code."""
import hashlib
import json
import re
from pathlib import Path

out = {"read_only": True, "sources": [], "inventories": [], "json_files": []}
deny = re.compile(r"password|passwd|secret|auth|basic|b64encode|api.?key|token|chat.?id|private.key", re.I)
paths = [Path("/opt/crownsystem-v3/heavy_watch.py"),
         Path("/opt/crownsystem-v4/v4_common.py"),
         Path("/opt/crownsystem-v4/v4_merge.py"),
         Path("/opt/crownsystem-v4/v4_v3schema_merge.py"),
         Path("/var/www/crownsystem-v3/strategy.html")]
for root in (Path("/opt/crown-v3/src"), Path("/opt/crown-v3/data")):
    if root.is_dir():
        out["inventories"].append({"path": str(root), "entries": [
            {"name": p.name, "bytes": p.stat().st_size, "directory": p.is_dir()}
            for p in sorted(root.iterdir()) if not p.name.startswith(".") and not deny.search(p.name)]})
for p in paths:
    if not p.is_file():
        continue
    raw = p.read_bytes()
    text = raw.decode(errors="replace")
    out["sources"].append({"path": str(p), "sha256": hashlib.sha256(raw).hexdigest(),
        "lines": [{"line": i+1, "text": "[credential-related line omitted]" if deny.search(line) else line}
                  for i, line in enumerate(text.splitlines())]})
    for filename in re.findall(r"""["'](/(?:var/www|opt)/[^"' \n]+\.json)["']""", text):
        f = Path(filename)
        if deny.search(filename) or not re.search(r"result|prediction|history|match|strategy", f.name):
            continue
        if f.is_file() and f.stat().st_size < 30_000_000:
            raw = f.read_bytes()
            try:
                data = json.loads(raw)
            except ValueError:
                continue
            def clean(v):
                if isinstance(v, dict):
                    return {k: clean(x) for k,x in v.items() if not deny.search(k)}
                if isinstance(v, list):
                    return [clean(x) for x in v]
                return v
            out["json_files"].append({"path": filename, "sha256": hashlib.sha256(raw).hexdigest(),
                                       "bytes": len(raw), "data": clean(data)})
for root in (Path("/var/www/crownsystem-v3"), Path("/var/www/crownsystem-v4")):
    if root.is_dir():
        out["inventories"].append({"path": str(root), "entries": [
            {"name": p.name, "bytes": p.stat().st_size, "directory": p.is_dir()}
            for p in sorted(root.iterdir()) if p.is_file() and not p.name.startswith(".")
            and not deny.search(p.name)]})
for f in (Path("/var/www/crownsystem-v4/results.json"),):
    if f.is_file() and f.stat().st_size < 30_000_000:
        raw = f.read_bytes()
        out["json_files"].append({"path": str(f), "sha256": hashlib.sha256(raw).hexdigest(),
                                 "bytes": len(raw), "data": clean(json.loads(raw))})
print(json.dumps(out, ensure_ascii=False))
