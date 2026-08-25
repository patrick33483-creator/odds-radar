#!/usr/bin/env python3
"""Read-only exploratory edge study over the isolated Radar research tables."""

from __future__ import annotations

import json
import math
import sqlite3
import statistics
from collections import Counter, defaultdict
from pathlib import Path

DB_PATH = Path("/opt/odds-radar/data/data.db")
STAGE_ORDER = {"initial": 0, "T30": 1, "T15": 2, "T5": 3}
PAIR_SELECTIONS = {
    "AH": ("H", "A"),
    "OU": ("O", "U"),
    "COU": ("O", "U"),
}


def line_number(value: str) -> float:
    return float(value or 0)


def split_quarter(line: float) -> list[float]:
    doubled = line * 2
    if abs(doubled - round(doubled)) < 1e-9:
        return [line]
    low = math.floor(doubled) / 2
    high = math.ceil(doubled) / 2
    return [low, high]


def leg_profit(adjusted: float, odds: float) -> float:
    if adjusted > 1e-9:
        return odds - 1
    if adjusted < -1e-9:
        return -1.0
    return 0.0


def settle_profit(
    market: str,
    selection: str,
    line: float,
    odds: float,
    home_score: int,
    away_score: int,
    corners_total: int | None,
) -> float | None:
    profits: list[float] = []
    for component in split_quarter(line):
        if market == "AH":
            adjusted = home_score - away_score + component
            if selection == "A":
                adjusted = -adjusted
        else:
            total = home_score + away_score if market == "OU" else corners_total
            if total is None:
                return None
            adjusted = total - component
            if selection == "U":
                adjusted = -adjusted
        profits.append(leg_profit(adjusted, odds))
    return sum(profits) / len(profits)


def summarize(rows: list[dict]) -> dict:
    profits = [float(row["profit"]) for row in rows if row.get("profit") is not None]
    if not profits:
        return {"n": 0}
    n = len(profits)
    mean = statistics.fmean(profits)
    if n > 1:
        se = statistics.stdev(profits) / math.sqrt(n)
        low, high = mean - 1.96 * se, mean + 1.96 * se
    else:
        low = high = mean
    outcomes = Counter(
        "W" if value > 0.75
        else "HW" if value > 0
        else "P" if abs(value) < 1e-9
        else "HL" if value > -0.75
        else "L"
        for value in profits
    )
    result = {
        "n": n,
        "roi_pct": round(mean * 100, 2),
        "roi_95ci_pct": [round(low * 100, 2), round(high * 100, 2)],
        "positive_pct": round(sum(value > 0 for value in profits) / n * 100, 1),
        "avg_odds": round(statistics.fmean(float(row["odds"]) for row in rows), 3),
        "outcomes": dict(outcomes),
        "matches": len({row["match_id"] for row in rows}),
        "selections": dict(Counter(str(row["selection"]) for row in rows)),
        "days": len({
            int(row["kickoff_utc"]) // (24 * 60 * 60 * 1000)
            for row in rows
        }),
    }
    for field in ("edge", "raw_gap"):
        values = [float(row[field]) for row in rows if field in row]
        if values:
            result[f"avg_{field}_pct"] = round(statistics.fmean(values) * 100, 2)
    values = [
        float(row["line_advantage"])
        for row in rows
        if "line_advantage" in row
    ]
    if values:
        result["avg_line_advantage"] = round(statistics.fmean(values), 3)
    return result


db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
db.row_factory = sqlite3.Row

result_rows = db.execute(
    """
    SELECT m.id match_id,m.league,m.kickoff_utc,
           COALESCE(rr.home_score,r.home_score) home_score,
           COALESCE(rr.away_score,r.away_score) away_score,
           COALESCE(rr.corners_total,r.corners_total) corners_total
      FROM matches m
      LEFT JOIN research_results rr ON rr.match_id=m.id
      LEFT JOIN results r ON r.match_id=m.id
     WHERE COALESCE(rr.match_id,r.match_id) IS NOT NULL
    """
).fetchall()
results = {str(row["match_id"]): dict(row) for row in result_rows}

