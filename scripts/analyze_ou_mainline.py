#!/usr/bin/env python3
"""Analyze OU (goals total) main-line snapshots exported from production.

Looks at:
  1. How the main line value (median) moves across initial -> T30 -> T5,
     per provider.
  2. How the main-line odds (median, O and U separately) move across the
     same stages.
  3. HKJC vs Pinnacle main-line value difference, paired match-by-match at
     the same stage.
  4. HKJC vs Pinnacle main-line odds difference for the same side (O/O,
     U/U), paired match-by-match at the same stage.
  5. Whether the line/odds gap between the two books says anything about
     the eventual over/under result.
"""

from __future__ import annotations

import argparse
import json
import statistics
from collections import defaultdict
from pathlib import Path

STAGES = ("initial", "T30", "T5")


def median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def load(path: Path):
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    # key: (match_id, provider, stage) -> {"O": row, "U": row}, only is_main rows
    by_stage: dict[tuple, dict[str, dict]] = defaultdict(dict)
    match_info = {}
    for row in rows:
        match_info[row["match_id"]] = row
        if int(row.get("is_main") or 0) != 1:
            continue
        if row["stage"] not in STAGES:
            continue
        key = (row["match_id"], row["provider"], row["stage"])
        by_stage[key][row["selection"]] = row
    return rows, by_stage, match_info


def line_and_mid_odds(pair: dict) -> tuple[float, float, float] | None:
    o = pair.get("O")
    u = pair.get("U")
    if not o or not u:
        return None
    return float(o["line_key"]), float(o["decimal_odds"]), float(u["decimal_odds"])


def trend_section(by_stage: dict) -> list[str]:
    lines = ["## 主線盤口同賠率隨階段變化（中位數）", "", "| 供應商 | 階段 | 場數 | 主線中位數 | 大賠率中位數 | 小賠率中位數 |", "|---|---|---:|---:|---:|---:|"]
    for provider in ("hkjc", "pinnacle"):
        for stage in STAGES:
            group = [
                line_and_mid_odds(pair)
                for (mid, prov, st), pair in by_stage.items()
                if prov == provider and st == stage
            ]
            group = [g for g in group if g]
            if not group:
                continue
            lines_v = [g[0] for g in group]
            over_v = [g[1] for g in group]
            under_v = [g[2] for g in group]
            label = "馬會" if provider == "hkjc" else "皇冠"
            lines.append(
                f"| {label} | {stage} | {len(group)} | {median(lines_v):.2f} | "
                f"{median(over_v):.3f} | {median(under_v):.3f} |"
            )
    lines.append("")
    return lines


def paired_diff_section(by_stage: dict) -> tuple[list[str], list[dict]]:
    lines = ["## 馬會 vs 皇冠：同場同階段主線差異", "", "| 階段 | 配對場數 | 主線差中位數(馬會-皇冠) | 大賠率差中位數 | 小賠率差中位數 |", "|---|---:|---:|---:|---:|"]
    records = []
    for stage in STAGES:
        line_diffs = []
        over_diffs = []
        under_diffs = []
        for (mid, prov, st) in list(by_stage):
            if prov != "hkjc" or st != stage:
                continue
            hk = line_and_mid_odds(by_stage[(mid, "hkjc", stage)])
            pn_key = (mid, "pinnacle", stage)
            if pn_key not in by_stage:
                continue
            pn = line_and_mid_odds(by_stage[pn_key])
            if not hk or not pn:
                continue
            line_diffs.append(hk[0] - pn[0])
            over_diffs.append(hk[1] - pn[1])
            under_diffs.append(hk[2] - pn[2])
            records.append(
                {
                    "match_id": mid,
                    "stage": stage,
                    "hkjc_line": hk[0],
                    "pinnacle_line": pn[0],
                    "line_diff": hk[0] - pn[0],
                    "hkjc_over": hk[1],
                    "pinnacle_over": pn[1],
                    "over_diff": hk[1] - pn[1],
                    "hkjc_under": hk[2],
                    "pinnacle_under": pn[2],
                    "under_diff": hk[2] - pn[2],
                }
            )
        if line_diffs:
            lines.append(
                f"| {stage} | {len(line_diffs)} | {median(line_diffs):+.3f} | "
                f"{median(over_diffs):+.3f} | {median(under_diffs):+.3f} |"
            )
    lines.append("")
    return lines, records


def bucket_line_diff(diff: float) -> str:
    if diff >= 0.25:
        return "馬會主線高≥0.25"
    if diff > 0:
        return "馬會主線略高(0,0.25)"
    if diff == 0:
        return "主線相同"
    if diff > -0.25:
        return "馬會主線略低(-0.25,0)"
    return "馬會主線低≥0.25"


