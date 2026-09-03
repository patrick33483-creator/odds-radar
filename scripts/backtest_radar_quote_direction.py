#!/usr/bin/env python3
"""Read-only, checkpoint-faithful quote-direction research backtest.

The input is an exported JSONL slice of research_timeline_snapshots.  This
program does not open or mutate the production database.  Decisions are made
at T30 only; T5 is reported solely as a subsequent confirmation/reversal
diagnostic and is never used to select a T30 bet.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path
from statistics import mean
from typing import Any, Iterable


STAGES = ("initial", "T30", "T5")
SIDE = {"AH": ("H", "A"), "OU": ("O", "U")}
BOOTSTRAPS = 10_000
PERMUTATIONS = 5_000
EPS = 1e-9
POLICY_TEMPLATES = {
    "F1_league_water": 3,  # top 10%, 70-90%, middle control
    "F2_double_external_hkjc_lag": 3,  # 0.03, 0.05, 0.08
    "F3_line_odds_contradiction": 6,  # 3 odds rises × follow/fade
    "F4_AH_OU_script": 18,  # 3 AH states × 3 OU states × AH/OU execution
    "N1_no_initial_T30_price_lag": 3,  # T30 HKJC/Pinnacle gap 0.03, 0.05, 0.08
}


def num(value: Any) -> float | None:
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def integer(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def qkey(row: dict[str, Any]) -> tuple[int, int]:
    """Sort by source time first, then receipt time (both are audit fields)."""
    return (integer(row.get("source_updated_at")) or -1, integer(row.get("captured_at")) or -1)


def opposite(market: str, selection: str) -> str:
    return {"H": "A", "A": "H", "O": "U", "U": "O"}[selection]


def split_asian(line: float) -> list[float]:
    """Return one or two half-lines for standard .0/.25/.5/.75 Asian lines."""
    twice = round(line * 2)
    if abs(line * 2 - twice) < 1e-7:
        return [line]
    base = math.floor(line * 2) / 2
    return [base, base + 0.5]


def settle(market: str, line: float, selection: str, odds: float, home: int, away: int) -> tuple[str, float]:
    """Exact one-unit Asian settlement; profit is net of stake."""
    values: list[int] = []
    for half in split_asian(line):
        if market == "AH":
            adjusted = home + half - away
            d = adjusted if selection == "H" else -adjusted
        else:
            total = home + away
            d = total - half if selection == "O" else half - total
        values.append(1 if d > EPS else -1 if d < -EPS else 0)
    outcome = sum(values) / len(values)
    profit = outcome * (odds - 1) if outcome > 0 else outcome
    status = {1: "W", .5: "HW", 0: "P", -.5: "HL", -1: "L"}[outcome]
    return status, profit


def wilson_lower(wins_equiv: float, decisions: int) -> float | None:
    if decisions <= 0:
        return None
    z = 1.959963984540054
    p = wins_equiv / decisions
    denominator = 1 + z * z / decisions
    centre = p + z * z / (2 * decisions)
    spread = z * math.sqrt((p * (1 - p) + z * z / (4 * decisions)) / decisions)
    return (centre - spread) / denominator


def bootstrap_roi(returns: list[float], seed: int) -> list[float | None]:
    if not returns:
        return [None, None]
    rng = random.Random(seed)
    n = len(returns)
    values = sorted(sum(rng.choice(returns) for _ in range(n)) / n for _ in range(BOOTSTRAPS))
    return [values[int(BOOTSTRAPS * .025)], values[int(BOOTSTRAPS * .975)]]


def percentile(values: Iterable[float], value: float) -> float | None:
    values = sorted(values)
    if not values:
        return None
    # Mid-rank handles ties without inventing a favourable extreme percentile.
    less = sum(x < value - EPS for x in values)
    equal = sum(abs(x - value) <= EPS for x in values)
    return (less + .5 * equal) / len(values)


def kickoff_day(value: int) -> str:
    return datetime.fromtimestamp(value / 1000, UTC).date().isoformat()


def stable_seed(value: str) -> int:
    return int.from_bytes(hashlib.sha256(value.encode("utf-8")).digest()[:8], "big")


def stage_line(fixture: dict[str, Any], stage: str, provider: str, market: str) -> tuple[float, dict[str, float]] | None:
    """Use main line only; all selections must be complete and executable."""
    item = fixture["main"].get((stage, provider, market))
    if not item:
        return None
    line, prices = item
    if any(side not in prices or prices[side] <= 1 for side in SIDE[market]):
        return None
    return line, prices


def usable(fixture: dict[str, Any], stage: str, provider: str, market: str) -> bool:
    value = stage_line(fixture, stage, provider, market)
    return bool(value and fixture["captured"][(stage, provider, market)] < fixture["kickoff_utc"])


def main_provider(fixture: dict[str, Any]) -> str:
    return "crown" if fixture["cohort"] == "crown_only" else "hkjc"


def signal_provider(fixture: dict[str, Any]) -> str:
    """HKJC cohort uses the uniquely-derived Pinnacle begin-cap; Crown is native."""
    return "crown" if fixture["cohort"] == "crown_only" else "pinnacle"


def execution_cell(fixture: dict[str, Any], market: str, signal_line: float) -> tuple[float, dict[str, float]] | None:
    provider = main_provider(fixture)
    cell = stage_line(fixture, "T30", provider, market)
    return cell if cell and abs(cell[0] - signal_line) < EPS else None


def make_bet(
    fixture: dict[str, Any], policy: str, family: str, market: str, selection: str,
    line: float, odds: float, *, detail: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    home, away = fixture["home_score"], fixture["away_score"]
    if home is None or away is None or odds <= 1:
        return None
    status, ret = settle(market, line, selection, odds, home, away)
    return {
        "match_id": fixture["match_id"], "cohort": fixture["cohort"], "league": fixture["league"],
        "kickoff_utc": fixture["kickoff_utc"], "kickoff_day": kickoff_day(fixture["kickoff_utc"]),
        "family": family, "policy": policy, "market": market, "selection": selection,
        "line": line, "odds": odds, "result": status, "return": ret,
        "detail": detail or {},
    }


def build_fixtures(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Normalize raw snapshot rows and reject quote cells that cannot be read safely."""
    diag: Counter[str] = Counter()
    quotes: dict[tuple[str, str, str, str, str, str], dict[str, Any]] = {}
    meta: dict[str, dict[str, Any]] = {}
    for row in rows:
        match_id = str(row.get("match_id") or "")
        stage, provider, market = str(row.get("stage")), str(row.get("provider")), str(row.get("market"))
        selection, line = str(row.get("selection")), num(row.get("line_key"))
        captured, kickoff, odds = integer(row.get("captured_at")), integer(row.get("kickoff_utc")), num(row.get("decimal_odds"))
        if not match_id or stage not in STAGES or provider not in ("hkjc", "pinnacle", "crown") or market not in SIDE:
            diag["unsupported_row_identity"] += 1
            continue
        if selection not in SIDE[market] or line is None or captured is None or kickoff is None or odds is None or odds <= 1:
            diag["unreadable_line_selection_or_odds"] += 1
            continue
        if captured >= kickoff:
            diag["post_kickoff_quote"] += 1
            continue
        if stage == "initial" and row.get("origin") != "external_opening":
            diag["initial_not_true_external_opening"] += 1
            continue
        key = (match_id, stage, provider, market, str(row.get("line_key")), selection)
        if key in quotes:
            diag["duplicate_quote_identity"] += 1
            if qkey(row) <= qkey(quotes[key]):
                continue
        quotes[key] = row
        meta[match_id] = {
            "match_id": match_id, "league": str(row.get("league") or "未知聯賽"),
            "kickoff_utc": kickoff, "home_score": integer(row.get("home_score")),
            "away_score": integer(row.get("away_score")),
            "fixture_source": str(row.get("fixture_source") or "hkjc"),
            "hkjc_id": row.get("hkjc_id"),
        }

    grouped: dict[str, dict[tuple[str, str, str], dict[str, dict[str, Any]]]] = defaultdict(lambda: defaultdict(dict))
    for (match_id, stage, provider, market, line, selection), row in quotes.items():
        grouped[match_id][(stage, provider, market)][f"{line}|{selection}"] = row

    fixtures: list[dict[str, Any]] = []
    for match_id, groups in grouped.items():
        info = meta[match_id]
        if info["home_score"] is None or info["away_score"] is None:
            diag["fixture_missing_reliable_score"] += 1
            continue
        main: dict[tuple[str, str, str], tuple[float, dict[str, float]]] = {}
        captured: dict[tuple[str, str, str], int] = {}
        derived_main: set[tuple[str, str, str]] = set()
        for key, cells in groups.items():
            candidates: list[tuple[tuple[int, int], float, dict[str, float], int]] = []
            by_line: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
            for compound, row in cells.items():
                line_text, selection = compound.rsplit("|", 1)
                by_line[line_text][selection] = row
            complete_lines: list[tuple[tuple[int, int], float, dict[str, float], int]] = []
            for line_text, two in by_line.items():
                market = key[2]
                if any(s not in two for s in SIDE[market]):
                    diag["incomplete_two_sided_line"] += 1
                    continue
                line = num(line_text)
                prices = {s: num(two[s].get("decimal_odds")) for s in SIDE[market]}
                if line is None or any(v is None or v <= 1 for v in prices.values()):
                    continue
                latest = max(qkey(row) for row in two.values())
                cap = max(integer(row.get("captured_at")) or 0 for row in two.values())
                complete_lines.append((latest, line, prices, cap))  # type: ignore[arg-type]
                # A line is admissible only when it was marked main. Selecting the
                # latest side's timestamp protects historical duplicate exports.
                if any(integer(row.get("is_main")) == 1 for row in two.values()):
                    candidates.append((latest, line, prices, cap))  # type: ignore[arg-type]
            # Tipsme's Pinnacle v2 contract exposes one named begin-cap per market.
            # When the exported fixture/provider/market has exactly one complete
            # line, it is therefore mechanically (not outcome) derivable as main.
            # HKJC history exposes a list of historical lines without a main flag,
            # so the same inference is deliberately forbidden for HKJC.
            is_derived_pinnacle_opening = key[0] == "initial" and key[1] == "pinnacle" and not candidates
            if is_derived_pinnacle_opening and len(complete_lines) == 1:
                candidates = complete_lines
                derived_main.add(key)
                diag["derived_pinnacle_initial_unique_complete_line"] += 1
            elif is_derived_pinnacle_opening and len(complete_lines) > 1:
                diag["ambiguous_pinnacle_initial_multiple_complete_lines"] += 1
            if len(candidates) > 1:
                diag["multiple_main_lines_latest_used"] += 1
            if candidates:
                latest, line, prices, cap = max(candidates, key=lambda x: x[0])
                main[key] = (line, prices)
                captured[key] = cap
        cohort = "crown_only" if info["fixture_source"] == "crown" and not info["hkjc_id"] else "hkjc"
        fixtures.append({**info, "cohort": cohort, "main": main, "captured": captured, "derived_main": derived_main})
    return fixtures, dict(diag)


