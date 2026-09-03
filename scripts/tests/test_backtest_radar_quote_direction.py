import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backtest_radar_quote_direction import build_fixtures, split_by_day, settle, wilson_lower


class RadarQuoteDirectionTests(unittest.TestCase):
    def test_asian_quarter_settlement_is_exact(self):
        self.assertEqual(settle("OU", 2.25, "O", 2.0, 2, 0), ("HL", -0.5))
        self.assertEqual(settle("OU", 2.25, "U", 2.0, 2, 0), ("HW", 0.5))
        self.assertEqual(settle("AH", -0.25, "H", 2.0, 1, 1), ("HL", -0.5))
        self.assertEqual(settle("AH", -0.25, "A", 2.0, 1, 1), ("HW", 0.5))

    def test_date_split_never_crosses_a_kickoff_day(self):
        bets = [
            {"kickoff_day": "2026-01-01"}, {"kickoff_day": "2026-01-01"},
            {"kickoff_day": "2026-01-02"}, {"kickoff_day": "2026-01-03"},
        ]
        discovery, holdout, boundary = split_by_day(bets)
        self.assertEqual(boundary, "2026-01-02")
        self.assertTrue({b["kickoff_day"] for b in discovery}.isdisjoint({b["kickoff_day"] for b in holdout}))

    def test_wilson_lower_is_bounded_and_conservative(self):
        self.assertIsNone(wilson_lower(0, 0))
        self.assertGreaterEqual(wilson_lower(8, 10), 0)
        self.assertLess(wilson_lower(8, 10), 0.8)

    def test_only_unique_complete_pinnacle_begin_line_is_derived(self):
        def row(line, selection):
            return {
                "match_id": "m-derived", "stage": "initial", "provider": "pinnacle", "market": "OU",
                "line_key": line, "selection": selection, "decimal_odds": 1.9, "is_main": 0,
                "origin": "external_opening", "captured_at": 1, "source_updated_at": None,
                "kickoff_utc": 1_000_000, "home_score": 1, "away_score": 0, "fixture_source": "hkjc",
            }
        fixtures, diagnostics = build_fixtures([row("2.50", "O"), row("2.50", "U")])
        self.assertIn(("initial", "pinnacle", "OU"), fixtures[0]["derived_main"])
        self.assertEqual(diagnostics["derived_pinnacle_initial_unique_complete_line"], 1)
        fixtures, diagnostics = build_fixtures([
            row("2.50", "O"), row("2.50", "U"), row("2.75", "O"), row("2.75", "U"),
        ])
        self.assertNotIn(("initial", "pinnacle", "OU"), fixtures[0]["main"])
        self.assertEqual(diagnostics["ambiguous_pinnacle_initial_multiple_complete_lines"], 1)


if __name__ == "__main__":
    unittest.main()
