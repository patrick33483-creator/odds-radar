"""Titan007 fetch + parse. Sandbox-safe (uses urllib.request only)."""
from __future__ import annotations
import gzip, io, json, re, ssl, time, urllib.request, urllib.parse
from html.parser import HTMLParser
from typing import Optional

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
CTX = ssl.create_default_context()


def _fetch(url: str, referer: str = "https://live.titan007.com/", timeout: float = 25.0) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-HK,zh;q=0.9,en;q=0.8",
            "Accept-Encoding": "gzip",
            "Referer": referer,
        },
    )
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        data = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            data = gzip.decompress(data)
        # titan007 detail pages are gb2312; asian odds pages are utf-8. Try
        # utf-8 first, then fall back to gb18030.
        for enc in ("utf-8", "gb18030"):
            try:
                return data.decode(enc)
            except UnicodeDecodeError:
                continue
        return data.decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Pinnacle opening (companyID=47, 平*)
# ---------------------------------------------------------------------------

_ROW_RE = re.compile(
    r"<tr[^>]*id=[\"']tr_47[\"'][^>]*>(?P<row>.*?)</tr>",
    re.S | re.I,
)
_TD_RE = re.compile(r"<td[^>]*>(?P<inner>.*?)</td>", re.S | re.I)
_TITLE_TS_RE = re.compile(r'title="(20\d{2}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?)"')
_GOALS_RE = re.compile(r'goals=["\']?(-?\d+(?:\.\d+)?)["\']?')

def _strip(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text).strip()

def parse_pinnacle_ah(html: str) -> dict:
    """Return {'open_home', 'open_away', 'open_line', 'open_ts'} or {}."""
    m = _ROW_RE.search(html)
    if not m:
        return {}
    row = m.group("row")
    tds = _TD_RE.findall(row)
    if len(tds) < 8:
        return {}
    # Skeleton for AsianOdds page (id=tr_47 for 平*):
    # [0]公司  [1]init_home  [2]init_line  [3]init_away
    # [4]hidden last  [5]current_home  [6]current_line  [7]current_away
    open_home = _strip(tds[1])
    open_away = _strip(tds[3])
    open_line = _GOALS_RE.search(tds[2])
    open_ts   = _TITLE_TS_RE.search(tds[1]) or _TITLE_TS_RE.search(tds[2]) or _TITLE_TS_RE.search(tds[3])
    if not (open_home and open_away and open_line):
        return {}
    return {
        "open_home_price": _as_float(open_home),
        "open_away_price": _as_float(open_away),
        "open_line":       _as_float(open_line.group(1)),
        "open_ts":         open_ts.group(1) if open_ts else None,
    }

def parse_pinnacle_ou(html: str) -> dict:
    m = _ROW_RE.search(html)
    if not m:
        return {}
    row = m.group("row")
    tds = _TD_RE.findall(row)
    if len(tds) < 8:
        return {}
    open_over  = _strip(tds[1])
    open_under = _strip(tds[3])
    open_line  = _GOALS_RE.search(tds[2])
    open_ts    = _TITLE_TS_RE.search(tds[1]) or _TITLE_TS_RE.search(tds[2]) or _TITLE_TS_RE.search(tds[3])
    if not (open_over and open_under and open_line):
        return {}
    return {
        "open_over_price":  _as_float(open_over),
        "open_under_price": _as_float(open_under),
        "open_line":        _as_float(open_line.group(1)),
        "open_ts":          open_ts.group(1) if open_ts else None,
    }

def _as_float(s) -> Optional[float]:
    try:
        return float(str(s).strip())
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Corners result — detail page teamTechDiv
# ---------------------------------------------------------------------------

