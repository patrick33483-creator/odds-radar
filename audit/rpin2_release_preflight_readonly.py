"""Approved release preflight. Production read-only; JSON stdout encrypted by workflow.

No environment reads, service control, Docker exec, source execution, HTTP requests,
backups, database writes, history access, credential files or filesystem writes.
"""
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import time
from pathlib import Path

ROOT = Path("/opt/crown-radar-v2")
DB = ROOT / "data/crown.db"
BATCH = 1789178336151
out = {"read_only": True, "captured_at_ms": int(time.time()*1000), "errors": []}
SENSITIVE = re.compile(r"password|passwd|secret|auth|basic|b64encode|api.?key|token|chat.?id|private.key|\.env", re.I)
RELATED = re.compile(r"crown|hkjc", re.I)
CODE = re.compile(r"finished_matches|hkjc_result|resultType|stageId|payoutConfirmed|DB_PATH|rPin2ExcelCohort|fix_hkjc_scores|upsert_hkjc_results|backfill_hkjc_official")
SCRIPT_PATH = re.compile(r"(?:/[A-Za-z0-9_.-]+)+\.(?:py|mjs|js|ts|sh)\b")


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def redact(line):
    if SENSITIVE.search(line):
        return "[sensitive-related line omitted]"
    line = re.sub(r"\b\d{6,}:[A-Za-z0-9_-]{25,}\b", "[redacted]", line)
    line = re.sub(r"\b(?:gh[pousr]_|github_pat_|dop_v1_)[A-Za-z0-9_]+\b", "[redacted]", line)
    line = re.sub(r"(https?://)[^/\s:@]+:[^/\s@]+@", r"\1[redacted]@", line)
    line = re.sub(r"(['\"])[A-Za-z0-9_+/=-]{30,}\1", "'[long literal omitted]'", line)
    return line[:1200]


def error(scope, exc):
    out["errors"].append({"scope": scope, "error_type": type(exc).__name__})


def metadata(path):
    p = Path(path)
    try:
        s = p.stat()
        return {"path": str(p), "exists": True, "realpath": str(p.resolve()),
                "device": s.st_dev, "inode": s.st_ino, "bytes": s.st_size,
                "mtime_ns": s.st_mtime_ns, "uid": s.st_uid, "gid": s.st_gid,
                "mode": oct(s.st_mode & 0o777)}
    except OSError:
        return {"path": str(p), "exists": False}


def file_evidence(path, snippets=False, json_data=False):
    info = metadata(path)
    if not info["exists"] or info["bytes"] > 3_000_000:
        return info
    try:
        raw = Path(path).read_bytes()
        info["sha256"] = sha(raw)
        if snippets:
            lines = raw.decode(errors="replace").splitlines()
            hits = [i for i,s in enumerate(lines) if CODE.search(s)]
            wanted = sorted({j for i in hits[:55] for j in range(max(0,i-4), min(len(lines),i+9))})
            info["hit_count"] = len(hits)
            info["lines"] = [{"line":i+1,"text":redact(lines[i])} for i in wanted[:450]]
        if json_data:
            def clean(v):
                if isinstance(v,dict):
                    return {k:clean(x) for k,x in v.items() if not SENSITIVE.search(k)}
                if isinstance(v,list):
                    return [clean(x) for x in v]
                return v
            info["data"] = clean(json.loads(raw))
    except (OSError,ValueError) as exc:
        error(str(path),exc)
    return info


def command(args, scope, timeout=8):
    # All callers below are fixed read-only commands. Never use shell=True.
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        if r.returncode:
            out["errors"].append({"scope":scope,"returncode":r.returncode})
            return ""
        return r.stdout
    except (OSError,subprocess.TimeoutExpired) as exc:
        error(scope,exc)
        return ""


