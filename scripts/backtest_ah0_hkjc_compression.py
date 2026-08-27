#!/usr/bin/env python3
"""Backtest zero-handicap HKJC price compression against Pinnacle.

Primary condition:
  same fixture/stage/line/side, AH line 0,
  Pinnacle decimal odds - HKJC decimal odds >= 0.10.

Both pre-registered actions are reported:
  follow: bet the compressed side at the executable HKJC price;
  fade:   bet the opposite side at the executable HKJC price.
"""
from __future__ import annotations

import argparse
import json
import math
import random
from collections import defaultdict
from pathlib import Path
from statistics import mean
from typing import Any


STAGES = ("initial", "T30", "T15", "T5")
PROVIDERS = ("hkjc", "pinnacle")
SELECTIONS = ("H", "A")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    return rows


def number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def integer(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def settle(selection: str, odds: float, home_score: int, away_score: int) -> tuple[str, float]:
    difference = home_score - away_score
    if difference == 0:
        return "push", 0.0
    won = difference > 0 if selection == "H" else difference < 0
    return ("win", odds - 1.0) if won else ("loss", -1.0)


def quote_time(row: dict[str, Any]) -> int | None:
    return integer(row.get("source_updated_at")) or integer(row.get("captured_at"))


def freshness(row: dict[str, Any]) -> int | None:
    captured = integer(row.get("captured_at"))
    source = integer(row.get("source_updated_at"))
    if captured is None or source is None:
        return None
    return abs(captured - source)


def build_events(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    grouped: dict[tuple[str, str, str], dict[tuple[str, str], dict[str, Any]]] = defaultdict(dict)
    diagnostics = defaultdict(int)
    for row in rows:
        line = number(row.get("line_key"))
        if line is None or abs(line) > 1e-9 or row.get("market") != "AH":
            diagnostics["non_zero_or_non_ah"] += 1
            continue
        stage = str(row.get("stage") or "")
        provider = str(row.get("provider") or "")
        selection = str(row.get("selection") or "")
        if stage not in STAGES or provider not in PROVIDERS or selection not in SELECTIONS:
            diagnostics["unsupported_identity"] += 1
            continue
        key = (str(row.get("match_id") or ""), stage, str(row.get("line_key") or "0"))
        identity = (provider, selection)
        if identity in grouped[key]:
            diagnostics["duplicate_quote_identity"] += 1
            existing = grouped[key][identity]
            new_captured = integer(row.get("captured_at")) or 0
            old_captured = integer(existing.get("captured_at")) or 0
            if new_captured <= old_captured:
                continue
        grouped[key][identity] = row

    events: list[dict[str, Any]] = []
    for (match_id, stage, line_key), quotes in grouped.items():
        if any((provider, side) not in quotes for provider in PROVIDERS for side in SELECTIONS):
            diagnostics["incomplete_four_quote_cell"] += 1
            continue
        exemplar = quotes[("hkjc", "H")]
        home_score = integer(exemplar.get("home_score"))
        away_score = integer(exemplar.get("away_score"))
        kickoff = integer(exemplar.get("kickoff_utc"))
        if home_score is None or away_score is None:
            diagnostics["missing_result"] += 1
            continue
        if kickoff is None or any((integer(row.get("captured_at")) or kickoff) >= kickoff for row in quotes.values()):
            diagnostics["post_kickoff_or_missing_time"] += 1
            continue
        odds = {
            provider: {
                side: number(quotes[(provider, side)].get("decimal_odds"))
                for side in SELECTIONS
            }
            for provider in PROVIDERS
        }
        if any(not odds[provider][side] or odds[provider][side] <= 1 for provider in PROVIDERS for side in SELECTIONS):
            diagnostics["invalid_odds"] += 1
            continue
        capture_times = [integer(row.get("captured_at")) for row in quotes.values()]
        source_times = [quote_time(row) for row in quotes.values()]
        source_ages = [freshness(row) for row in quotes.values()]
        capture_times = [value for value in capture_times if value is not None]
        source_times = [value for value in source_times if value is not None]
        strict_fresh = (
            len(source_ages) == 4
            and all(value is not None and value <= 90_000 for value in source_ages)
            and len(source_times) == 4
            and max(source_times) - min(source_times) <= 90_000
        )
        synchronized_capture = (
            len(capture_times) == 4 and max(capture_times) - min(capture_times) <= 90_000
        )
        events.append({
            "match_id": match_id,
            "stage": stage,
            "line_key": line_key,
            "kickoff_utc": kickoff,
            "league": exemplar.get("league"),
            "home_team": exemplar.get("home_team"),
            "away_team": exemplar.get("away_team"),
            "home_score": home_score,
            "away_score": away_score,
            "odds": odds,
            "strict_fresh": strict_fresh,
            "synchronized_capture": synchronized_capture,
            "max_source_age_seconds": (
                max(value for value in source_ages if value is not None) / 1000
                if any(value is not None for value in source_ages) else None
            ),
        })
    return events, dict(diagnostics)


def wilson(wins: int, decisions: int) -> list[float | None]:
    if decisions <= 0:
        return [None, None]
    z = 1.959963984540054
    p = wins / decisions
    denominator = 1 + z * z / decisions
    centre = p + z * z / (2 * decisions)
    spread = z * math.sqrt((p * (1 - p) + z * z / (4 * decisions)) / decisions)
    return [(centre - spread) / denominator, (centre + spread) / denominator]


def bootstrap_roi(returns: list[float], samples: int = 10_000) -> list[float | None]:
    if not returns:
        return [None, None]
    rng = random.Random(20260827)
    n = len(returns)
    values = sorted(sum(rng.choice(returns) for _ in range(n)) / n for _ in range(samples))
    return [values[int(samples * 0.025)], values[min(samples - 1, int(samples * 0.975))]]


def metrics(bets: list[dict[str, Any]]) -> dict[str, Any]:
    returns = [float(row["return"]) for row in bets]
    wins = sum(row["result"] == "win" for row in bets)
    pushes = sum(row["result"] == "push" for row in bets)
    losses = sum(row["result"] == "loss" for row in bets)
    decisions = wins + losses
    equity = drawdown = peak = 0.0
    for value in returns:
        equity += value
        peak = max(peak, equity)
        drawdown = max(drawdown, peak - equity)
    chronological = sorted(bets, key=lambda row: (row["kickoff_utc"], row["match_id"]))
    split = max(1, math.floor(len(chronological) * 0.7)) if chronological else 0
    holdout = chronological[split:] if len(chronological) >= 10 else []
    return {
        "bets": len(bets),
        "unique_fixtures": len({row["match_id"] for row in bets}),
        "wins": wins,
        "pushes": pushes,
        "losses": losses,
        "hit_rate_ex_push": wins / decisions if decisions else None,
        "hit_wilson_95": wilson(wins, decisions),
        "average_hkjc_odds": mean(row["odds"] for row in bets) if bets else None,
        "average_price_gap": mean(row["price_gap"] for row in bets) if bets else None,
        "average_pinnacle_no_vig_edge": mean(row["pinnacle_no_vig_edge"] for row in bets) if bets else None,
        "unit_pnl": sum(returns),
        "roi": sum(returns) / len(returns) if returns else None,
        "roi_bootstrap_95": bootstrap_roi(returns),
        "max_drawdown_units": drawdown,
        "chronological_holdout_30pct": {
            "bets": len(holdout),
            "unit_pnl": sum(row["return"] for row in holdout),
            "roi": (
                sum(row["return"] for row in holdout) / len(holdout)
                if holdout else None
            ),
        },
    }


def candidates(
    events: list[dict[str, Any]],
    *,
    stage: str,
    threshold: float,
    freshness_mode: str,
    action: str,
) -> list[dict[str, Any]]:
    bets: list[dict[str, Any]] = []
    for event in events:
        if event["stage"] != stage:
            continue
        if freshness_mode == "strict" and not event["strict_fresh"]:
            continue
        if freshness_mode == "capture_sync" and not event["synchronized_capture"]:
            continue
        gaps = {
            side: event["odds"]["pinnacle"][side] - event["odds"]["hkjc"][side]
            for side in SELECTIONS
        }
        eligible = [side for side in SELECTIONS if gaps[side] >= threshold - 1e-12]
        if not eligible:
            continue
        compressed = max(eligible, key=lambda side: (gaps[side], side))
        selection = compressed if action == "follow" else ("A" if compressed == "H" else "H")
        odds = event["odds"]["hkjc"][selection]
        pin_h = 1 / event["odds"]["pinnacle"]["H"]
        pin_a = 1 / event["odds"]["pinnacle"]["A"]
        fair_probability = (pin_h if selection == "H" else pin_a) / (pin_h + pin_a)
        result, unit_return = settle(
            selection, odds, event["home_score"], event["away_score"],
        )
        bets.append({
            "match_id": event["match_id"],
            "stage": stage,
            "kickoff_utc": event["kickoff_utc"],
            "compressed_side": compressed,
            "selection": selection,
            "odds": odds,
            "price_gap": gaps[compressed],
            "pinnacle_no_vig_edge": fair_probability * odds - 1,
            "result": result,
            "return": unit_return,
        })
    return bets


def build_report(rows: list[dict[str, Any]]) -> dict[str, Any]:
    events, diagnostics = build_events(rows)
    report: dict[str, Any] = {
        "definition": {
            "market": "AH",
            "line": 0,
            "primary_threshold": 0.10,
            "follow": "bet the side where Pinnacle odds - HKJC odds >= 0.10",
            "fade": "bet the opposite side at HKJC odds",
            "execution_odds": "HKJC snapshot odds",
            "strict_freshness": "all four source ages <=90s and source timestamps within 90s",
            "capture_sync": "all four captured_at timestamps within 90s",
            "settlement": "zero-handicap win/push/loss, one unit",
        },
        "coverage": {
            "raw_quote_rows": len(rows),
            "complete_result_events": len(events),
            "strict_fresh_events": sum(event["strict_fresh"] for event in events),
            "capture_synchronized_events": sum(event["synchronized_capture"] for event in events),
            "events_by_stage": {
                stage: sum(event["stage"] == stage for event in events) for stage in STAGES
            },
            "diagnostics": diagnostics,
        },
        "primary_results": {},
        "sensitivity": {},
    }
    for mode in ("strict", "capture_sync", "all_pre_kickoff"):
        report["primary_results"][mode] = {}
        for stage in STAGES:
            report["primary_results"][mode][stage] = {
                action: metrics(candidates(
                    events, stage=stage, threshold=0.10,
                    freshness_mode=mode, action=action,
                ))
                for action in ("follow", "fade")
            }
    for threshold in (0.05, 0.15):
        key = f"gap_{threshold:.2f}"
        report["sensitivity"][key] = {
            stage: {
                action: metrics(candidates(
                    events, stage=stage, threshold=threshold,
                    freshness_mode="capture_sync", action=action,
                ))
                for action in ("follow", "fade")
            }
            for stage in STAGES
        }
    return report


def fmt_pct(value: Any) -> str:
    return "—" if value is None else f"{float(value) * 100:+.2f}%"


def markdown(report: dict[str, Any]) -> str:
    coverage = report["coverage"]
    lines = [
        "# 0盤馬會壓價至少 0.10 回測",
        "",
        "主條件固定為同場、同時點、亞洲讓球 0 盤，Pinnacle 賠率減馬會賠率至少 0.10。",
        "同時測試跟隨壓價邊及反買對面；全部以實際馬會 snapshot 賠率結算。",
        "",
        "## 資料覆蓋",
        "",
        f"- 原始報價列：{coverage['raw_quote_rows']}",
        f"- 四格完整且有賽果事件：{coverage['complete_result_events']}",
        f"- 嚴格 90 秒新鮮事件：{coverage['strict_fresh_events']}",
        f"- 捕獲時間同步事件：{coverage['capture_synchronized_events']}",
        "",
        "## 主要結果：捕獲時間同步",
        "",
        "| 時點 | 策略 | 注數 | W-P-L | 平均賠率 | ROI | 95% bootstrap | 後30% ROI |",
        "|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for stage in STAGES:
        for action, label in (("follow", "跟壓價"), ("fade", "反買")):
            row = report["primary_results"]["capture_sync"][stage][action]
            interval = row["roi_bootstrap_95"]
            ci = "—" if interval[0] is None else f"{fmt_pct(interval[0])} 至 {fmt_pct(interval[1])}"
            average_odds = (
                "—"
                if row["average_hkjc_odds"] is None
                else f"{row['average_hkjc_odds']:.3f}"
            )
            lines.append(
                f"| {stage} | {label} | {row['bets']} | "
                f"{row['wins']}-{row['pushes']}-{row['losses']} | "
                f"{average_odds} | "
                f"{fmt_pct(row['roi'])} | {ci} | "
                f"{fmt_pct(row['chronological_holdout_30pct']['roi'])} |"
            )
    lines.extend([
        "",
        "## 判讀限制",
        "",
        "- 嚴格新鮮度樣本優先；capture-sync 只可視為敏感度分析。",
        "- 同一規則分四個時點及兩個方向，必須考慮多重比較。",
        "- 樣本少於 30 注不可升級為正式投注條件。",
    ])
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--json-output", type=Path, required=True)
    parser.add_argument("--markdown-output", type=Path, required=True)
    args = parser.parse_args()
    report = build_report(read_jsonl(args.input))
    args.json_output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    args.markdown_output.write_text(markdown(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
