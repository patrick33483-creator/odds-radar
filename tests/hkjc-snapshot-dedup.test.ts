import { afterEach, describe, expect, it, vi } from "vitest";
import { RadarEngine } from "../server/lib/engine";
import { rawDb } from "../server/lib/store";

const PROVIDER_ID = "snapshot-dedup-regression";
const MATCH_ID = `hkjc:${PROVIDER_ID}`;

function clearRows(): void {
  rawDb.prepare("DELETE FROM research_timeline_snapshots WHERE match_id=?").run(MATCH_ID);
  rawDb.prepare("DELETE FROM research_timeline_points WHERE match_id=?").run(MATCH_ID);
  rawDb.prepare("DELETE FROM odds_snapshots WHERE match_id=?").run(MATCH_ID);
  rawDb.prepare("DELETE FROM odds_latest WHERE match_id=?").run(MATCH_ID);
  rawDb.prepare("DELETE FROM market_lines WHERE match_id=?").run(MATCH_ID);
  rawDb.prepare("DELETE FROM matches WHERE id=?").run(MATCH_ID);
}

describe("HKJC snapshot change detection", () => {
  afterEach(clearRows);

  it("does not append an unchanged full card and still removes suspended lines", async () => {
    clearRows();
    const engine = new RadarEngine();
    const prices = [
      { market: "OU" as const, lineValue: 2.5, isMain: true, selection: "O" as const, decimalOdds: 1.9 },
      { market: "OU" as const, lineValue: 2.5, isMain: true, selection: "U" as const, decimalOdds: 1.9 },
    ];
    const fetchPreMatch = vi.fn().mockResolvedValue({
      events: [{
        providerMatchId: PROVIDER_ID,
        league: "Regression League",
        homeTeam: "Home",
        awayTeam: "Away",
        kickoffUtc: Date.now() + 2 * 24 * 60 * 60_000,
        inplay: false,
        status: "PREEVENT",
        prices,
      }],
      latencyMs: 1,
      partial: false,
      warnings: [],
    });
    (engine as any).hkjc.fetchPreMatch = fetchPreMatch;

    await (engine as any).performHkjcRefresh();
    await (engine as any).performHkjcRefresh();

    expect(rawDb.prepare("SELECT COUNT(*) count FROM odds_snapshots WHERE match_id=?")
      .get(MATCH_ID)).toEqual({ count: 2 });

    fetchPreMatch.mockResolvedValueOnce({
      events: [{
        providerMatchId: PROVIDER_ID,
        league: "Regression League",
        homeTeam: "Home",
        awayTeam: "Away",
        kickoffUtc: Date.now() + 2 * 24 * 60 * 60_000,
        inplay: false,
        status: "PREEVENT",
        prices: [{ ...prices[0], decimalOdds: 1.95 }],
      }],
      latencyMs: 1,
      partial: false,
      warnings: [],
    });
    await (engine as any).performHkjcRefresh();

    expect(rawDb.prepare("SELECT COUNT(*) count FROM odds_snapshots WHERE match_id=?")
      .get(MATCH_ID)).toEqual({ count: 3 });
    expect(rawDb.prepare("SELECT selection,decimal_odds FROM odds_latest WHERE match_id=?")
      .all(MATCH_ID)).toEqual([{ selection: "O", decimal_odds: 1.95 }]);
  });
});