quote_rows = db.execute(
    """
    SELECT match_id,provider,market,stage,line_key,selection,decimal_odds,is_main
      FROM research_timeline_snapshots
     WHERE match_id IN (
       SELECT match_id FROM research_results
       UNION SELECT match_id FROM results
     )
       AND market IN ('AH','OU','COU')
       AND stage IN ('initial','T30','T15','T5')
     ORDER BY match_id,provider,market,stage,is_main DESC,line_key,selection
    """
).fetchall()

groups: dict[tuple, dict] = {}
for row in quote_rows:
    key = (
        str(row["match_id"]),
        str(row["provider"]),
        str(row["market"]),
        str(row["stage"]),
        str(row["line_key"]),
    )
    group = groups.setdefault(
        key,
        {
            "match_id": key[0],
            "provider": key[1],
            "market": key[2],
            "stage": key[3],
            "line_key": key[4],
            "line": line_number(key[4]),
            "is_main": 0,
            "odds": {},
        },
    )
    group["is_main"] = max(group["is_main"], int(row["is_main"] or 0))
    group["odds"][str(row["selection"])] = float(row["decimal_odds"])

complete_groups: dict[tuple, dict] = {}
by_context: dict[tuple, list[dict]] = defaultdict(list)
for key, group in groups.items():
    required = PAIR_SELECTIONS[group["market"]]
    if not all(selection in group["odds"] for selection in required):
        continue
    complete_groups[key] = group
    by_context[key[:4]].append(group)

main_groups: dict[tuple, dict] = {}
ambiguous_main = 0
for context, candidates in by_context.items():
    marked = [group for group in candidates if group["is_main"]]
    pool = marked or candidates
    if len(marked) > 1:
        ambiguous_main += 1
    pool.sort(key=lambda group: (group["is_main"], -abs(group["line"])), reverse=True)
    main_groups[context] = pool[0]


def add_result(row: dict, group: dict, selection: str, odds: float) -> dict | None:
    result = results.get(group["match_id"])
    if not result:
        return None
    profit = settle_profit(
        group["market"],
        selection,
        group["line"],
        odds,
        int(result["home_score"]),
        int(result["away_score"]),
        None if result["corners_total"] is None else int(result["corners_total"]),
    )
    if profit is None:
        return None
    return {
        **row,
        "match_id": group["match_id"],
        "market": group["market"],
        "stage": group["stage"],
        "selection": selection,
        "line": group["line"],
        "odds": odds,
        "profit": profit,
        "kickoff_utc": int(result["kickoff_utc"]),
        "league": str(result["league"]),
    }


edge_candidates: list[dict] = []
line_candidates: list[dict] = []
movement_candidates: list[dict] = []
consensus_candidates: list[dict] = []

