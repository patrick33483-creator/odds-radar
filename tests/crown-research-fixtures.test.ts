import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { RadarEngine } from "../server/lib/engine";
import { rawDb } from "../server/lib/store";

const PREFIX = "phase1-crown-isolation";
const NOW = 1_900_000_000_000;
const EXECUTION_TABLES = [
  "odds_latest", "odds_snapshots", "market_lines", "opportunities", "simulation_bets",
  "ou_signal_prealerts", "ou_signal_observations",
] as const;

function executionCounts(): Record<string, number> {
  return Object.fromEntries(EXECUTION_TABLES.map((table) => [
    table,
    Number((rawDb.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count),
  ]));
}

function cleanup(): void {
  rawDb.prepare("DELETE FROM crown_research_attempts WHERE titan_id LIKE ?").run(`${PREFIX}%`);
  rawDb.prepare("DELETE FROM research_timeline_snapshots WHERE match_id LIKE ?").run(`${PREFIX}%`);
  rawDb.prepare("DELETE FROM matches WHERE id LIKE ?").run(`${PREFIX}%`);
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("Phase 1 Crown research isolation", () => {
  it("does not install the today-Crown backfill runtime", () => {
    const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    expect(routes).not.toContain("collectTodayCrownBackfill");
    expect(routes).not.toContain("installTodayCrownBackfill");
  });

  it("does not execute Crown research detail from the primary timeline preparation and leaves execution tables unchanged", async () => {
    rawDb.prepare(
      `INSERT INTO matches(
        id,hkjc_id,fixture_source,titan_id,league,home_team,away_team,kickoff_utc,status,inplay,updated_at
      ) VALUES(?,NULL,'crown',?,'L','H','A',?,'PREEVENT',0,?)`,
    ).run(`${PREFIX}:fixture`, `${PREFIX}-titan`, NOW + 20 * 60_000, NOW);
    const engine = new RadarEngine();
    const refreshHkjc = vi.spyOn(engine, "refreshHkjc").mockResolvedValue([] as never);
    const refreshFixtures = vi.spyOn(engine, "refreshPinnacleFixtures").mockResolvedValue(0);
    const fetchCrown = vi.fn();
    (engine as unknown as { pinnacle: { fetchCrownResearchPrices: typeof fetchCrown } }).pinnacle
      .fetchCrownResearchPrices = fetchCrown;
    const before = executionCounts();

    await expect(engine.runResearchTimelineTick()).resolves.toEqual({ selected: 0, detailCalls: 0 });

    expect(refreshHkjc).toHaveBeenCalledTimes(1);
    expect(refreshFixtures).toHaveBeenCalledTimes(1);
    expect(fetchCrown).not.toHaveBeenCalled();
    expect(rawDb.prepare("SELECT COUNT(*) count FROM research_timeline_snapshots WHERE match_id=?")
      .get(`${PREFIX}:fixture`)).toEqual({ count: 0 });
    expect(executionCounts()).toEqual(before);
  });
});
