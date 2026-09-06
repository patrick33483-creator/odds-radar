import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const dbPath = `/tmp/odds-radar-hkjc-only-${process.pid}.db`;
process.env.RADAR_DB = dbPath;
process.env.RADAR_HKJC_ONLY = "1";
process.env.RADAR_RESEARCH_RESULTS = "1";

let RadarEngine: typeof import("../server/lib/engine").RadarEngine;
let rawDb: typeof import("../server/lib/store").rawDb;
let migrate: typeof import("../server/lib/store").migrate;
let collectResearchResults: typeof import("../server/lib/research").collectResearchResults;
let syncOuSignalObservations:
  typeof import("../server/lib/ou-signals").syncOuSignalObservations;
let syncOuSignalPrealerts:
  typeof import("../server/lib/ou-signals").syncOuSignalPrealerts;

const NOW = 1_900_000_000_000;

beforeAll(async () => {
  const store = await import("../server/lib/store");
  const research = await import("../server/lib/research");
  const signals = await import("../server/lib/ou-signals");
  ({ RadarEngine } = await import("../server/lib/engine"));
  rawDb = store.rawDb;
  migrate = store.migrate;
  collectResearchResults = research.collectResearchResults;
  syncOuSignalObservations = signals.syncOuSignalObservations;
  syncOuSignalPrealerts = signals.syncOuSignalPrealerts;
  store.migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const table of [
    "ou_signal_prealerts",
    "ou_signal_observations",
    "research_timeline_snapshots",
    "research_timeline_points",
    "research_results",
    "pinnacle_source_map",
    "matches",
  ]) {
    rawDb.prepare(`DELETE FROM ${table}`).run();
  }
});

afterAll(() => {
  rawDb.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { rmSync(`${dbPath}${suffix}`); } catch { /* SQLite sidecar optional. */ }
  }
});

function addFixture(
  id: string,
  source: "hkjc" | "pinnacle" | "crown",
  kickoffUtc: number,
  homeTeam = "主隊",
  awayTeam = "客隊",
): void {
  const providerId = id.replace(/^(?:pinnacle|crown):/, "");
  rawDb.prepare(
    `INSERT INTO matches(
      id,hkjc_id,fixture_source,titan_id,pinnacle_match_id,league,home_team,away_team,
      kickoff_utc,status,inplay,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,'PREEVENT',0,?)`,
  ).run(
    id,
    source === "hkjc" ? providerId : null,
    source,
    source === "hkjc" ? null : providerId,
    source === "hkjc" ? `pinnapi:${providerId}` : `titan:${providerId}`,
    "測試聯賽",
    homeTeam,
    awayTeam,
    kickoffUtc,
    NOW,
  );
}

function currentAhOu() {
  return [
    { market: "AH" as const, lineValue: -0.25, isMain: true, selection: "H" as const, decimalOdds: 1.91 },
    { market: "AH" as const, lineValue: -0.25, isMain: true, selection: "A" as const, decimalOdds: 1.97 },
    { market: "OU" as const, lineValue: 2.5, isMain: true, selection: "O" as const, decimalOdds: 1.89 },
    { market: "OU" as const, lineValue: 2.5, isMain: true, selection: "U" as const, decimalOdds: 1.99 },
  ];
}

function addOuStage(
  matchId: string,
  stage: "initial" | "T30" | "T5",
  over: number,
  under: number,
): void {
  const insert = rawDb.prepare(
    `INSERT INTO research_timeline_snapshots(
      match_id,provider,market,stage,line_key,selection,decimal_odds,is_main,
      captured_at,status,origin,source_name
    ) VALUES(?,'pinnacle','OU',?,'2.5',?,?,1,?,'captured','test','test')`,
  );
  insert.run(matchId, stage, "O", over, NOW);
  insert.run(matchId, stage, "U", under, NOW);
}