def family_one(fixtures: list[dict[str, Any]]) -> list[dict[str, Any]]:
    raw: list[dict[str, Any]] = []
    for f in fixtures:
        p = signal_provider(f)
        for market in SIDE:
            if not all(usable(f, s, p, market) for s in STAGES):
                continue
            initial, t30, t5 = (stage_line(f, s, p, market) for s in STAGES)
            assert initial and t30 and t5
            if abs(initial[0] - t30[0]) > EPS or abs(t30[0] - t5[0]) > EPS:
                continue
            execution = execution_cell(f, market, t30[0])
            if not execution:
                continue
            for side in SIDE[market]:
                raw.append({"fixture": f, "provider": p, "market": market, "selection": side,
                            "line": t30[0], "odds": execution[1][side],
                            "water": initial[1][side] - t30[1][side],
                            "t5_change": t30[1][side] - t5[1][side]})
    by_bucket: dict[tuple[str, str, str], list[float]] = defaultdict(list)
    for x in raw:
        by_bucket[(x["fixture"]["cohort"], x["fixture"]["league"], x["market"])].append(x["water"])
    bets: list[dict[str, Any]] = []
    for x in raw:
        pct = percentile(by_bucket[(x["fixture"]["cohort"], x["fixture"]["league"], x["market"])], x["water"])
        if pct is None:
            continue
        group = "top10" if pct >= .9 else "p70_90" if pct >= .7 else "middle_control" if .3 <= pct < .7 else "tail"
        if group == "tail":
            continue
        bet = make_bet(x["fixture"], f"F1_{group}", "F1_league_water", x["market"], x["selection"], x["line"], x["odds"],
                       detail={"signal_provider": x["provider"], "execution_provider": main_provider(x["fixture"]),
                               "water": x["water"], "league_percentile": pct, "t5_change": x["t5_change"],
                               "t5_label": "continue" if x["t5_change"] >= .01 else "reverse" if x["t5_change"] <= -.01 else "flat"})
        if bet:
            bets.append(bet)
    return bets


