import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backtest_ah0_hkjc_compression import build_events, candidates


def quote(
    provider,
    selection,
    odds,
    *,
    match_id="m1",
    stage="T5",
    captured_at=900_000,
    source_updated_at=899_000,
    home_score=2,
    away_score=1,
):
    return {
        "match_id": match_id,
        "market": "AH",
        "stage": stage,
        "line_key": "0",
        "provider": provider,
        "selection": selection,
        "decimal_odds": odds,
        "captured_at": captured_at,
        "source_updated_at": source_updated_at,
        "kickoff_utc": 1_000_000,
        "home_score": home_score,
        "away_score": away_score,
        "league": "Test",
        "home_team": "Home",
        "away_team": "Away",
    }


def complete_rows(overrides=None):
    overrides = overrides or {}
    values = {
        ("hkjc", "H"): 1.80,
        ("hkjc", "A"): 2.00,
        ("pinnacle", "H"): 1.90,
        ("pinnacle", "A"): 2.00,
    }
    rows = []
    for (provider, selection), odds in values.items():
        row_overrides = overrides.get((provider, selection), {})
        rows.append(quote(provider, selection, odds, **row_overrides))
    return rows


class Ah0CompressionBacktestTests(unittest.TestCase):
    def test_exact_point_ten_threshold_is_included(self):
        events, _ = build_events(complete_rows())
        follow = candidates(
            events, stage="T5", threshold=0.10,
            freshness_mode="strict", action="follow",
        )
        fade = candidates(
            events, stage="T5", threshold=0.10,
            freshness_mode="strict", action="fade",
        )
        self.assertEqual(len(follow), 1)
        self.assertEqual(follow[0]["selection"], "H")
        self.assertEqual(follow[0]["result"], "win")
        self.assertAlmostEqual(follow[0]["return"], 0.80)
        self.assertEqual(fade[0]["selection"], "A")
        self.assertEqual(fade[0]["result"], "loss")

    def test_draw_settles_as_push_for_both_sides(self):
        rows = complete_rows()
        for row in rows:
            row["home_score"] = 1
            row["away_score"] = 1
        events, _ = build_events(rows)
        for action in ("follow", "fade"):
            bets = candidates(
                events, stage="T5", threshold=0.10,
                freshness_mode="strict", action=action,
            )
            self.assertEqual(bets[0]["result"], "push")
            self.assertEqual(bets[0]["return"], 0.0)

    def test_stale_source_is_excluded_from_strict_only(self):
        rows = complete_rows({
            ("pinnacle", "H"): {"source_updated_at": 700_000},
        })
        events, _ = build_events(rows)
        strict = candidates(
            events, stage="T5", threshold=0.10,
            freshness_mode="strict", action="follow",
        )
        capture_sync = candidates(
            events, stage="T5", threshold=0.10,
            freshness_mode="capture_sync", action="follow",
        )
        self.assertEqual(strict, [])
        self.assertEqual(len(capture_sync), 1)

    def test_incomplete_four_quote_cell_is_excluded(self):
        rows = complete_rows()[:-1]
        events, diagnostics = build_events(rows)
        self.assertEqual(events, [])
        self.assertEqual(diagnostics["incomplete_four_quote_cell"], 1)

    def test_latest_duplicate_quote_is_used(self):
        rows = complete_rows()
        rows.append(quote("hkjc", "H", 1.70, captured_at=910_000))
        events, diagnostics = build_events(rows)
        self.assertEqual(diagnostics["duplicate_quote_identity"], 1)
        self.assertEqual(events[0]["odds"]["hkjc"]["H"], 1.70)


if __name__ == "__main__":
    unittest.main()