class _TechParser(HTMLParser):
    """Extracts labelled stats and the header score bar from titan007 detail."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_tech = False
        self.tech_depth = 0
        self.rows: list[dict] = []
        self._cur_row: list[dict] = []
        self._cur_span: Optional[str] = None
        self._span_class: Optional[str] = None
        self._span_depth = 0
        # score bar
        self.home_name = None
        self.away_name = None
        self.home_score = None
        self.away_score = None
        self.half_home = None
        self.half_away = None
        self._in_home = False
        self._in_away = False
        self._in_score = False
        self._score_class = None

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        cls = d.get("class", "")
        if tag == "div" and d.get("id") == "teamTechDiv":
            self.in_tech = True
            self.tech_depth = 1
            return
        if self.in_tech:
            if tag == "div":
                self.tech_depth += 1
            if tag == "li":
                self._cur_row = []
            if tag == "span":
                self._cur_span = ""
                self._span_class = cls
                self._span_depth = 1
        if tag == "span":
            if "home" in cls and "name" in cls:
                self._in_home = True
            elif "guest" in cls and "name" in cls:
                self._in_away = True
            elif cls in ("score", "homeScore", "guestScore") or "score" in cls.lower():
                self._in_score = True
                self._score_class = cls

    def handle_endtag(self, tag):
        if self.in_tech:
            if tag == "span" and self._cur_span is not None:
                self._span_depth -= 1
                if self._span_depth <= 0:
                    txt = re.sub(r"\s+", "", self._cur_span or "")
                    self._cur_row.append({"class": self._span_class or "", "text": txt})
                    self._cur_span = None
                    self._span_class = None
            if tag == "li" and self._cur_row:
                self.rows.append({"cells": self._cur_row})
                self._cur_row = []
            if tag == "div":
                self.tech_depth -= 1
                if self.tech_depth <= 0:
                    self.in_tech = False
        if tag == "span":
            self._in_home = self._in_away = self._in_score = False
            self._score_class = None

    def handle_data(self, data):
        if self.in_tech and self._cur_span is not None:
            self._cur_span += data
        if self._in_home and self.home_name is None:
            self.home_name = data.strip() or None
        if self._in_away and self.away_name is None:
            self.away_name = data.strip() or None


# Only-anchored fallback: pull half + full score bars from raw HTML strings.
_SCORE_RE = re.compile(
    r'<span class="?homeName"?[^>]*>(?P<home>[^<]+)</span>.*?'
    r'<span class="?score"?[^>]*>(?P<hs>\d+)-(?P<as_>\d+)</span>.*?'
    r'<span class="?guestName"?[^>]*>(?P<away>[^<]+)</span>',
    re.S | re.I,
)
_HALF_RE = re.compile(r"半场[^0-9]{0,20}(\d+)\D+(\d+)", re.S)


def parse_corners_result(html: str) -> dict:
    """Extract corners + half + full score from detail page."""
    p = _TechParser()
    try:
        p.feed(html)
    except Exception:
        pass

    out: dict = {}

    # Full-time and half-time score
    m = _SCORE_RE.search(html)
    if m:
        out["home_team_titan"] = m.group("home").strip()
        out["away_team_titan"] = m.group("away").strip()
        out["home_score"] = int(m.group("hs"))
        out["away_score"] = int(m.group("as_"))
    h = _HALF_RE.search(html)
    if h:
        out["half_home"] = int(h.group(1))
        out["half_away"] = int(h.group(2))

    # Labeled tech rows -> pick 角球 & 半场角球
    for row in p.rows:
        cells = row["cells"]
        if len(cells) < 3:
            continue
        label = next((c["text"] for c in cells if "label" in c["class"].lower() or (not any(k in c["class"] for k in ("red", "guest", "home", "score")))), "")
        # simpler: middle cell is usually the label
        mid = cells[1]["text"] if len(cells) >= 3 else ""
        label = mid or label
        if not label:
            continue
        home_val = _as_int(cells[0]["text"])
        away_val = _as_int(cells[-1]["text"])
        if home_val is None or away_val is None:
            continue
        if label == "角球":
            out["corners_home"] = home_val
            out["corners_away"] = away_val
            out["corners_total"] = home_val + away_val
        elif label == "半场角球":
            out["half_corners_home"] = home_val
            out["half_corners_away"] = away_val

    return out


def _as_int(s) -> Optional[int]:
    try:
        return int(str(s).strip())
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# High-level fetch helpers
# ---------------------------------------------------------------------------

def fetch_pinnacle_ah(event_id: str) -> dict:
    url = f"https://vip.titan007.com/AsianOdds_n.aspx?id={event_id}&l=0"
    html = _fetch(url)
    out = parse_pinnacle_ah(html)
    out["_source_url"] = url
    out["_fetched_at"] = int(time.time() * 1000)
    return out


def fetch_pinnacle_ou(event_id: str) -> dict:
    url = f"https://vip.titan007.com/OverDown_n.aspx?id={event_id}&l=0"
    html = _fetch(url)
    out = parse_pinnacle_ou(html)
    out["_source_url"] = url
    out["_fetched_at"] = int(time.time() * 1000)
    return out


def fetch_result(event_id: str) -> dict:
    url = f"https://live.titan007.com/detail/{event_id}cn.htm"
    html = _fetch(url)
    out = parse_corners_result(html)
    out["_source_url"] = url
    out["_fetched_at"] = int(time.time() * 1000)
    return out


# ---------------------------------------------------------------------------
# Daily schedule → (home, away, kickoff_hkt) → event_id
# ---------------------------------------------------------------------------

_SCHEDULE_URL = "https://live.titan007.com/vbsxml/bfdata_{yyyymmdd}.js"
# titan007 daily schedule format:
#  A[N]=[matchid, ...] ; A[N]=... — historically JSON-ish
# Public list page: /vbsxml/bfdata_20260829.js contains rows like:
#   "3019112","2026-08-29","19:00","德乙","科特布斯","菲爾特",...

def fetch_daily_schedule(yyyymmdd: str) -> list[dict]:
    url = _SCHEDULE_URL.format(yyyymmdd=yyyymmdd)
    text = _fetch(url, referer="https://live.titan007.com/")
    events: list[dict] = []
    # extract inline arrays like: A[123]=[<comma-separated quoted fields>];
    for m in re.finditer(r"A\[\d+\]=\[(.+?)\];", text):
        raw = m.group(1)
        # split on commas outside of quotes; fields are quoted strings & numbers
        parts = re.findall(r'"([^"]*)"|([-\d.]+)', raw)
        vals = [p[0] if p[0] else p[1] for p in parts]
        # Expected shape (empirical): [eventId, "yyyy-mm-dd", "hh:mm", league, home, away, ...]
        if len(vals) >= 6 and re.match(r"^\d+$", vals[0]) and re.match(r"^\d{4}-\d{2}-\d{2}$", vals[1]):
            events.append({
                "event_id": vals[0],
                "date": vals[1],
                "time_hkt": vals[2],
                "league": vals[3],
                "home": vals[4],
                "away": vals[5],
            })
    return events