targets = [
    ROOT/"server.js", ROOT/"data/r_pin2_excel_cohort.json",
    Path("/tmp/fix_hkjc_scores.mjs"), Path("/tmp/upsert_hkjc_results.mjs"),
    Path("/tmp/backfill_hkjc_official.mjs"),
    ROOT/"rule_matcher.js", ROOT/"rules_stats.js", ROOT/"full_sweep.js",
    ROOT/"hkjc-strategy.html", ROOT/"strategy.html",
]
out["target_files"] = [file_evidence(p, snippets=p.name=="server.js",
                                   json_data=p.name=="r_pin2_excel_cohort.json") for p in targets]
out["database_files"] = [metadata(str(DB)+suffix) for suffix in ("","-wal","-shm")]
try:
    v = os.statvfs(DB.parent)
    out["storage"] = {"directory":str(DB.parent),"available_bytes":v.f_bavail*v.f_frsize}
except OSError as exc:
    error("statvfs",exc)

# Derive the original historical ID scope from the already-approved exact dump.
# A changed fetched_at must not make a targeted row disappear from the comparison.
dump_path = Path("/tmp/hkjc_results_dump.json")
archive_ids = set()
try:
    raw=dump_path.read_bytes()
    out["archive"]={"path":str(dump_path),"sha256":sha(raw),"bytes":len(raw)}
    for day in json.loads(raw).values():
        for match in day.get("matches",[]):
            if re.fullmatch(r"\d+",str(match.get("id",""))):
                archive_ids.add("hkjc:"+str(match["id"]))
    if len(archive_ids)>10000:
        raise ValueError("Bounded historical ID scope exceeded")
    out["archive"]["unique_ids"]=len(archive_ids)
except (OSError,ValueError) as exc:
    error("archive ID scope",exc)

try:
    db=sqlite3.connect(f"file:{DB}?mode=ro",uri=True,timeout=2)
    db.row_factory=sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    db.execute("BEGIN")
    def rows(sql,args=()):
        return [dict(r) for r in db.execute(sql,args)]
    out["database"]={
        "query_only":db.execute("PRAGMA query_only").fetchone()[0],
        "journal_mode":db.execute("PRAGMA journal_mode").fetchone()[0],
        "database_list":rows("PRAGMA database_list"),
        "schema":rows("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN "
                      "('finished_matches','hkjc_matches','repair_result_audit','repair_migrations','data_migrations')"),
        "batch_rows":rows("SELECT * FROM finished_matches WHERE fetched_at=? ORDER BY sid",(BATCH,)),
        "bridge_rows":rows("SELECT * FROM finished_matches WHERE fetched_at=? ORDER BY sid",(BATCH+1,)),
        "original_scope_rows":[],"hkjc_fixtures":[],
        "all_finished_count":db.execute("SELECT count(*) FROM finished_matches").fetchone()[0],
    }
    ids=sorted(archive_ids)
    for start in range(0,len(ids),350):
        chunk=ids[start:start+350]
        marks=",".join("?" for _ in chunk)
        out["database"]["original_scope_rows"]+=rows("SELECT * FROM finished_matches WHERE sid IN ("+marks+")",chunk)
        out["database"]["hkjc_fixtures"]+=rows("SELECT * FROM hkjc_matches WHERE sid IN ("+marks+")",chunk)
    db.rollback()
    db.close()
except (OSError,sqlite3.Error) as exc:
    error("readonly database",exc)

# Bounded source inventory; files are read, never imported or executed.
out["writer_source_candidates"]=[]
for root in (ROOT,Path("/opt/hkjc-result-sync")):
    if not root.is_dir():
        continue
    candidates=[p for p in root.iterdir() if p.is_file() and not p.is_symlink()
                and p.suffix in (".py",".mjs",".js",".sh",".ts")
                and re.search(r"server|sync|result|hkjc|backfill|collector",p.name,re.I)
                and not SENSITIVE.search(p.name)]
    for p in sorted(candidates)[:45]:
        out["writer_source_candidates"].append(file_evidence(p,snippets=True))

