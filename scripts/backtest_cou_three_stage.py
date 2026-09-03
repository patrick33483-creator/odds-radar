#!/usr/bin/env python3
"""Backtest full-match corner OU snapshots exported from production."""

from __future__ import annotations

import argparse
import json
import math
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


STAGES = {
    "hkjc": ("initial", "T30", "T5"),
    "pinnacle": ("T30", "T5"),
}


def parse_dt(value: str | int | float) -> datetime:
    if isinstance(value, (int, float)):
        timestamp = float(value)
        if timestamp > 10_000_000_000:
            timestamp /= 1000
        return datetime.fromtimestamp(timestamp)
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def split_line(line: float) -> list[float]:
    quarter = round((line - math.floor(line)) * 100)
    if quarter == 25:
        return [math.floor(line), math.floor(line) + 0.5]
    if quarter == 75:
        return [math.floor(line) + 0.5, math.floor(line) + 1.0]
    return [line]


def settle(selection: str, line: float, total: int, odds: float) -> tuple[float, str]:
    legs = []
    for leg_line in split_line(line):
        if total == leg_line:
            legs.append("push")
        elif (selection == "O" and total > leg_line) or (
            selection == "U" and total < leg_line
        ):
            legs.append("win")
        else:
            legs.append("loss")

    weight = 1 / len(legs)
    profit = sum(
        weight * ((odds - 1) if outcome == "win" else 0 if outcome == "push" else -1)
        for outcome in legs
    )
    unique = set(legs)
    if unique == {"win"}:
        label = "full_win"
    elif unique == {"win", "push"}:
        label = "half_win"
    elif unique == {"push"}:
        label = "push"
    elif unique == {"loss", "push"}:
        label = "half_loss"
    else:
        label = "full_loss"
    return profit, label


def equivalent_score(outcome: str) -> float:
    return {
        "full_win": 1.0,
        "half_win": 0.75,
        "push": 0.5,
        "half_loss": 0.25,
        "full_loss": 0.0,
    }[outcome]


def water_bucket(gap: float) -> str:
    if gap <= 0:
        return "冇收水/升水"
    if gap < 0.05:
        return "收水<0.05"
    if gap <= 0.10:
        return "收水0.05-0.10"
    if gap <= 0.20:
        return "收水0.10-0.20"
    return "收水>0.20"


def aggregate(records: list[dict]) -> list[dict]:
    grouped: dict[tuple, list[dict]] = defaultdict(list)
    for row in records:
        key = (
            row["provider"],
            row["window"],
            row["path"],
            row["bucket"],
            row["mode"],
            row["buy"],
        )
        grouped[key].append(row)

    output = []
    for key, rows in grouped.items():
        provider, window, path, bucket, mode, buy = key
        outcomes = Counter(r["outcome"] for r in rows)
        n = len(rows)
        avg_odds = sum(r["odds"] for r in rows) / n
        roi = sum(r["profit"] for r in rows) / n
        eq_rate = sum(equivalent_score(r["outcome"]) for r in rows) / n
        implied = sum(1 / r["odds"] for r in rows) / n
        output.append(
            {
                "provider": provider,
                "window": window,
                "path": path,
                "bucket": bucket,
                "mode": mode,
                "buy": buy,
                "n": n,
                "avg_odds": avg_odds,
                "roi": roi,
                "equivalent_rate": eq_rate,
                "implied": implied,
                "edge_pp": (eq_rate - implied) * 100,
                "outcomes": dict(outcomes),
            }
        )
    return output


