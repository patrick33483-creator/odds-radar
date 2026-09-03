import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RadarEngine,
  reconcileCrownFixtureIntoHkjc,
  upsertCrownResearchFixtures,
} from "../server/lib/engine";
import {
  captureResearchTimelinePrices,
  collectResearchResults,
  expectedPairCount,
  researchCsv,
  researchDataset,
  saveCrownResearchInitialSnapshots,
} from "../server/lib/research";
import { rawDb } from "../server/lib/store";
import {
  syncOuSignalObservations,
  syncOuSignalPrealerts,
  unsentOuPrealerts,
  unsentOuSignals,
} from "../server/lib/ou-signals";
import type { PinnacleFixture } from "../server/providers/pinnacle";
import type { ProviderPrice } from "../server/providers/types";

const PREFIX = "crown-fixture-test";
const NOW = 1_900_000_000_000;

function fixture(sid: string, kickoffUtc = NOW + 20 * 60_000): PinnacleFixture {
  return {
    providerMatchId: sid,
    league: "Research League",
    homeTeam: "Crown Home",
    awayTeam: "Crown Away",
    kickoffUtc,
    statusText: "scheduled",
    homeScore: null,
    awayScore: null,
    halfHome: null,
    halfAway: null,
    handicapVal: null,
    totalVal: null,
  };
}

const crownPrices: ProviderPrice[] = [
  { market: "AH", lineValue: -0.5, isMain: true, selection: "H", decimalOdds: 1.91 },
  { market: "AH", lineValue: -0.5, isMain: true, selection: "A", decimalOdds: 1.99 },
  { market: "OU", lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 1.93 },
  { market: "OU", lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 1.97 },
];