# Read-only container metadata explicitly excludes Env, credential configuration and logs.
out["containers"]=[]
ps=command(["docker","ps","-a","--format","{{json .}}"],"docker ps")
for line in ps.splitlines():
    try:
        c=json.loads(line)
        if not RELATED.search(c.get("Names","")):
            continue
        name=c["Names"]
        fmt='{"Id":{{json .Id}},"Name":{{json .Name}},"ImageId":{{json .Image}},"Pid":{{.State.Pid}},"Running":{{.State.Running}},"StartedAt":{{json .State.StartedAt}},"WorkingDir":{{json .Config.WorkingDir}},"Mounts":{{json .Mounts}}}'
        raw=command(["docker","inspect","--format",fmt,name],"docker inspect "+name)
        if raw:
            item=json.loads(raw)
            item["image_label"]=c.get("Image")
            out["containers"].append(item)
    except (ValueError,KeyError) as exc:
        error("container metadata",exc)

# Selected systemd service/timer state; no systemctl start/restart/stop or journal reads.
out["units"]=[]
for kind in ("service","timer"):
    text=command(["systemctl","list-units","--all","--type="+kind,"--plain","--no-legend","--no-pager"],"list "+kind)
    names=[line.split()[0] for line in text.splitlines() if line.split() and RELATED.search(line.split()[0])]
    priority=(["hkjc-result-sync.service","crown-strategy-results.service","crown-mobile-fallback.service"]
              if kind=="service" else ["hkjc-result-sync.timer","crown-strategy-results.timer"])
    names=list(dict.fromkeys(priority+names))
    for name in names[:30]:
        text=command(["systemctl","show",name,"--no-pager",
                      "--property=Id,ActiveState,SubState,MainPID,FragmentPath,WorkingDirectory,Triggers,TriggeredBy"],
                     "show "+name)
        fields=dict(line.split("=",1) for line in text.splitlines() if "=" in line)
        fragment=fields.get("FragmentPath")
        if fragment and Path(fragment).is_file():
            raw=Path(fragment).read_bytes()
            fields["fragment_sha256"]=sha(raw)
            entries=[]
            for i,line in enumerate(raw.decode(errors="replace").splitlines()):
                if re.match(r"(ExecStart|ExecStartPre|ExecStartPost|WorkingDirectory|OnCalendar|OnUnitActiveSec|OnUnitInactiveSec|OnBootSec|Unit|Persistent|RandomizedDelaySec)=",line):
                    entries.append({"line":i+1,"text":redact(line)})
            fields["selected_unit_lines"]=entries
        out["units"].append(fields)

# Cron only for the root/system files relevant to this project, never shell history.
out["cron_references"]=[]
cronpaths=[Path("/etc/crontab"),Path("/var/spool/cron/crontabs/root")]
cronpaths+=sorted(Path("/etc/cron.d").glob("*"))
for path in cronpaths:
    if not path.is_file() or path.is_symlink() or path.stat().st_size>200000:
        continue
    raw=path.read_bytes()
    for i,line in enumerate(raw.decode(errors="replace").splitlines()):
        if line.lstrip().startswith("#") or not RELATED.search(line) or re.match(r"^\s*\w+=",line):
            continue
        # Return script identities plus hash, not arbitrary arguments or credentials.
        out["cron_references"].append({
            "file":str(path),"file_sha256":sha(raw),"line":i+1,
            "schedule_tokens":line.split()[:5],"script_paths":SCRIPT_PATH.findall(line),
            "line_sha256":sha(line.encode()),
            "legacy_importer_reference":bool(re.search(r"fix_hkjc_scores|upsert_hkjc_results|backfill_hkjc_official",line)),
        })