describe("HKJC-only production scope", () => {
  it("keeps the standalone discovery collector inert", async () => {
    addFixture("pinnacle:dormant", "pinnacle", NOW + 20 * 60_000);
    const engine = new RadarEngine();
    const titanFetch = vi.fn();
    const pinnapiFetch = vi.fn();
    (engine as any).pinnacle.fetchPinnacleResearchPrices = titanFetch;
    (engine as any).pinnapi.fetchMatchPrices = pinnapiFetch;

    await expect(engine.refreshPinnacleOnlyResearch(NOW)).resolves.toEqual({
      fixtures: 0,
      fetched: 0,
      failed: 0,
      rows: 0,
    });
    expect(titanFetch).not.toHaveBeenCalled();
    expect(pinnapiFetch).not.toHaveBeenCalled();
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM research_timeline_snapshots",
    ).get()).toEqual({ count: 0 });
  });

  it("makes the lower milestone worker a no-op for persisted standalone fixtures", async () => {
    addFixture("pinnacle:old-crown", "pinnacle", NOW + 4 * 60_000);
    const engine = new RadarEngine();
    const titanFetch = vi.fn();
    (engine as any).pinnacle.fetchPinnacleResearchPrices = titanFetch;
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    await expect(engine.runResearchLowerMilestoneTick()).resolves.toMatchObject({
      selected: 0,
      selectedHkjcPinnacle: 0,
      selectedPinnacleCrown: 0,
      attempted: 0,
      fetched: 0,
      rows: 0,
    });
    expect(titanFetch).not.toHaveBeenCalled();
  });

  it("retains old standalone rows and maps Titan IDs through the HKJC source map", async () => {
    addFixture("crown:retained", "crown", NOW + 20 * 60_000, "甲隊", "乙隊");
    addFixture("hkjc:target", "hkjc", NOW + 20 * 60_000, "甲隊", "乙隊");
    addOuStage("crown:retained", "T30", 1.91, 1.99);
    rawDb.prepare(
      `INSERT INTO research_results(
        match_id,hkjc_id,home_score,away_score,corners_total,source,result_source,fetched_at
      ) VALUES('crown:retained',NULL,2,1,NULL,'legacy','legacy',?)`,
    ).run(NOW - 60_000);
    const engine = new RadarEngine();
    (engine as any).fixtureCache = {
      at: NOW,
      pinnapi: [],
      optic: [],
      titan: [{
        providerMatchId: "retained",
        league: "測試聯賽",
        homeTeam: "甲隊",
        awayTeam: "乙隊",
        kickoffUtc: NOW + 20 * 60_000,
        statusText: "PREEVENT",
        homeScore: null,
        awayScore: null,
        halfHome: null,
        halfAway: null,
        handicapVal: -0.25,
        totalVal: 2.5,
      }],
    };
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    await expect((engine as any).refreshPinnacleFixtures()).resolves.toBe(1);
    expect(rawDb.prepare(
      "SELECT fixture_source,titan_id FROM matches WHERE id='crown:retained'",
    ).get()).toEqual({ fixture_source: "crown", titan_id: "retained" });
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM research_timeline_snapshots WHERE match_id='crown:retained'",
    ).get()).toEqual({ count: 2 });
    expect(rawDb.prepare(
      "SELECT titan_id FROM matches WHERE id='hkjc:target'",
    ).get()).toEqual({ titan_id: null });
    expect(rawDb.prepare(
      "SELECT titan_id,active_source FROM pinnacle_source_map WHERE match_id='hkjc:target'",
    ).get()).toEqual({ titan_id: "retained", active_source: "titan007" });

    expect(() => migrate()).not.toThrow();
    expect(rawDb.prepare(
      "SELECT id,fixture_source,titan_id FROM matches ORDER BY id",
    ).all()).toEqual([
      { id: "crown:retained", fixture_source: "crown", titan_id: "retained" },
      { id: "hkjc:target", fixture_source: "hkjc", titan_id: null },
    ]);
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM research_timeline_snapshots WHERE match_id='crown:retained'",
    ).get()).toEqual({ count: 2 });
    expect(rawDb.prepare(
      "SELECT home_score,away_score,result_source FROM research_results WHERE match_id='crown:retained'",
    ).get()).toEqual({ home_score: 2, away_score: 1, result_source: "legacy" });
    expect(rawDb.prepare(
      "SELECT titan_id,active_source FROM pinnacle_source_map WHERE match_id='hkjc:target'",
    ).get()).toEqual({ titan_id: "retained", active_source: "titan007" });
  });

  it("isolates retained-ID collisions so every HKJC fixture can still map", async () => {
    addFixture("pinnacle:owned", "pinnacle", NOW + 20 * 60_000, "甲隊", "乙隊");
    addFixture("hkjc:first", "hkjc", NOW + 20 * 60_000, "甲隊", "乙隊");
    addFixture("hkjc:second", "hkjc", NOW + 10 * 60_000, "丙隊", "丁隊");
    const engine = new RadarEngine();
    (engine as any).fixtureCache = {
      at: NOW,
      pinnapi: [],
      optic: [],
      titan: [
        {
          providerMatchId: "owned",
          league: "測試聯賽",
          homeTeam: "甲隊",
          awayTeam: "乙隊",
          kickoffUtc: NOW + 20 * 60_000,
          statusText: "PREEVENT",
          homeScore: null,
          awayScore: null,
          halfHome: null,
          halfAway: null,
          handicapVal: -0.25,
          totalVal: 2.5,
        },
        {
          providerMatchId: "fresh",
          league: "測試聯賽",
          homeTeam: "丙隊",
          awayTeam: "丁隊",
          kickoffUtc: NOW + 10 * 60_000,
          statusText: "PREEVENT",
          homeScore: null,
          awayScore: null,
          halfHome: null,
          halfAway: null,
          handicapVal: -0.25,
          totalVal: 2.5,
        },
      ],
    };
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    await expect((engine as any).refreshPinnacleFixtures()).resolves.toBe(2);
    expect(rawDb.prepare(
      "SELECT match_id,titan_id FROM pinnacle_source_map ORDER BY match_id",
    ).all()).toEqual([
      { match_id: "hkjc:first", titan_id: "owned" },
      { match_id: "hkjc:second", titan_id: "fresh" },
    ]);
    expect(rawDb.prepare(
      "SELECT id,titan_id FROM matches WHERE id LIKE 'hkjc:%' ORDER BY id",
    ).all()).toEqual([
      { id: "hkjc:first", titan_id: null },
      { id: "hkjc:second", titan_id: null },
    ]);
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM matches WHERE id='pinnacle:owned'",
    ).get()).toEqual({ count: 1 });
  });

  it("still captures Pinnacle AH and OU for HKJC fixtures at T30, T15 and T5", async () => {
    const stages = [
      ["hkjc:t30", 20, "T30"],
      ["hkjc:t15", 10, "T15"],
      ["hkjc:t5", 4, "T5"],
    ] as const;
    for (const [id, minutes] of stages) {
      addFixture(id, "hkjc", NOW + minutes * 60_000, `${id}主`, `${id}客`);
      rawDb.prepare(
        `INSERT INTO pinnacle_source_map(
          match_id,pinnapi_id,pinnapi_reversed,optic_id,optic_reversed,
          titan_id,titan_reversed,active_source,updated_at
        ) VALUES(?,?,0,NULL,0,NULL,0,'pinnapi',?)`,
      ).run(id, id.slice(5), NOW);
    }
    const engine = new RadarEngine();
    (engine as any).pinnapi.fetchMatchPrices = vi.fn().mockResolvedValue(currentAhOu());
    (engine as any).pinnacle.fetchPinnacleResearchPrices = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(NOW);

    await expect(engine.runResearchMilestoneTick()).resolves.toMatchObject({
      selected: 3,
      selectedHkjcPinnacle: 3,
      selectedPinnacleCrown: 0,
      fetched: 3,
      failed: 0,
      rows: 12,
    });
    expect(rawDb.prepare(
      `SELECT match_id,stage,market,COUNT(*) rows
         FROM research_timeline_snapshots
        GROUP BY match_id,stage,market
        ORDER BY match_id,market`,
    ).all()).toEqual([
      { match_id: "hkjc:t15", stage: "T15", market: "AH", rows: 2 },
      { match_id: "hkjc:t15", stage: "T15", market: "OU", rows: 2 },
      { match_id: "hkjc:t30", stage: "T30", market: "AH", rows: 2 },
      { match_id: "hkjc:t30", stage: "T30", market: "OU", rows: 2 },
      { match_id: "hkjc:t5", stage: "T5", market: "AH", rows: 2 },
      { match_id: "hkjc:t5", stage: "T5", market: "OU", rows: 2 },
    ]);
  });

  it("does not fetch or overwrite standalone Crown/Pinnacle results", async () => {
    addFixture("crown:historic", "crown", NOW - 2 * 60 * 60_000);
    rawDb.prepare(
      `INSERT INTO research_results(
        match_id,hkjc_id,home_score,away_score,corners_total,source,result_source,fetched_at
      ) VALUES('crown:historic',NULL,2,1,NULL,'legacy','legacy',?)`,
    ).run(NOW - 60_000);
    const webFetch = vi.fn();
    vi.stubGlobal("fetch", webFetch);

    await expect(collectResearchResults({
      fetchHistoricResults: async () => [],
    } as never, NOW)).resolves.toEqual({ candidates: 0, collected: 0 });
    expect(webFetch).not.toHaveBeenCalled();
    expect(rawDb.prepare(
      "SELECT home_score,away_score,result_source FROM research_results WHERE match_id=?",
    ).get("crown:historic")).toEqual({
      home_score: 2,
      away_score: 1,
      result_source: "legacy",
    });
  });

  it("does not create signals or prealerts from old standalone snapshots", () => {
    const matchId = "pinnacle:old-signal";
    addFixture(matchId, "pinnacle", NOW + 30 * 60_000);
    addOuStage(matchId, "initial", 1.90, 1.80);
    addOuStage(matchId, "T30", 1.78, 1.96);
    addOuStage(matchId, "T5", 1.84, 2.00);

    expect(syncOuSignalPrealerts([matchId])).toBe(0);
    expect(syncOuSignalObservations([matchId])).toBe(0);
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM ou_signal_prealerts WHERE match_id=?",
    ).get(matchId)).toEqual({ count: 0 });
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM ou_signal_observations WHERE match_id=?",
    ).get(matchId)).toEqual({ count: 0 });
  });
});