function cleanup(): void {
  const ids = (rawDb.prepare(
    "SELECT id FROM matches WHERE id LIKE ? OR titan_id LIKE ?",
  ).all(`${PREFIX}%`, `${PREFIX}%`) as Array<{ id: string }>).map((row) => row.id);
  for (const table of [
    "odds_latest",
    "odds_snapshots",
    "market_lines",
    "opportunities",
    "simulation_bets",
    "research_timeline_snapshots",
    "research_timeline_points",
    "research_results",
    "ou_signal_prealerts",
    "ou_signal_observations",
    "pinnacle_source_map",
    "match_mapping",
  ]) {
    for (const id of ids) rawDb.prepare(`DELETE FROM ${table} WHERE match_id=?`).run(id);
  }
  for (const id of ids) rawDb.prepare("DELETE FROM matches WHERE id=?").run(id);
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("Crown-only research fixtures", () => {
  it("inserts unmatched Titan fixtures once and respects an HKJC claim", () => {
    const sid = `${PREFIX}-upsert`;
    expect(upsertCrownResearchFixtures([fixture(sid)], NOW)).toBe(1);
    expect(upsertCrownResearchFixtures([fixture(sid)], NOW + 1)).toBe(0);
    expect(rawDb.prepare(
      "SELECT id,hkjc_id,fixture_source,titan_id FROM matches WHERE titan_id=?",
    ).get(sid)).toEqual({
      id: `crown:${sid}`,
      hkjc_id: null,
      fixture_source: "crown",
      titan_id: sid,
    });

    const claimedSid = `${PREFIX}-claimed`;
    rawDb.prepare(
      `INSERT INTO matches(
        id,hkjc_id,fixture_source,titan_id,league,home_team,away_team,kickoff_utc,status,inplay,updated_at
      ) VALUES(?,?,'hkjc',?, 'L','H','A',?,'PREEVENT',0,?)`,
    ).run(`${PREFIX}-hkjc-claimed`, "claimed", claimedSid, NOW + 30_000, NOW);
    expect(upsertCrownResearchFixtures([fixture(claimedSid)], NOW)).toBe(0);
    expect(rawDb.prepare("SELECT COUNT(*) count FROM matches WHERE titan_id=?").get(claimedSid))
      .toEqual({ count: 1 });
  });

  it("enforces one active row per Titan identity", () => {
    const sid = `${PREFIX}-unique`;
    upsertCrownResearchFixtures([fixture(sid)], NOW);
    expect(() => rawDb.prepare(
      `INSERT INTO matches(
        id,hkjc_id,fixture_source,titan_id,league,home_team,away_team,kickoff_utc,status,inplay,updated_at
      ) VALUES(?,NULL,'crown',?,'L','H','A',?,'PREEVENT',0,?)`,
    ).run(`${PREFIX}-duplicate`, sid, NOW, NOW)).toThrow();
  });

  it("reconciles Crown-first data into one HKJC canonical fixture", () => {
    const sid = `${PREFIX}-merge`;
    const crownId = `crown:${sid}`;
    const hkjcId = `${PREFIX}-hkjc-merge`;
    upsertCrownResearchFixtures([fixture(sid)], NOW);
    saveCrownResearchInitialSnapshots(
      crownId,
      sid,
      crownPrices,
      { AH: "https://example.test/ah", OU: "https://example.test/ou" },
      NOW - 60_000,
    );
    captureResearchTimelinePrices(crownId, "crown", crownPrices, NOW + 20 * 60_000, NOW);
    rawDb.prepare(
      `INSERT INTO research_results(
        match_id,hkjc_id,home_score,away_score,corners_total,source,result_source,source_match_id,fetched_at
      ) VALUES(?,NULL,2,1,NULL,'titan_test','titan007',?,?)`,
    ).run(crownId, sid, NOW);
    rawDb.prepare(
      `INSERT INTO matches(
        id,hkjc_id,fixture_source,titan_id,league,home_team,away_team,kickoff_utc,status,inplay,updated_at
      ) VALUES(?,?,'hkjc',NULL,'L','H','A',?,'PREEVENT',0,?)`,
    ).run(hkjcId, "HK1", NOW + 20 * 60_000, NOW);

    expect(reconcileCrownFixtureIntoHkjc(hkjcId, sid)).toBe(true);
    expect(rawDb.prepare("SELECT COUNT(*) count FROM matches WHERE titan_id=?").get(sid))
      .toEqual({ count: 1 });
    expect(rawDb.prepare("SELECT fixture_source FROM matches WHERE id=?").get(hkjcId))
      .toEqual({ fixture_source: "hkjc" });
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM research_timeline_snapshots WHERE match_id=?",
    ).get(hkjcId)).toEqual({ count: 8 });
    expect(rawDb.prepare("SELECT source_match_id FROM research_results WHERE match_id=?").get(hkjcId))
      .toEqual({ source_match_id: sid });
    expect(rawDb.prepare("SELECT 1 FROM matches WHERE id=?").get(crownId)).toBeUndefined();
  });

  it("captures Crown-only checkpoints, provenance, results, and canonical exports", async () => {
    const sid = `${PREFIX}-dataset`;
    const matchId = `crown:${sid}`;
    upsertCrownResearchFixtures([fixture(sid)], NOW);
    expect(expectedPairCount(matchId, "T30")).toBe(2);
    expect(captureResearchTimelinePrices(matchId, "crown", crownPrices, NOW + 20 * 60_000, NOW)).toBe(4);
    expect(captureResearchTimelinePrices(matchId, "crown", crownPrices, NOW + 20 * 60_000, NOW + 10 * 60_000)).toBe(4);
    expect(captureResearchTimelinePrices(matchId, "crown", crownPrices, NOW + 20 * 60_000, NOW + 18 * 60_000)).toBe(4);
    saveCrownResearchInitialSnapshots(
      matchId,
      sid,
      crownPrices,
      { AH: "https://example.test/ah", OU: "https://example.test/ou" },
      NOW,
    );
    saveCrownResearchInitialSnapshots(
      matchId,
      sid,
      crownPrices.map((price) => ({ ...price, decimalOdds: 9.99 })),
      { AH: "https://example.test/new-ah", OU: "https://example.test/new-ou" },
      NOW + 1,
    );
    const opening = rawDb.prepare(
      `SELECT decimal_odds,source_name,source_match_id,source_url
         FROM research_timeline_snapshots
        WHERE match_id=? AND provider='crown' AND stage='initial' AND market='AH' AND selection='H'`,
    ).get(matchId);
    expect(opening).toEqual({
      decimal_odds: 1.91,
      source_name: "titan007-crown",
      source_match_id: sid,
      source_url: "https://example.test/ah",
    });

    rawDb.prepare("UPDATE matches SET kickoff_utc=? WHERE id=?").run(NOW - 2 * 60 * 60_000, matchId);
    const outcome = await collectResearchResults(
      { fetchHistoricResults: vi.fn(async () => []) } as never,
      NOW,
      {
        fetchResults: vi.fn(async () => [{
          providerMatchId: sid,
          league: "Research League",
          homeTeam: "Crown Home",
          awayTeam: "Crown Away",
          kickoffUtc: NOW - 2 * 60 * 60_000,
          homeScore: 3,
          awayScore: 2,
          source: "titan_test",
        }]),
      },
    );
    expect(outcome.collected).toBeGreaterThanOrEqual(1);
    const dataset = researchDataset({ days: 7, provider: "all", market: "all" }, NOW);
    const row = dataset.matches.find((match) => match.matchId === matchId)!;
    expect(row).toMatchObject({
      fixtureKey: `titan:${sid}`,
      fixtureSource: "crown",
      titanId: sid,
      hkjcId: null,
      result: { homeScore: 3, awayScore: 2 },
    });
    expect(row.timeline.T30.status).toBe("captured");
    expect(row.timeline.T30.cells.hkjc.AH).toBe("source_unavailable");
    expect(row.timeline.T30.cells.pinnacle.OU).toBe("source_unavailable");
    expect(row.timeline.T30.cells.crown.COU).toBe("source_unavailable");
    expect(researchCsv("timeline", { days: 7, provider: "all", market: "all" }, NOW))
      .toContain(`titan:${sid}`);
    expect(researchCsv("results", { days: 7, provider: "all", market: "all" }, NOW))
      .toContain("titan007");
  });

  it("keeps Crown-only research out of execution, signals, and Telegram queues", async () => {
    const sid = `${PREFIX}-isolated`;
    const matchId = `crown:${sid}`;
    upsertCrownResearchFixtures([fixture(sid, Date.now() + 20 * 60_000)], Date.now());
    const engine = new RadarEngine();
    (engine as any).refreshHkjc = vi.fn(async () => true);
    (engine as any).refreshPinnacleFixtures = vi.fn(async () => 1);
    (engine as any).pinnacle.fetchCrownResearchPrices = vi.fn(async () => ({
        opening: crownPrices,
        current: crownPrices,
        sourceUrls: { AH: "https://example.test/ah", OU: "https://example.test/ou" },
      }));
    const outcome = await engine.runResearchTimelineTick();
    expect(outcome.selected).toBeGreaterThanOrEqual(1);
    expect((engine as any).scanCandidates().some((row: { matchId: string }) => row.matchId === matchId)).toBe(false);
    expect(engine.buildDashboardData().matches.some((row) => row.id === matchId)).toBe(false);
    await expect(engine.refreshMatch(matchId)).rejects.toThrow("MATCH_NOT_FOUND");

    syncOuSignalPrealerts([matchId]);
    syncOuSignalObservations([matchId]);
    expect(unsentOuPrealerts([matchId])).toEqual([]);
    expect(unsentOuSignals([matchId])).toEqual([]);
    for (const table of [
      "odds_latest",
      "odds_snapshots",
      "market_lines",
      "opportunities",
      "simulation_bets",
      "ou_signal_prealerts",
      "ou_signal_observations",
    ]) {
      expect(rawDb.prepare(`SELECT COUNT(*) count FROM ${table} WHERE match_id=?`).get(matchId))
        .toEqual({ count: 0 });
    }
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM research_timeline_snapshots WHERE match_id=?",
    ).get(matchId)).toEqual({ count: 8 });
  });
});