def result_side(row: dict, line: float) -> str | None:
    if row.get("home_score") is None or row.get("away_score") is None:
        return None
    total = row["home_score"] + row["away_score"]
    if total > line:
        return "O"
    if total < line:
        return "U"
    return "push"


def insight_section(records: list[dict], match_info: dict) -> list[str]:
    t5 = [r for r in records if r["stage"] == "T5"]
    if not t5:
        return ["## 主線差異與賽果關係", "", "T5 沒有足夠配對樣本。", ""]
    lines = [
        "## 主線差異與賽果關係（T5，以皇冠主線同賽果結算）",
        "",
        "| 主線差異區間 | 場數 | 大 | 小 | 走盤 | 大命中率 |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    buckets = defaultdict(list)
    for r in t5:
        info = match_info.get(r["match_id"])
        if not info:
            continue
        outcome = result_side(info, r["pinnacle_line"])
        if outcome is None:
            continue
        buckets[bucket_line_diff(r["line_diff"])].append(outcome)
    order = [
        "馬會主線高≥0.25",
        "馬會主線略高(0,0.25)",
        "主線相同",
        "馬會主線略低(-0.25,0)",
        "馬會主線低≥0.25",
    ]
    for key in order:
        outcomes = buckets.get(key, [])
        if not outcomes:
            continue
        n = len(outcomes)
        o_n = outcomes.count("O")
        u_n = outcomes.count("U")
        p_n = outcomes.count("push")
        decided = o_n + u_n
        rate = f"{o_n/decided*100:.1f}%" if decided else "n.a."
        lines.append(f"| {key} | {n} | {o_n} | {u_n} | {p_n} | {rate} |")
    lines.append("")
    lines.append(
        "- 樣本量普遍偏細，屬探索性觀察，不代表已驗證的可執行訊號。"
    )
    lines.append("")
    return lines


def odds_gap_insight(records: list[dict], match_info: dict) -> list[str]:
    t5 = [r for r in records if r["stage"] == "T5"]
    lines = [
        "## 賠率差異與賽果關係（T5，皇冠大賠率 − 馬會大賠率）",
        "",
        "- 正數：皇冠大球賠率比馬會高（皇冠對大球開價更保守／馬會更看好大球）。",
        "- 負數：皇冠大球賠率比馬會低。",
        "",
        "| 賠率差區間 | 場數 | 大 | 小 | 走盤 | 大命中率 |",
        "|---|---:|---:|---:|---:|---:|",
    ]

    def bucket_odds(diff: float) -> str:
        if diff >= 0.05:
            return "皇冠大賠率高≥0.05"
        if diff > 0:
            return "皇冠大賠率略高(0,0.05)"
        if diff == 0:
            return "賠率相同"
        if diff > -0.05:
            return "皇冠大賠率略低(-0.05,0)"
        return "皇冠大賠率低≥0.05"

    buckets = defaultdict(list)
    for r in t5:
        info = match_info.get(r["match_id"])
        if not info:
            continue
        outcome = result_side(info, r["pinnacle_line"])
        if outcome is None:
            continue
        odds_diff = r["pinnacle_over"] - r["hkjc_over"]
        buckets[bucket_odds(odds_diff)].append(outcome)
    order = [
        "皇冠大賠率高≥0.05",
        "皇冠大賠率略高(0,0.05)",
        "賠率相同",
        "皇冠大賠率略低(-0.05,0)",
        "皇冠大賠率低≥0.05",
    ]
    for key in order:
        outcomes = buckets.get(key, [])
        if not outcomes:
            continue
        n = len(outcomes)
        o_n = outcomes.count("O")
        u_n = outcomes.count("U")
        p_n = outcomes.count("push")
        decided = o_n + u_n
        rate = f"{o_n/decided*100:.1f}%" if decided else "n.a."
        lines.append(f"| {key} | {n} | {o_n} | {u_n} | {p_n} | {rate} |")
    lines.append("")
    return lines


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--markdown-output", type=Path)
    args = parser.parse_args()

    rows, by_stage, match_info = load(args.input)
    report = ["# 入球大細主線：馬會 vs 皇冠 分析", ""]
    report.append(f"- 原始快照：{len(rows):,} 行，{len({r['match_id'] for r in rows}):,} 場")
    report.append("")
    report += trend_section(by_stage)
    diff_lines, records = paired_diff_section(by_stage)
    report += diff_lines
    report += insight_section(records, match_info)
    report += odds_gap_insight(records, match_info)

    text = "\n".join(report) + "\n"
    if args.markdown_output:
        args.markdown_output.write_text(text)
    print(text)


if __name__ == "__main__":
    main()