def family_two(fixtures: list[dict[str, Any]]) -> list[dict[str, Any]]:
    bets: list[dict[str, Any]] = []
    for f in fixtures:
        if f["cohort"] != "hkjc":
            continue
        for market in SIDE:
            if not all(usable(f, stage, provider, market) for stage in ("initial", "T30") for provider in ("hkjc", "pinnacle", "crown")):
                continue
            cells = {(stage, p): stage_line(f, stage, p, market) for stage in ("initial", "T30") for p in ("hkjc", "pinnacle", "crown")}
            if len({v[0] for v in cells.values() if v}) != 1:
                continue
            line = cells[("T30", "hkjc")][0]  # type: ignore[index]
            for side in SIDE[market]:
                pin_down = cells[("initial", "pinnacle")][1][side] - cells[("T30", "pinnacle")][1][side]  # type: ignore[index]
                crown_down = cells[("initial", "crown")][1][side] - cells[("T30", "crown")][1][side]  # type: ignore[index]
                hprice = cells[("T30", "hkjc")][1][side]  # type: ignore[index]
                lag = hprice - max(cells[("T30", "pinnacle")][1][side], cells[("T30", "crown")][1][side])  # type: ignore[index]
                if pin_down <= 0 or crown_down <= 0:
                    continue
                for threshold in (.03, .05, .08):
                    if lag + EPS >= threshold:
                        bet = make_bet(f, f"F2_lag_{threshold:.2f}", "F2_double_external_hkjc_lag", market, side, line, hprice,
                                       detail={"lag": lag, "pin_down": pin_down, "crown_down": crown_down})
                        if bet:
                            bets.append(bet)
    return bets


def oriented_line_move(market: str, selection: str, initial: float, t30: float) -> float:
    if market == "AH":
        return initial - t30 if selection == "H" else t30 - initial
    return t30 - initial if selection == "O" else initial - t30


def family_three(fixtures: list[dict[str, Any]]) -> list[dict[str, Any]]:
    bets: list[dict[str, Any]] = []
    for f in fixtures:
        p = signal_provider(f)
        for market in SIDE:
            if not all(usable(f, s, p, market) for s in ("initial", "T30")):
                continue
            ini, t30 = stage_line(f, "initial", p, market), stage_line(f, "T30", p, market)
            assert ini and t30
            execution = execution_cell(f, market, t30[0])
            if not execution:
                continue
            t5 = stage_line(f, "T5", p, market) if usable(f, "T5", p, market) else None
            for side in SIDE[market]:
                movement = oriented_line_move(market, side, ini[0], t30[0])
                rising = t30[1][side] - ini[1][side]
                if movement + EPS < .25:
                    continue
                for threshold in (.03, .05, .08):
                    if rising + EPS < threshold:
                        continue
                    t5_change = None if not t5 or abs(t5[0] - t30[0]) > EPS else t30[1][side] - t5[1][side]
                    detail = {"signal_provider": p, "execution_provider": main_provider(f),
                              "line_move_toward_selection": movement, "odds_rise": rising, "t5_same_line_change": t5_change,
                              "t5_label": "continue_water" if t5_change is not None and t5_change >= .01 else "t5_reverse" if t5_change is not None and t5_change <= -.01 else "not_confirmed"}
                    for action, pick in (("follow", side), ("fade", opposite(market, side))):
                        bet = make_bet(f, f"F3_{action}_{threshold:.2f}", "F3_line_odds_contradiction", market, pick, t30[0], execution[1][pick], detail=detail)
                        if bet:
                            bets.append(bet)
    return bets