for match_id in results:
    for market, selections in PAIR_SELECTIONS.items():
        for stage in STAGE_ORDER:
            h_group = main_groups.get((match_id, "hkjc", market, stage))
            p_main = main_groups.get((match_id, "pinnacle", market, stage))
            if h_group and p_main:
                line_delta = h_group["line"] - p_main["line"]
                if abs(line_delta) >= 0.249:
                    if market == "AH":
                        selection = "H" if line_delta > 0 else "A"
                    else:
                        selection = "U" if line_delta > 0 else "O"
                    row = add_result(
                        {
                            "signal": "main_line_advantage",
                            "line_advantage": abs(line_delta),
                            "price_floor_175": h_group["odds"][selection] >= 1.75,
                        },
                        h_group,
                        selection,
                        h_group["odds"][selection],
                    )
                    if row:
                        line_candidates.append(row)

            if not h_group:
                continue
            p_same = complete_groups.get(
                (match_id, "pinnacle", market, stage, h_group["line_key"])
            )
            if not p_same:
                continue
            raw_probs = {
                selection: 1 / p_same["odds"][selection] for selection in selections
            }
            overround = sum(raw_probs.values())
            choices = []
            for selection in selections:
                fair_probability = raw_probs[selection] / overround
                h_odds = h_group["odds"][selection]
                edge = fair_probability * h_odds - 1
                raw_gap = h_odds / p_same["odds"][selection] - 1
                choices.append((edge, raw_gap, selection, h_odds, fair_probability))
            edge, raw_gap, selection, h_odds, fair_probability = max(choices)
            row = add_result(
                {
                    "signal": "same_line_fair_edge",
                    "edge": edge,
                    "raw_gap": raw_gap,
                    "fair_probability": fair_probability,
                },
                h_group,
                selection,
                h_odds,
            )
            if row:
                edge_candidates.append(row)

        for from_stage, to_stage in (("T30", "T15"), ("T15", "T5")):
            p_from = main_groups.get((match_id, "pinnacle", market, from_stage))
            p_to = main_groups.get((match_id, "pinnacle", market, to_stage))
            h_to = main_groups.get((match_id, "hkjc", market, to_stage))
            if not p_from or not p_to or not h_to:
                continue
            line_change = p_to["line"] - p_from["line"]
            selection = None
            strength = 0.0
            movement_type = None
            if abs(line_change) >= 0.249:
                movement_type = "line"
                strength = abs(line_change)
                if market == "AH":
                    selection = "H" if line_change < 0 else "A"
                else:
                    selection = "O" if line_change > 0 else "U"
            elif p_from["line_key"] == p_to["line_key"]:
                from_raw = {
                    selection: 1 / p_from["odds"][selection] for selection in selections
                }
                to_raw = {
                    selection: 1 / p_to["odds"][selection] for selection in selections
                }
                from_total = sum(from_raw.values())
                to_total = sum(to_raw.values())
                changes = {
                    selection: to_raw[selection] / to_total
                    - from_raw[selection] / from_total
                    for selection in selections
                }
                selection, strength = max(changes.items(), key=lambda item: item[1])
                if strength < 0.01:
                    selection = None
                else:
                    movement_type = "probability"
            if not selection:
                continue
            row = add_result(
                {
                    "signal": "pinnacle_momentum",
                    "from_stage": from_stage,
                    "movement_type": movement_type,
                    "strength": strength,
                },
                h_to,
                selection,
                h_to["odds"][selection],
            )
            if row:
                movement_candidates.append(row)

# A T30 candidate is marked as cross-stage consensus when the same side keeps
# a non-negative raw HKJC/Pinnacle gap at one or both later checkpoints.
positive_gap_keys = {
    (row["match_id"], row["market"], row["stage"], row["selection"])
    for row in edge_candidates
    if row["raw_gap"] >= 0
}
for row in edge_candidates:
    if row["stage"] != "T30" or row["raw_gap"] < 0:
        continue
    later = sum(
        (row["match_id"], row["market"], stage, row["selection"])
        in positive_gap_keys
        for stage in ("T15", "T5")
    )
    if later:
        consensus_candidates.append({**row, "later_confirmations": later})


def segment(
    name: str,
    source: list[dict],
    predicate,
    extra: dict | None = None,
) -> dict:
    selected = [row for row in source if predicate(row)]
    result = {"name": name, **(extra or {}), **summarize(selected)}
    return result