def load_records(path: Path) -> tuple[list[dict], dict]:
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    for row in rows:
        row["match_id"] = row.get("fixture_key") or row["match_id"]
    grouped: dict[tuple, dict] = defaultdict(lambda: defaultdict(dict))
    matches_with_result = set()
    for row in rows:
        if row.get("corners_total") is not None:
            matches_with_result.add(row["match_id"])
        provider = str(row["provider"]).lower()
        if provider not in STAGES:
            continue
        key = (row["match_id"], provider, str(row["line_key"]))
        grouped[key][row["stage"]][row["selection"]] = row

    exclusions = Counter()
    observations = []
    eligible_by_provider = Counter()
    for (match_id, provider, line_key), stage_rows in grouped.items():
        required = STAGES[provider]
        if any(stage not in stage_rows for stage in required):
            exclusions[f"{provider}:缺階段"] += 1
            continue
        if any(not {"O", "U"}.issubset(stage_rows[stage]) for stage in required):
            exclusions[f"{provider}:缺大細兩邊"] += 1
            continue
        t5 = stage_rows["T5"]
        if not any(int(t5[side].get("is_main") or 0) == 1 for side in ("O", "U")):
            exclusions[f"{provider}:非T5主線"] += 1
            continue
        if t5["O"].get("corners_total") is None:
            exclusions[f"{provider}:未有賽果"] += 1
            continue

        selected = {}
        tied = False
        for stage in required:
            over = float(stage_rows[stage]["O"]["decimal_odds"])
            under = float(stage_rows[stage]["U"]["decimal_odds"])
            if abs(over - under) < 1e-9:
                tied = True
                break
            selected[stage] = "O" if over < under else "U"
        if tied:
            exclusions[f"{provider}:方向平手"] += 1
            continue

        if any(
            float(stage_rows[stage][selected[stage]]["decimal_odds"]) <= 1.70
            for stage in required
        ):
            exclusions[f"{provider}:低水≤1.70"] += 1
            continue

        path_label = "→".join("大" if selected[s] == "O" else "小" for s in required)
        final_side = selected["T5"]
        other_side = "U" if final_side == "O" else "O"
        start_stage = required[0]
        start_odds = float(stage_rows[start_stage][final_side]["decimal_odds"])
        final_odds = float(t5[final_side]["decimal_odds"])
        gap = start_odds - final_odds
        line = float(line_key)
        total = int(t5["O"]["corners_total"])
        kickoff = t5["O"].get("kickoff") or t5["O"]["kickoff_utc"]
        common = {
            "match_id": match_id,
            "provider": provider,
            "window": f"{start_stage}→T5",
            "path": path_label,
            "bucket": water_bucket(gap),
            "kickoff": kickoff,
            "line": line,
            "total": total,
        }
        for mode, buy in (("順向", final_side), ("反向", other_side)):
            odds = float(t5[buy]["decimal_odds"])
            profit, outcome = settle(buy, line, total, odds)
            observations.append(
                {
                    **common,
                    "mode": mode,
                    "buy": "大" if buy == "O" else "小",
                    "odds": odds,
                    "profit": profit,
                    "outcome": outcome,
                }
            )
        eligible_by_provider[provider] += 1

    coverage = {
        "raw_rows": len(rows),
        "raw_matches": len({r["match_id"] for r in rows}),
        "matches_with_result": len(matches_with_result),
        "eligible_by_provider": dict(eligible_by_provider),
        "exclusions": dict(exclusions),
    }
    return observations, coverage


def holdout(groups: list[dict], records: list[dict], min_train: int = 8, min_test: int = 4):
    match_dates = {}
    for row in records:
        match_dates[row["match_id"]] = parse_dt(row["kickoff"])
    ordered = sorted(match_dates, key=match_dates.get)
    if not ordered:
        return None, []
    cutoff_match = ordered[max(0, math.ceil(len(ordered) * 0.7) - 1)]
    cutoff = match_dates[cutoff_match]
    train = aggregate([r for r in records if parse_dt(r["kickoff"]) <= cutoff])
    test = aggregate([r for r in records if parse_dt(r["kickoff"]) > cutoff])
    key_fields = ("provider", "window", "path", "bucket", "mode", "buy")
    train_map = {tuple(g[f] for f in key_fields): g for g in train}
    test_map = {tuple(g[f] for f in key_fields): g for g in test}
    repeated = []
    for key, tr in train_map.items():
        te = test_map.get(key)
        if (
            te
            and tr["n"] >= min_train
            and te["n"] >= min_test
            and tr["roi"] > 0
            and te["roi"] > 0
        ):
            repeated.append({"train": tr, "test": te})
    repeated.sort(key=lambda x: (x["test"]["roi"], x["test"]["n"]), reverse=True)
    return cutoff.isoformat(), repeated


def pct(value: float) -> str:
    return f"{value * 100:+.1f}%"


def group_label(g: dict) -> str:
    return (
        f'{g["provider"].upper()}｜{g["path"]}｜{g["bucket"]}｜'
        f'{g["mode"]}買{g["buy"]}'
    )