def favorite_side(line: float, prices: dict[str, float]) -> str:
    if line < -EPS:
        return "H"
    if line > EPS:
        return "A"
    return "H" if prices["H"] <= prices["A"] else "A"


def family_four(fixtures: list[dict[str, Any]]) -> list[dict[str, Any]]:
    bets: list[dict[str, Any]] = []
    for f in fixtures:
        p = signal_provider(f)
        if not all(usable(f, s, p, market) for market in ("AH", "OU") for s in ("initial", "T30")):
            continue
        ah0, ah = stage_line(f, "initial", p, "AH"), stage_line(f, "T30", p, "AH")
        ou0, ou = stage_line(f, "initial", p, "OU"), stage_line(f, "T30", p, "OU")
        assert ah0 and ah and ou0 and ou
        ah_execution, ou_execution = execution_cell(f, "AH", ah[0]), execution_cell(f, "OU", ou[0])
        if not ah_execution or not ou_execution:
            continue
        fav = favorite_side(ah[0], ah[1])
        depth_delta = abs(ah[0]) - abs(ah0[0])
        if depth_delta >= .25 - EPS:
            ah_state, ah_pick = "deep", fav
        elif depth_delta <= -.25 + EPS:
            ah_state, ah_pick = "shallow", opposite("AH", fav)
        elif abs(depth_delta) < EPS and ah0[1][fav] - ah[1][fav] >= .03 - EPS:
            ah_state, ah_pick = "same_water", fav
        else:
            continue
        ou_delta = ou[0] - ou0[0]
        if ou_delta >= .25 - EPS:
            ou_state, ou_pick = "up", "O"
        elif ou_delta <= -.25 + EPS:
            ou_state, ou_pick = "down", "U"
        elif abs(ou_delta) < EPS:
            water = max(SIDE["OU"], key=lambda s: ou0[1][s] - ou[1][s])
            if ou0[1][water] - ou[1][water] < .03 - EPS:
                continue
            ou_state, ou_pick = "same_water", water
        else:
            continue
        key = f"F4_AH_{ah_state}__OU_{ou_state}"
        for market, selection, line, prices in (("AH", ah_pick, ah[0], ah_execution[1]), ("OU", ou_pick, ou[0], ou_execution[1])):
            t5 = stage_line(f, "T5", p, market) if usable(f, "T5", p, market) else None
            t5_label = "unavailable"
            if t5:
                t5_label = "same_line" if abs(t5[0] - line) < EPS else "line_changed"
            bet = make_bet(f, f"{key}_{market}", "F4_AH_OU_script", market, selection, line, prices[selection],
                           detail={"signal_provider": p, "execution_provider": main_provider(f),
                                   "ah_state": ah_state, "ou_state": ou_state, "t5_confirmation": t5_label})
            if bet:
                bets.append(bet)
    return bets