segments: list[dict] = []
for market in PAIR_SELECTIONS:
    for stage in ("initial", "T30", "T15", "T5"):
        segments.append(
            segment(
                f"candidate_all_{market}_{stage}",
                edge_candidates,
                lambda row, m=market, s=stage:
                    row["market"] == m and row["stage"] == s,
                {"factor": "candidate_all", "market": market, "stage": stage},
            )
        )
        segments.append(
            segment(
                f"raw_gap_negative_{market}_{stage}",
                edge_candidates,
                lambda row, m=market, s=stage:
                    row["market"] == m and row["stage"] == s
                    and row["raw_gap"] < 0,
                {"factor": "raw_gap_negative", "market": market, "stage": stage},
            )
        )
        for threshold in (0.00, 0.02, 0.04, 0.06, 0.08):
            segments.append(
                segment(
                    f"fair_edge_{market}_{stage}_{int(threshold * 100)}pct",
                    edge_candidates,
                    lambda row, m=market, s=stage, t=threshold:
                        row["market"] == m and row["stage"] == s and row["edge"] >= t,
                    {"factor": "fair_edge", "market": market, "stage": stage,
                     "threshold": threshold},
                )
            )
        for threshold in (0.00, 0.03, 0.05, 0.08):
            segments.append(
                segment(
                    f"raw_gap_{market}_{stage}_{int(threshold * 100)}pct",
                    edge_candidates,
                    lambda row, m=market, s=stage, t=threshold:
                        row["market"] == m and row["stage"] == s and row["raw_gap"] >= t,
                    {"factor": "raw_gap", "market": market, "stage": stage,
                     "threshold": threshold},
                )
            )
        for threshold in (0.25, 0.50):
            segments.append(
                segment(
                    f"line_advantage_{market}_{stage}_{threshold}",
                    line_candidates,
                    lambda row, m=market, s=stage, t=threshold:
                        row["market"] == m and row["stage"] == s
                        and row["line_advantage"] >= t,
                    {"factor": "line_advantage", "market": market, "stage": stage,
                     "threshold": threshold},
                )
            )
            segments.append(
                segment(
                    f"line_advantage_price175_{market}_{stage}_{threshold}",
                    line_candidates,
                    lambda row, m=market, s=stage, t=threshold:
                        row["market"] == m and row["stage"] == s
                        and row["line_advantage"] >= t and row["price_floor_175"],
                    {"factor": "line_advantage_price175", "market": market,
                     "stage": stage, "threshold": threshold},
                )
            )

for market in PAIR_SELECTIONS:
    for from_stage, to_stage in (("T30", "T15"), ("T15", "T5")):
        for movement_type in ("line", "probability", "all"):
            segments.append(
                segment(
                    f"momentum_{market}_{from_stage}_{to_stage}_{movement_type}",
                    movement_candidates,
                    lambda row, m=market, f=from_stage, t=to_stage, mt=movement_type:
                        row["market"] == m and row["from_stage"] == f
                        and row["stage"] == t
                        and (mt == "all" or row["movement_type"] == mt),
                    {"factor": "pinnacle_momentum", "market": market,
                     "from_stage": from_stage, "stage": to_stage,
                     "movement_type": movement_type},
                )
            )

for market in PAIR_SELECTIONS:
    for minimum_confirmations in (1, 2):
        segments.append(
            segment(
                f"raw_gap_consensus_{market}_T30_{minimum_confirmations}",
                consensus_candidates,
                lambda row, m=market, c=minimum_confirmations:
                    row["market"] == m and row["later_confirmations"] >= c,
                {"factor": "raw_gap_consensus", "market": market,
                 "stage": "T30", "later_confirmations": minimum_confirmations},
            )
        )

# Confirmatory-looking candidates require at least 12 independent matches.
eligible = [row for row in segments if row.get("matches", 0) >= 12]
ranked = sorted(
    eligible,
    key=lambda row: (
        row["roi_95ci_pct"][0] > 0,
        row["roi_pct"],
        row["matches"],
    ),
    reverse=True,
)

report = {
    "method": {
        "database_mode": "read_only",
        "one_candidate_per_match_market_stage": True,
        "pinnacle_probabilities": "two-way normalized no-vig",
        "return_model": "Asian quarter-line settlement at HKJC decimal odds",
        "warning": "Exploratory multiple-testing scan; rankings are not out-of-sample proof.",
    },
    "diagnostics": {
        "settled_matches": len(results),
        "complete_quote_groups": len(complete_groups),
        "main_contexts": len(main_groups),
        "ambiguous_main_contexts": ambiguous_main,
        "edge_candidates": len(edge_candidates),
        "line_candidates": len(line_candidates),
        "movement_candidates": len(movement_candidates),
        "consensus_candidates": len(consensus_candidates),
        "settled_matches_with_corners": sum(
            row["corners_total"] is not None for row in results.values()
        ),
    },
    "top_segments_min_12_matches": ranked[:30],
    "all_segments": segments,
}
print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
db.close()