def markdown_report(coverage: dict, groups: list[dict], cutoff: str | None, repeated: list):
    eligible = [g for g in groups if g["n"] >= 8]
    top = sorted(eligible, key=lambda g: (g["roi"], g["n"]), reverse=True)[:15]
    bottom = sorted(eligible, key=lambda g: (g["roi"], -g["n"]))[:10]
    lines = [
        "# 角球大細盤三階段回測",
        "",
        "## 資料覆蓋",
        "",
        f'- 原始快照：{coverage["raw_rows"]:,} 行，{coverage["raw_matches"]:,} 場',
        f'- 已有角球賽果：{coverage["matches_with_result"]:,} 場',
        (
            "- 合資格獨立主線樣本："
            + "；".join(
                f"{key.upper()} {value} 場"
                for key, value in sorted(coverage["eligible_by_provider"].items())
            )
        ),
        "- HKJC 計 initial→T30→T5；Pinnacle 因欠可靠初盤，只計 T30→T5。",
        "- 每個 provider／場次只取 T5 主線及完全相同線位，並要求各階段低水邊賠率 > 1.70。",
        "",
        "## 全樣本較佳組合（探索用途，n≥8）",
        "",
        "| 條件 | n | 平均賠率 | ROI | 等值命中率 | 高過隱含 |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    if top:
        for g in top:
            lines.append(
                f'| {group_label(g)} | {g["n"]} | {g["avg_odds"]:.3f} | '
                f'{pct(g["roi"])} | {g["equivalent_rate"]*100:.1f}% | '
                f'{g["edge_pp"]:+.1f}點 |'
            )
    else:
        lines.append("| 沒有組合達到最低樣本 | - | - | - | - | - |")

    lines += [
        "",
        "## 全樣本最差組合（可研究反向，n≥8）",
        "",
        "| 條件 | n | 平均賠率 | ROI | 等值命中率 | 高過隱含 |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    if bottom:
        for g in bottom:
            lines.append(
                f'| {group_label(g)} | {g["n"]} | {g["avg_odds"]:.3f} | '
                f'{pct(g["roi"])} | {g["equivalent_rate"]*100:.1f}% | '
                f'{g["edge_pp"]:+.1f}點 |'
            )
    else:
        lines.append("| 沒有組合達到最低樣本 | - | - | - | - | - |")

    lines += [
        "",
        "## 時序 70/30 重複為正",
        "",
        f"- 切割時間：{cutoff or 'n.a.'}",
        "- 下列只列訓練段 n≥8、後段 n≥4，而且兩段 ROI 同為正的組合。",
        "",
        "| 條件 | 前70% n / ROI | 後30% n / ROI | 後段高過隱含 |",
        "|---|---:|---:|---:|",
    ]
    if repeated:
        for pair in repeated[:15]:
            tr, te = pair["train"], pair["test"]
            lines.append(
                f'| {group_label(tr)} | {tr["n"]} / {pct(tr["roi"])} | '
                f'{te["n"]} / {pct(te["roi"])} | {te["edge_pp"]:+.1f}點 |'
            )
    else:
        lines.append("| 沒有條件同時達標 | - | - | - |")

    lines += [
        "",
        "## 解讀限制",
        "",
        "- ROI 已按亞洲角球盤的全贏、半贏、走盤、半輸、全輸及實際賠率結算。",
        "- 「等值命中率」只用作與隱含機率比較：全贏=1、半贏=.75、走盤=.5、半輸=.25、全輸=0；最終判斷應以 ROI 為主。",
        "- 以上仍屬同一歷史庫內探索及時序切割，不等於真正場外驗證；未通過後段的高 ROI 組合不應直接變成 TG 買入訊號。",
        "",
        "## 排除統計",
        "",
    ]
    for key, value in sorted(coverage["exclusions"].items()):
        lines.append(f"- {key}：{value}")
    return "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--markdown-output", type=Path)
    parser.add_argument("--json-output", type=Path)
    args = parser.parse_args()

    records, coverage = load_records(args.input)
    groups = aggregate(records)
    cutoff, repeated = holdout(groups, records)
    report = markdown_report(coverage, groups, cutoff, repeated)
    payload = {
        "coverage": coverage,
        "groups": groups,
        "holdout_cutoff": cutoff,
        "repeated_positive": repeated,
    }
    if args.markdown_output:
        args.markdown_output.write_text(report)
    if args.json_output:
        args.json_output.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(report)


if __name__ == "__main__":
    main()