def no_initial_t30_price_lag(fixtures: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Independent second-tier path: decide from T30, inspect T5 only afterwards."""
    bets: list[dict[str, Any]] = []
    for f in fixtures:
        if f["cohort"] != "hkjc":
            continue
        for market in SIDE:
            if not (usable(f, "T30", "hkjc", market) and usable(f, "T30", "pinnacle", market)):
                continue
            hkjc = stage_line(f, "T30", "hkjc", market)
            pinnacle = stage_line(f, "T30", "pinnacle", market)
            assert hkjc and pinnacle
            if abs(hkjc[0] - pinnacle[0]) > EPS:
                continue
            t5 = stage_line(f, "T5", "pinnacle", market) if usable(f, "T5", "pinnacle", market) else None
            for threshold in (.03, .05, .08):
                eligible = [s for s in SIDE[market] if hkjc[1][s] - pinnacle[1][s] >= threshold - EPS]
                if not eligible:
                    continue
                side = max(eligible, key=lambda s: (hkjc[1][s] - pinnacle[1][s], s))
                t5_label, t5_change = "unavailable", None
                if t5 and abs(t5[0] - pinnacle[0]) < EPS:
                    t5_change = pinnacle[1][side] - t5[1][side]
                    t5_label = "continue_water" if t5_change >= .01 else "reverse" if t5_change <= -.01 else "flat"
                elif t5:
                    t5_label = "line_changed"
                bet = make_bet(
                    f, f"N1_T30_lag_{threshold:.2f}", "N1_no_initial_T30_price_lag", market, side,
                    hkjc[0], hkjc[1][side],
                    detail={"path": "無初盤路徑，T30決策/T5僅確認",
                            "gap_hkjc_minus_pinnacle": hkjc[1][side] - pinnacle[1][side],
                            "t5_same_line_change": t5_change, "t5_label": t5_label},
                )
                if bet:
                    bets.append(bet)
    return bets


def metrics(bets: list[dict[str, Any]], seed: int) -> dict[str, Any]:
    counts = Counter(b["result"] for b in bets)
    # Half wins count as one-half hit; half losses as a half miss.  This is
    # explicit, while ROI remains the primary Asian-market statistic.
    decisions = len(bets) - counts["P"]
    hit_equiv = counts["W"] + .5 * counts["HW"] + .5 * counts["HL"]
    returns = [b["return"] for b in bets]
    avg_odds = mean(b["odds"] for b in bets) if bets else None
    break_even = None if not avg_odds else 1 / avg_odds
    return {
        "n": len(bets), "unique_fixtures": len({b["match_id"] for b in bets}),
        "W": counts["W"], "HW": counts["HW"], "P": counts["P"], "HL": counts["HL"], "L": counts["L"],
        "hit_definition": "W=1, HW=0.5, HL=0.5, L=0；push 排除",
        "hit_rate_ex_push": hit_equiv / decisions if decisions else None,
        "average_odds": avg_odds, "break_even_rate": break_even,
        "unit_pnl": sum(returns), "roi": sum(returns) / len(returns) if returns else None,
        "roi_bootstrap_95": bootstrap_roi(returns, seed),
        "wilson_95_lower": wilson_lower(hit_equiv, decisions),
        "t5_confirmation": dict(Counter(str(b["detail"].get("t5_label") or b["detail"].get("t5_confirmation") or "n/a") for b in bets)),
    }


def split_by_day(bets: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str | None]:
    days = sorted({b["kickoff_day"] for b in bets})
    if len(days) < 2:
        return bets, [], None
    target = .7 * len(bets)
    cumulative = 0
    options: list[tuple[float, int]] = []
    for index, day in enumerate(days[:-1], start=1):
        cumulative += sum(b["kickoff_day"] == day for b in bets)
        options.append((abs(cumulative - target), index))
    _, cut = min(options)
    discovery_days = set(days[:cut])
    discovery = [b for b in bets if b["kickoff_day"] in discovery_days]
    holdout = [b for b in bets if b["kickoff_day"] not in discovery_days]
    return discovery, holdout, max(discovery_days) if discovery_days else None


def controls_for(bets: list[dict[str, Any]], universe: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One unused same-league, same-market, same-side fixture control per bet."""
    result, used = [], set()
    selected = {b["match_id"] for b in bets}
    for bet in sorted(bets, key=lambda x: (x["kickoff_utc"], x["match_id"])):
        choices = [u for u in universe if u["match_id"] not in selected and u["match_id"] not in used
                   and u["league"] == bet["league"] and u["market"] == bet["market"] and u["selection"] == bet["selection"]
                   and u["cohort"] == bet["cohort"]]
        if not choices:
            continue
        control = min(choices, key=lambda x: abs(x["kickoff_utc"] - bet["kickoff_utc"]))
        used.add(control["match_id"])
        result.append(control)
    return result


def permutation_delta(candidate: list[dict[str, Any]], controls: list[dict[str, Any]], seed: int) -> dict[str, Any]:
    pairs = min(len(candidate), len(controls))
    if not pairs:
        return {"pairs": 0, "roi_delta": None, "permutation_p_two_sided": None}
    a, b = [x["return"] for x in candidate[:pairs]], [x["return"] for x in controls[:pairs]]
    observed = mean(x - y for x, y in zip(a, b))
    rng, extreme = random.Random(seed), 0
    for _ in range(PERMUTATIONS):
        value = mean((x - y) * (1 if rng.random() < .5 else -1) for x, y in zip(a, b))
        extreme += abs(value) >= abs(observed) - EPS
    return {"pairs": pairs, "roi_delta": observed, "permutation_p_two_sided": (extreme + 1) / (PERMUTATIONS + 1)}


def holm(items: list[dict[str, Any]]) -> None:
    ordered = sorted(enumerate(items), key=lambda p: p[1]["control_comparison"]["permutation_p_two_sided"] if p[1]["control_comparison"]["permutation_p_two_sided"] is not None else 1)
    m, previous = len(ordered), 0.0
    for rank, (_, item) in enumerate(ordered):
        p = item["control_comparison"]["permutation_p_two_sided"]
        adjusted = None if p is None else min(1.0, max(previous, p * (m - rank)))
        previous = adjusted if adjusted is not None else previous
        item["holm_adjusted_p_family"] = adjusted


def independent_universe(fixtures: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """All T30-executable choices used as potential matched controls."""
    rows = []
    for f in fixtures:
        p = main_provider(f)
        for market in SIDE:
            if not usable(f, "T30", p, market):
                continue
            cell = stage_line(f, "T30", p, market)
            assert cell
            for side in SIDE[market]:
                b = make_bet(f, "control_universe", "control", market, side, cell[0], cell[1][side])
                if b:
                    rows.append(b)
    return rows


def grade(holdout: dict[str, Any], comparison: dict[str, Any]) -> str:
    if not holdout["n"]:
        return "Reject（無 holdout）"
    if holdout["n"] < 30:
        return "Watch（holdout <30）"
    if holdout["roi"] is None or holdout["roi"] <= 0 or comparison["roi_delta"] is None or comparison["roi_delta"] <= 0:
        return "Reject"
    if holdout["n"] < 50:
        return "Watch（未達50）"
    return "Watch（需100場前瞻驗證）"


def evaluate(fixtures: list[dict[str, Any]], bets: list[dict[str, Any]], family: str, universe: list[dict[str, Any]]) -> dict[str, Any]:
    policies: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for b in bets:
        policies[b["policy"]].append(b)
    scanned = []
    for name, rows in sorted(policies.items()):
        discovery, holdout, boundary = split_by_day(rows)
        scanned.append({"policy": name, "family": family, "cohort": rows[0]["cohort"], "market": rows[0]["market"],
                        "discovery": metrics(discovery, stable_seed(name)), "holdout": metrics(holdout, stable_seed(name + "h")),
                        "split_last_discovery_day": boundary, "_discovery_rows": discovery, "_holdout_rows": holdout})
    # Discovery only: lock at most three policies.  Ties are deterministic.
    selected = sorted(scanned, key=lambda x: (x["discovery"]["roi"] is not None, x["discovery"]["roi"] or -999, x["discovery"]["n"], x["policy"]), reverse=True)[:3]
    chosen = []
    for x in selected:
        holdout_rows = x.pop("_holdout_rows")
        x.pop("_discovery_rows")
        controls = controls_for(holdout_rows, universe)
        x["control"] = metrics(controls, stable_seed(x["policy"] + "c"))
        x["control_comparison"] = permutation_delta(holdout_rows, controls, stable_seed(x["policy"] + "p"))
        x["classification"] = grade(x["holdout"], x["control_comparison"])
        chosen.append(x)
    # remove private rows from unselected scan summaries
    scanned_public = []
    for x in scanned:
        x = dict(x)
        x.pop("_discovery_rows", None)
        x.pop("_holdout_rows", None)
        scanned_public.append(x)
    holm(chosen)
    return {"family": family, "planned_policy_templates": POLICY_TEMPLATES[family],
            "predefined_policy_tests": len(scanned_public), "selection_rule": "按 discovery ROI 排名，最多三條；holdout 從未參與挑選。",
            "scanned": scanned_public, "selected_holdout": chosen}


def league_table(bets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    by_league: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for b in bets:
        by_league[(b["cohort"], b["league"])].append(b)
    for (cohort, league), group in sorted(by_league.items(), key=lambda x: (-len(x[1]), x[0])):
        value = metrics(group, stable_seed(cohort + league))
        value.update({"cohort": cohort, "league": league,
                      "eligibility": "獨立候選可考慮" if value["n"] >= 100 else "Watch" if value["n"] >= 50 else "僅探索（n<50）"})
        rows.append(value)
    return rows


def markdown(report: dict[str, Any]) -> str:
    cov = report["coverage"]
    lines = [
        "# Radar 報價方向完整只讀回測",
        "", "## 結論",
        "",
        f"- 資料期間：{cov['data_period_utc']}；有效已結算 fixtures：{cov['settled_fixtures']}，原始報價列：{cov['raw_quote_rows']}。",
        f"- 預先定義 {report['planned_policy_templates']} 條政策模板，實際可執行掃描 {report['total_predefined_policy_tests']} 條；每家族只以 discovery 選最多三條，固定後才查看 holdout。",
        "- HKJC 真初盤沒有主線標示，故不作歷史派生；Pinnacle 僅在來源契約的唯一 begin-cap 情況下作審計派生，任何多線 fixture-market 均排除，避免以結果挑線。",
        "- 任何 `Watch` 或 `Reject` 均不是可下注建議；亞洲盤以 ROI 為主，半中／半輸的命中定義見 JSON。",
        "",
        "## 選中的 holdout 候選",
        "",
        "| 家族 | 政策 | cohort | 市場 | holdout n | W/HW/P/HL/L | 平均賠率 | ROI | Bootstrap 95% CI | Wilson 下界 | 對照 ROI 差 | Holm p | 結論 |",
        "|---|---|---|---|---:|---|---:|---:|---|---:|---:|---:|---|",
    ]
    if report["audit"].get("source_workflow_run_url"):
        lines.insert(7, f"- 證據 workflow：{report['audit']['source_workflow_run_url']}；資料匯出 SHA-256：{report['audit'].get('export_sha256', '—')}。")
    selected = [x for family in report["families"] for x in family["selected_holdout"]]
    for x in selected:
        h, cc = x["holdout"], x["control_comparison"]
        ci = h["roi_bootstrap_95"]
        pct = lambda v: "—" if v is None else f"{v * 100:+.1f}%"
        lines.append(f"| {x['family']} | {x['policy']} | {x['cohort']} | {x['market']} | {h['n']} | "
                     f"{h['W']}/{h['HW']}/{h['P']}/{h['HL']}/{h['L']} | "
                     f"{'—' if h['average_odds'] is None else f'{h['average_odds']:.3f}'} | {pct(h['roi'])} | "
                     f"{'—' if ci[0] is None else pct(ci[0]) + ' 至 ' + pct(ci[1])} | "
                     f"{pct(h['wilson_95_lower'])} | {pct(cc['roi_delta'])} | "
                     f"{'—' if x['holm_adjusted_p_family'] is None else f'{x['holm_adjusted_p_family']:.3f}'} | {x['classification']} |")
    lines += [
        "", "## 方法與防呆", "",
        "- 僅使用 `research_timeline_snapshots`；initial 限 `origin=external_opening`，T30/T5 限實際已捕獲且開賽前的同 stage 報價；不以 T15 或事後盤補代。",
        "- 主線只取 `is_main=1`；若匯出出現多個主線，按 `source_updated_at`、`captured_at` 最新者，完整雙邊才可入樣。",
        "- 唯一例外是 audit 的 `derived_is_main`：僅 Pinnacle 真初盤同 fixture/provider/market 恰有一條完整雙邊時，才以 Tipsme v2 的單一 begin-cap 派生；兩條或以上一律 ambiguity 排除。HKJC 歷史列從不派生主線。",
        "- hkjc fixture 與 crown-only fixture 分開；主 cohort 以 HKJC 的 T30 可下注賠率結算，crown-only 以 Crown 結算。",
        "- 70/30 split 依 UTC kickoff 日期，整日不交叉。對照為同 cohort、聯賽、市場、方向且未被規則選中的一對一 fixtures；permutation 在配對內交換標籤。",
        "", "## 各家族掃描與限制", "",
    ]
    for family in report["families"]:
        lines += [f"### {family['family']}", f"- 預定模板：{family['planned_policy_templates']}；可執行政策：{family['predefined_policy_tests']}；{family['selection_rule']}"]
        if family["family"] == "N1_no_initial_T30_price_lag":
            lines.append("- **無初盤路徑，T30決策/T5僅確認**：只以 T30 同線 HKJC−Pinnacle 價格差選擇，T5 從不參與入選，僅分類為後續 continue／reverse／flat。")
        if family["family"] == "F2_double_external_hkjc_lag" and family["predefined_policy_tests"] == 0:
            lines.append("- 未能執行：條件要求 HKJC 也有可辨識的 initial→T30 同方向；Tipsme HKJC 歷史合約沒有主線標示，故未作推斷。")
        for x in family["scanned"]:
            d, h = x["discovery"], x["holdout"]
            lines.append(f"- `{x['policy']}`：discovery n={d['n']} ROI={'—' if d['roi'] is None else f'{d['roi']*100:+.1f}%'}；holdout n={h['n']} ROI={'—' if h['roi'] is None else f'{h['roi']*100:+.1f}%'}。")
    lines += ["", "## 逐聯賽（全部候選，僅描述性）", "",
              "| cohort | 聯賽 | n | ROI | 結論門檻 |", "|---|---|---:|---:|---|"]
    for x in report["league_summary"]:
        lines.append(f"| {x['cohort']} | {x['league']} | {x['n']} | {'—' if x['roi'] is None else f'{x['roi']*100:+.1f}%'} | {x['eligibility']} |")
    lines += ["", "## 排除與前瞻規則", ""]
    for key, value in sorted(cov["exclusions"].items()):
        lines.append(f"- 排除／診斷 `{key}`：{value}")
    lines += ["", "### 可用完整主線格數（fixture 數）"]
    for key, value in sorted(cov["main_complete_two_sided_cells"].items()):
        lines.append(f"- `{key}`：{value}")
    lines += ["", "### 原始列分布（stage｜origin｜provider｜market）"]
    for key, value in sorted(cov["raw_rows_by_stage_origin_provider_market"].items()):
        lines.append(f"- `{key}`：{value}")
    lines += ["", "### 真初盤主線標示（provider｜market｜is_main）"]
    for key, value in sorted(cov["initial_external_main_flags"].items()):
        lines.append(f"- `{key}`：{value}")
    lines += ["", "### external_opening 原始來源欄位核對"]
    for provider, profile in sorted(cov["external_opening_contract_profile"].items()):
        sources = "、".join(f"{name}={count}" for name, count in profile["source_name_counts"].items())
        lines.append(
            f"- `{provider}`：rows={profile['rows']}；source_name：{sources}；"
            f"source_match_id null={profile['source_match_id_null']}／unique={profile['source_match_id_unique']}；"
            f"非空 line_key={profile['line_key_nonempty']}；selection counts={profile['selection_counts']}。"
        )
    lines += [
        "- 無可靠正式 score、無完整雙邊、不能解讀 line/selection、非真初盤或開賽後報價均已排除。",
        "- 根因：`tipsme-opening.ts` 對 HKJC 的歷史多線逐線取最早價而明確設 `isMain:false`；該外部合約不提供主線標誌，不能用後來 T30/T5 或賠率挑線回補。Pinnacle 的 `hdpBeginCap`／`hiloBeginCap` 為單一 begin-cap，先前同樣硬設 false，屬可最小修正的 collector 標示 bug。",
        "- 建議的最小 production 修正（本次未實施）：只在 `parseTipsmeOpeningQuotes` 的 `pinnacleBase` 設 `isMain:true`，並加一個 parser 測試；HKJC 保持 false，直到來源合約加入正式 main-line 欄位。另在 `saveResearchInitialSnapshots` 於已取得完整 provider-market pair 後拒絕後續不同 line，保留一次開盤的唯一性。",
        "- 前瞻只應固定本報告已選政策、以 T30 價格下單（本回測沒有下單或通知），累積至少 50 個新 holdout fixtures 才重評；100 場前不可把單聯賽視為獨立候選。",
        "- CLV：本匯出沒有獨立 closing quote；T5 僅是後續確認，不可冒充 closing，故 CLV 報為 unavailable。",
    ]
    return "\n".join(lines) + "\n"


def build_report(rows: list[dict[str, Any]], provenance: dict[str, Any] | None = None) -> dict[str, Any]:
    fixtures, exclusions = build_fixtures(rows)
    universe = independent_universe(fixtures)
    family_bets = [
        ("F1_league_water", family_one(fixtures)),
        ("F2_double_external_hkjc_lag", family_two(fixtures)),
        ("F3_line_odds_contradiction", family_three(fixtures)),
        ("F4_AH_OU_script", family_four(fixtures)),
        ("N1_no_initial_T30_price_lag", no_initial_t30_price_lag(fixtures)),
    ]
    all_bets = [b for _, bets in family_bets for b in bets]
    periods = [f["kickoff_utc"] for f in fixtures]
    main_cells = Counter()
    for fixture in fixtures:
        for stage, provider, market in fixture["main"]:
            main_cells[f"{fixture['cohort']}|{stage}|{provider}|{market}"] += 1
    raw_shape = Counter(
        f"{str(row.get('stage'))}|{str(row.get('origin'))}|{str(row.get('provider'))}|{str(row.get('market'))}"
        for row in rows
    )
    opening_main_flags = Counter(
        f"{str(row.get('provider'))}|{str(row.get('market'))}|{integer(row.get('is_main')) or 0}"
        for row in rows if row.get("stage") == "initial" and row.get("origin") == "external_opening"
    )
    opening_contract_profile: dict[str, dict[str, Any]] = {}
    for provider in ("hkjc", "pinnacle", "crown"):
        external = [
            row for row in rows
            if row.get("stage") == "initial" and row.get("origin") == "external_opening"
            and row.get("provider") == provider
        ]
        if not external:
            continue
        opening_contract_profile[provider] = {
            "rows": len(external),
            "source_name_counts": dict(sorted(Counter(str(row.get("source_name")) for row in external).items())),
            "source_match_id_null": sum(row.get("source_match_id") is None for row in external),
            "source_match_id_unique": len({
                row.get("source_match_id") for row in external if row.get("source_match_id") is not None
            }),
            "line_key_nonempty": sum(bool(row.get("line_key")) for row in external),
            "selection_counts": {
                f"{market}|{selection}": count
                for (market, selection), count in sorted(
                    Counter((str(row.get("market")), str(row.get("selection"))) for row in external).items()
                )
            },
        }
    report = {
        "audit": {"read_only": True, "decision_checkpoint": "T30", "t5_use": "confirmation only, never T30 selection",
                  "derived_is_main_rule": "Pinnacle initial only: exactly one complete two-sided line for fixture/provider/market; Tipsme v2 begin-cap contract. HKJC is never derived; multiple lines are excluded as ambiguous.",
                  "root_cause": "tipsme-opening.ts explicitly writes isMain:false for both hkjcBase and pinnacleBase. HKJC historical contract lists first row per line without an authoritative main designation; Pinnacle v2 exposes one hdpBeginCap/hiloBeginCap.",
                  "production_fix_proposal": "Set pinnacleBase isMain:true and test it; do not infer HKJC. In saveResearchInitialSnapshots, avoid admitting a later alternate line after a complete provider-market opening pair exists.",
                  "clv": "unavailable: no independently captured closing quote in export", **(provenance or {})},
        "coverage": {
            "raw_quote_rows": len(rows), "settled_fixtures": len(fixtures),
            "data_period_utc": None if not periods else f"{datetime.fromtimestamp(min(periods)/1000, UTC).isoformat()} 至 {datetime.fromtimestamp(max(periods)/1000, UTC).isoformat()}",
            "fixtures_by_cohort": dict(Counter(f["cohort"] for f in fixtures)), "exclusions": exclusions,
            "main_complete_two_sided_cells": dict(sorted(main_cells.items())),
            "raw_rows_by_stage_origin_provider_market": dict(sorted(raw_shape.items())),
            "initial_external_main_flags": dict(sorted(opening_main_flags.items())),
            "external_opening_contract_profile": opening_contract_profile,
        },
        "families": [evaluate(fixtures, bets, family, universe) for family, bets in family_bets],
        "league_summary": league_table(all_bets),
        "planned_policy_templates": sum(POLICY_TEMPLATES.values()),
        "planned_policy_templates_by_family": POLICY_TEMPLATES,
        "total_predefined_policy_tests": sum(len(set(b["policy"] for b in bets)) for _, bets in family_bets),
        "raw_candidate_counts": dict(Counter(b["family"] for b in all_bets)),
    }
    return report


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--json-output", type=Path, required=True)
    parser.add_argument("--markdown-output", type=Path, required=True)
    parser.add_argument("--source-run-url")
    parser.add_argument("--source-commit")
    parser.add_argument("--source-data-sha256")
    args = parser.parse_args()
    report = build_report(read_jsonl(args.input), {
        key: value for key, value in {
            "source_workflow_run_url": args.source_run_url,
            "audit_branch_commit": args.source_commit,
            "export_sha256": args.source_data_sha256,
        }.items() if value
    })
    args.json_output.write_text(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    args.markdown_output.write_text(markdown(report), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