# Match running processes to containers/crown paths; emit no cmdline or environment.
container_pids={str(c["Pid"]) for c in out["containers"] if c["Pid"]}
container_ids=[c["Id"] for c in out["containers"]]
out["processes"]=[]
for proc in Path("/proc").iterdir():
    if not proc.name.isdigit():
        continue
    try:
        argv=[x.decode(errors="replace") for x in (proc/"cmdline").read_bytes().split(b"\0") if x]
        if not argv:
            continue
        cwd=os.readlink(proc/"cwd")
        cgroup=(proc/"cgroup").read_text()
        relevant=(proc.name in container_pids or RELATED.search(cwd)
                  or any(x in cgroup for x in container_ids)
                  or any(RELATED.search(a) for a in argv[:3]))
        if not relevant:
            continue
        item={"pid":int(proc.name),"executable":os.readlink(proc/"exe"),"cwd":cwd,
              "container_ids":[x for x in container_ids if x in cgroup],
              "script_arguments":[],"database_fds":[]}
        for arg in argv[1:4]:
            if re.fullmatch(r"[A-Za-z0-9_./-]+\.(?:py|mjs|js|sh)",arg) and not SENSITIVE.search(arg):
                item["script_arguments"].append(arg)
                resolved=(proc/"root"/arg.lstrip("/")) if arg.startswith("/") else (proc/"cwd"/arg)
                info=file_evidence(resolved)
                info["process_namespace_argument"]=arg
                item.setdefault("script_file_evidence",[]).append(info)
        for fd in (proc/"fd").iterdir():
            try:
                target=os.readlink(fd)
                if target.endswith(("crown.db","crown.db-wal","crown.db-shm")):
                    record=metadata(fd)
                    record["target"]=target
                    fdinfo=(proc/"fdinfo"/fd.name).read_text()
                    match=re.search(r"^flags:\s+(\d+)",fdinfo,re.M)
                    if match:
                        record["open_access_mode"]=int(match[1],8)&3
                    item["database_fds"].append(record)
            except OSError:
                continue
        out["processes"].append(item)
    except (OSError,ValueError) as exc:
        # Processes can disappear normally during a read-only snapshot.
        continue

out["git_heads"]=[]
for root in (ROOT,Path("/opt/hkjc-result-sync")):
    if (root/".git").exists():
        head=command(["git","-C",str(root),"rev-parse","HEAD"],"git HEAD "+str(root))
        out["git_heads"].append({"path":str(root),"head":head.strip()})

# Follow only exact writer/cron identities found in the first read-only pass.
# These files are source evidence; never execute their commands or import them.
out["focused_writer_sources"]=[]
for path in (
    Path("/opt/hkjc-result-sync/sync_results.py"),
    Path("/opt/crown-strategy-results/sync_results.py"),
    Path("/opt/crown-mobile-fallback/mobile_fallback.py"),
    Path("/opt/crown-radar-cron/hkjc_health.sh"),
    Path("/opt/crown-radar-cron/daily_sweep.sh"),
    ROOT/"docker-compose.yml",
):
    info=file_evidence(path)
    if info.get("exists") and info.get("bytes",0)<100000:
        lines=path.read_text(errors="replace").splitlines()
        info["lines"]=[{"line":i+1,"text":redact(line)} for i,line in enumerate(lines[:800])]
    out["focused_writer_sources"].append(info)
out["server_refresh_and_schedule_lines"]=[]
server_lines=(ROOT/"server.js").read_text(errors="replace").splitlines()
hits=[i for i,line in enumerate(server_lines) if re.search(
    r"refreshScores|setInterval|collectHkjc|hkjc.*collect|scores.*refresh",line,re.I)]
wanted={j for i in hits for j in range(max(0,i-3),min(len(server_lines),i+7))}
wanted.update(range(385,min(515,len(server_lines))))
out["server_refresh_and_schedule_lines"]=[
    {"line":i+1,"text":redact(server_lines[i])} for i in sorted(wanted)]

# Re-read exact reviewed file hashes to detect source change during capture.
out["target_files_end"]=[file_evidence(p) for p in targets]
out["completed_at_ms"]=int(time.time()*1000)
out["scope_limits"]=[
    "No live HTTP endpoints, app imports, backup creation, full DB integrity scan or service changes.",
    "Service/timer names filtered to crown/hkjc; root/system cron only; no unrelated-user crontabs.",
    "Open database FD proves file identity and access mode, not a particular SQL write.",
    "Bounded source/cron inventory is not an exhaustive proof that no unknown external writer exists.",
]
print(json.dumps(out,ensure_ascii=False,sort_keys=True))
