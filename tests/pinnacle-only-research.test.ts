import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const dbPath = `/tmp/odds-radar-pinnacle-only-${process.pid}.db`;
process.env.RADAR_DB = dbPath;

let rawDb: typeof import("../server/lib/store").rawDb;
let captureResearchTimelinePrices: typeof import("../server/lib/research").captureResearchTimelinePrices;
let researchDataset: typeof import("../server/lib/research").researchDataset;
let researchCsv: typeof import("../server/lib/research").researchCsv;
let expectedPairCount: typeof import("../server/lib/research").expectedPairCount;
let syncOuSignalObservations: typeof import("../server/lib/ou-signals").syncOuSignalObservations;
let syncOuSignalPrealerts: typeof import("../server/lib/ou-signals").syncOuSignalPrealerts;
let unsentOuSignals: typeof import("../server/lib/ou-signals").unsentOuSignals;
let unsentOuPrealerts: typeof import("../server/lib/ou-signals").unsentOuPrealerts;
let markOuSignalNotified: typeof import("../server/lib/ou-signals").markOuSignalNotified;
let OU_SIGNAL_RULES: typeof import("../server/lib/ou-signals").OU_SIGNAL_RULES;
let buildOuSignalMessage: typeof import("../server/lib/telegram").buildOuSignalMessage;

beforeAll(async () => {
  const store = await import("../server/lib/store");
  const research = await import("../server/lib/research");
  const signals = await import("../server/lib/ou-signals");
  const telegram = await import("../server/lib/telegram");
  rawDb = store.rawDb;
  captureResearchTimelinePrices = research.captureResearchTimelinePrices;
  researchDataset = research.researchDataset;
  researchCsv = research.researchCsv;
  expectedPairCount = research.expectedPairCount;
  syncOuSignalObservations = signals.syncOuSignalObservations;
  syncOuSignalPrealerts = signals.syncOuSignalPrealerts;
  unsentOuSignals = signals.unsentOuSignals;
  unsentOuPrealerts = signals.unsentOuPrealerts;
  markOuSignalNotified = signals.markOuSignalNotified;
  OU_SIGNAL_RULES = signals.OU_SIGNAL_RULES;
  buildOuSignalMessage = telegram.buildOuSignalMessage;
  store.migrate();
});

afterAll(() => {
  rawDb.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { rmSync(`${dbPath}${suffix}`); } catch {
      // sidecar files may not exist
    }
  }
});

afterEach(() => {
  // Tests share the same sqlite file; wipe the tables that this suite writes
  // so each case starts from an empty slate.  The signal-notification
  // activation watermark stays as migrate() set it.
  rawDb.prepare("DELETE FROM ou_signal_observations").run();
  rawDb.prepare("DELETE FROM ou_signal_prealerts").run();
  rawDb.prepare("DELETE FROM research_timeline_snapshots").run();
  rawDb.prepare("DELETE FROM research_timeline_points").run();
  rawDb.prepare("DELETE FROM odds_latest").run();
  rawDb.prepare("DELETE FROM odds_snapshots").run();
  rawDb.prepare("DELETE FROM market_lines").run();
  rawDb.prepare("DELETE FROM opportunities").run();
  rawDb.prepare("DELETE FROM simulation_bets").run();
  rawDb.prepare("DELETE FROM pinnacle_source_map").run();
  rawDb.prepare("DELETE FROM matches").run();
  rawDb.prepare("DELETE FROM pinnacle_translations").run();
});

type Side = "O" | "U";
type Stage = "initial" | "T30" | "T15" | "T5";

function addPinnacleOnlyFixture(id: string, kickoff: number): void {
  const titanId = id.replace(/^pinnacle:(?:titan:)?/, "");
  rawDb.prepare(
    `INSERT INTO matches(
      id,hkjc_id,fixture_source,titan_id,pinnacle_match_id,
      league,league_en,home_team,away_team,home_team_en,away_team_en,
      kickoff_utc,status,inplay,updated_at
    ) VALUES(?,NULL,'pinnacle',?,?, 'Pinn聯', NULL, ?, ?, NULL, NULL, ?, 'PREEVENT', 0, ?)`,
  ).run(id, titanId, `titan:${titanId}`, `${id}主`, `${id}客`, kickoff, Date.now());
}

function addHkjcFixture(id: string, kickoff: number): void {
  rawDb.prepare(
    `INSERT INTO matches(
      id,hkjc_id,fixture_source,league,home_team,away_team,kickoff_utc,status,inplay,updated_at
    ) VALUES(?,?, 'hkjc','HK聯',?,?,?,'PREEVENT',0,?)`,
  ).run(id, id.replace(/\D/g, "") || id, `${id}主`, `${id}客`, kickoff, Date.now());
}

function addStage(
  matchId: string,
  provider: "hkjc" | "pinnacle",
  stage: Stage,
  lineKey: string,
  over: number,
  under: number,
  capturedAt: number,
  market: "OU" | "AH" = "OU",
): void {
  const insert = rawDb.prepare(
    `INSERT INTO research_timeline_snapshots(
      match_id,provider,market,stage,line_key,selection,decimal_odds,is_main,
      captured_at,status,origin,source_name
    ) VALUES(?,?,?,?,?,?,?,1,?,'captured','test','test')`,
  );
  const sides: Array<[string, number]> = market === "OU"
    ? [["O", over], ["U", under]]
    : [["H", over], ["A", under]];
  for (const [selection, odds] of sides) {
    insert.run(matchId, provider, market, stage, lineKey, selection, odds, capturedAt);
  }
}

// Anchor tests slightly in the future so seeded detected_at values are always
// AFTER the migration-set ou_signal_prealert_activated_at watermark, and so
// kickoff-relative windows land in the correct research stage.
const NOW = Date.now() + 5 * 60_000;

describe("Pinnacle-only fixture identity + snapshots", () => {
  it("builds the fixture from Titan Chinese labels and fetches Pinnacle by Titan sId", async () => {
    const { RadarEngine } = await import("../server/lib/engine");
    const kickoff = NOW + 25 * 60_000;
    const radar = new RadarEngine();
    (radar as any).fixtureCache = {
      at: NOW,
      pinnapi: [{
        providerMatchId: "english-index-only",
        league: "Israel Liga Alef",
        homeTeam: "Kfar Saba 1928",
        awayTeam: "MS Jerusalem",
        kickoffUtc: kickoff,
        inplay: false,
        status: "scheduled",
        parentId: null,
      }],
      optic: [],
      titan: [{
        providerMatchId: "3085481",
        league: "以色列甲組聯賽",
        homeTeam: "卡法沙巴1928",
        awayTeam: "耶路撒冷體育會",
        kickoffUtc: kickoff,
        statusText: "未開賽",
        homeScore: null,
        awayScore: null,
        halfHome: null,
        halfAway: null,
        handicapVal: 0.25,
        totalVal: null,
      }],
    };
    (radar as any).pinnacle.fetchPinnacleResearchPrices = vi.fn(async (sId: string) => {
      expect(sId).toBe("3085481");
      const prices = [
        { market: "OU", lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 1.91 },
        { market: "OU", lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 1.93 },
      ];
      return {
        opening: prices,
        current: prices,
        sourceUrls: { AH: "https://example.test/ah", OU: "https://example.test/ou" },
      };
    });

    const outcome = await radar.refreshPinnacleOnlyResearch(NOW);
    expect(outcome.fetched).toBe(1);
    const row = rawDb.prepare(
      "SELECT id,titan_id,league,home_team,away_team FROM matches WHERE id=?",
    ).get("pinnacle:titan:3085481") as Record<string, unknown>;
    expect(row).toMatchObject({
      titan_id: "3085481",
      league: "以色列甲組聯賽",
      home_team: "卡法沙巴1928",
      away_team: "耶路撒冷體育會",
    });
    expect(
      rawDb.prepare("SELECT COUNT(*) c FROM pinnacle_translations").get(),
    ).toEqual({ c: 0 });
  });

  it("does not drop a Titan fixture when PinnAPI has no matching kickoff time", async () => {
    const { RadarEngine } = await import("../server/lib/engine");
    const kickoff = NOW + 25 * 60_000;
    const radar = new RadarEngine();
    (radar as any).fixtureCache = {
      at: NOW,
      pinnapi: [{
        providerMatchId: "different-event",
        league: "Different league",
        homeTeam: "Different home",
        awayTeam: "Different away",
        kickoffUtc: kickoff + 4 * 60 * 60_000,
      }],
      optic: [],
      titan: [{
        providerMatchId: "3085657",
        league: "土U19聯",
        homeTeam: "伊斯坦堡U19",
        awayTeam: "加拉塔沙雷U19",
        kickoffUtc: kickoff,
        statusText: "PREEVENT",
        homeScore: null,
        awayScore: null,
        halfHome: null,
        halfAway: null,
        handicapVal: 0.25,
        totalVal: null,
      }],
    };
    const fetchResearchPrices = vi.fn().mockResolvedValue({
      opening: [
        { market: "OU", lineValue: 3.25, isMain: true, selection: "O", decimalOdds: 1.92 },
        { market: "OU", lineValue: 3.25, isMain: true, selection: "U", decimalOdds: 1.83 },
      ],
      current: [
        { market: "OU", lineValue: 3.25, isMain: true, selection: "O", decimalOdds: 1.92 },
        { market: "OU", lineValue: 3.25, isMain: true, selection: "U", decimalOdds: 1.83 },
      ],
      sourceUrls: { AH: "https://example.test/ah", OU: "https://example.test/ou" },
    });
    (radar as any).pinnacle.fetchPinnacleResearchPrices = fetchResearchPrices;

    const outcome = await radar.refreshPinnacleOnlyResearch(NOW);
    expect(outcome.fetched).toBe(1);
    expect(fetchResearchPrices).toHaveBeenCalledWith("3085657");
    expect(rawDb.prepare(
      "SELECT league,home_team,away_team FROM matches WHERE id='pinnacle:titan:3085657'",
    ).get()).toEqual({
      league: "土U19聯",
      home_team: "伊斯坦堡U19",
      away_team: "加拉塔沙雷U19",
    });
    expect(rawDb.prepare(
      `SELECT DISTINCT origin,source_name,source_match_id
         FROM research_timeline_snapshots
        WHERE match_id='pinnacle:titan:3085657' AND stage='initial'`,
    ).all()).toEqual([{
      origin: "external_opening",
      source_name: "titan007-pinnacle",
      source_match_id: "3085657",
    }]);
  });

  it("uses a safely mapped PinnAPI current quote when Titan omits company 47 and reuses the mapping", async () => {
    const { RadarEngine } = await import("../server/lib/engine");
    const kickoff = NOW + 25 * 60_000;
    const matchId = "pinnacle:titan:company47-missing";
    const radar = new RadarEngine();
    const titanFixture = {
      providerMatchId: "company47-missing",
      league: "測試聯賽",
      homeTeam: "中文主隊甲",
      awayTeam: "中文客隊乙",
      kickoffUtc: kickoff,
      statusText: "未開賽",
      homeScore: null,
      awayScore: null,
      halfHome: null,
      halfAway: null,
      handicapVal: 0.25,
      totalVal: 2.5,
    };
    (radar as any).fixtureCache = {
      at: NOW,
      pinnapi: [{
        providerMatchId: "pinnapi-safe-event",
        league: "Test League",
        homeTeam: "English Home Alpha",
        awayTeam: "English Away Beta",
        kickoffUtc: kickoff,
        inplay: false,
        status: "scheduled",
        parentId: null,
      }],
      optic: [],
      titan: [titanFixture],
    };
    const insertAlias = rawDb.prepare(
      "INSERT OR REPLACE INTO team_aliases(canonical,alias,provider,confirmed_at) VALUES(?,?,?,?)",
    );
    insertAlias.run("fallback-home", "中文主甲", "hkjc", NOW);
    insertAlias.run("fallback-home", "englishhomealpha", "pinnacle", NOW);
    insertAlias.run("fallback-away", "中文客乙", "hkjc", NOW);
    insertAlias.run("fallback-away", "englishawaybeta", "pinnacle", NOW);

    const fetchTitan = vi.fn().mockResolvedValue({
      opening: [],
      current: [],
      sourceUrls: { AH: "https://example.test/ah", OU: "https://example.test/ou" },
    });
    const fetchPinnapi = vi.fn().mockResolvedValue([
      { market: "OU", lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 1.91 },
      { market: "OU", lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 1.93 },
    ]);
    (radar as any).pinnacle.fetchPinnacleResearchPrices = fetchTitan;
    (radar as any).pinnapi.fetchMatchPrices = fetchPinnapi;

    const t30 = await radar.refreshPinnacleOnlyResearch(NOW);
    expect(t30).toMatchObject({ fixtures: 1, fetched: 1, failed: 0, rows: 1 });
    expect(fetchPinnapi).toHaveBeenCalledWith("pinnapi-safe-event");
    expect(rawDb.prepare(
      "SELECT pinnapi_id,pinnapi_reversed,titan_id FROM pinnacle_source_map WHERE match_id=?",
    ).get(matchId)).toEqual({
      pinnapi_id: "pinnapi-safe-event",
      pinnapi_reversed: 0,
      titan_id: "company47-missing",
    });
    expect(rawDb.prepare(
      "SELECT league,home_team,away_team,league_en,home_team_en,away_team_en FROM matches WHERE id=?",
    ).get(matchId)).toEqual({
      league: "測試聯賽",
      home_team: "中文主隊甲",
      away_team: "中文客隊乙",
      league_en: null,
      home_team_en: null,
      away_team_en: null,
    });
    expect(rawDb.prepare(
      `SELECT DISTINCT provider,stage,origin,source_name,source_match_id FROM research_timeline_snapshots
        WHERE match_id=? ORDER BY stage`,
    ).all(matchId)).toEqual([{
      provider: "pinnacle",
      stage: "T30",
      origin: "live_observation",
      source_name: "pinnapi",
      source_match_id: "pinnapi-safe-event",
    }]);
    expect(rawDb.prepare(
      "SELECT COUNT(*) c FROM research_timeline_snapshots WHERE match_id=? AND provider='crown'",
    ).get(matchId)).toEqual({ c: 0 });
    expect(rawDb.prepare(
      "SELECT COUNT(*) c FROM research_timeline_snapshots WHERE match_id=? AND stage='initial'",
    ).get(matchId)).toEqual({ c: 0 });

    // The cached fixture list can rotate after mapping; the next milestone
    // still uses the persisted PinnAPI event id.
    (radar as any).fixtureCache = { at: NOW + 15 * 60_000, pinnapi: [], optic: [], titan: [titanFixture] };
    const t15 = await radar.refreshPinnacleOnlyResearch(NOW + 15 * 60_000);
    expect(t15).toMatchObject({ fixtures: 1, fetched: 1, failed: 0, rows: 1 });
    expect(fetchPinnapi).toHaveBeenCalledTimes(2);
    expect(rawDb.prepare(
      "SELECT DISTINCT stage FROM research_timeline_snapshots WHERE match_id=? ORDER BY stage",
    ).all(matchId)).toEqual([{ stage: "T15" }, { stage: "T30" }]);
    expect(rawDb.prepare(
      "SELECT COUNT(*) c FROM research_timeline_snapshots WHERE match_id=? AND stage='initial'",
    ).get(matchId)).toEqual({ c: 0 });
  });

  it("reconciles a Crown Chinese canonical row with a standalone PinnAPI row without split ownership", async () => {
    const { RadarEngine } = await import("../server/lib/engine");
    const kickoff = NOW + 25 * 60_000;
    const titanId = "crown-chinese-88001";
    const canonicalId = "crown:crown-chinese-88001";
    const pinnapiId = "pinnapi-english-99001";
    const standaloneId = `pinnacle:${pinnapiId}`;

    rawDb.prepare(
      `INSERT INTO matches(
        id,hkjc_id,fixture_source,titan_id,pinnacle_match_id,
        league,league_en,home_team,away_team,home_team_en,away_team_en,
        kickoff_utc,status,inplay,updated_at
      ) VALUES(?,NULL,'crown',?,NULL,
        '以色列甲組聯賽',NULL,'卡法沙巴1928','耶路撒冷體育會',NULL,NULL,
        ?,'PREEVENT',0,?)`,
    ).run(canonicalId, titanId, kickoff, NOW);
    rawDb.prepare(
      `INSERT INTO matches(
        id,hkjc_id,fixture_source,titan_id,pinnacle_match_id,
        league,league_en,home_team,away_team,home_team_en,away_team_en,
        kickoff_utc,status,inplay,updated_at
      ) VALUES(?,NULL,'pinnacle',NULL,?,
        'Israel Liga Alef',NULL,'Kfar Saba 1928','MS Jerusalem',NULL,NULL,
        ?,'PREEVENT',0,?)`,
    ).run(standaloneId, `pinnapi:${pinnapiId}`, kickoff, NOW);
    rawDb.prepare(
      `INSERT INTO pinnacle_source_map(
        match_id,pinnapi_id,pinnapi_reversed,optic_id,optic_reversed,
        titan_id,titan_reversed,active_source,updated_at
      ) VALUES(?,?,0,NULL,0,NULL,0,'pinnapi',?)`,
    ).run(standaloneId, pinnapiId, NOW);
    rawDb.prepare(
      `INSERT INTO pinnacle_translations(
        pinnapi_id,zh_home,zh_away,zh_league,source,updated_at,
        attempted_at,attempt_count,last_error
      ) VALUES(?,?,?,?, 'titan',?,?,1,NULL)`,
    ).run(
      pinnapiId,
      "卡法沙巴1928",
      "耶路撒冷體育會",
      "以色列甲組聯賽",
      NOW,
      NOW,
    );
    addStage(standaloneId, "pinnacle", "initial", "2.5", 1.90, 1.94, NOW - 60 * 60_000);
    rawDb.prepare(
      `UPDATE research_timeline_snapshots
          SET origin='external_opening',source_name='pinnapi-history',
              source_match_id=?
        WHERE match_id=? AND stage='initial'`,
    ).run(pinnapiId, standaloneId);

    const titanFixture = {
      providerMatchId: titanId,
      league: "以色列甲組聯賽",
      homeTeam: "卡法沙巴1928",
      awayTeam: "耶路撒冷體育會",
      kickoffUtc: kickoff,
      statusText: "未開賽",
      homeScore: null,
      awayScore: null,
      halfHome: null,
      halfAway: null,
      handicapVal: 0.25,
      totalVal: 2.5,
    };
    const radar = new RadarEngine();
    (radar as any).fixtureCache = {
      at: NOW,
      titan: [titanFixture],
      optic: [],
      pinnapi: [{
        providerMatchId: pinnapiId,
        league: "Israel Liga Alef",
        homeTeam: "Kfar Saba 1928",
        awayTeam: "MS Jerusalem",
        kickoffUtc: kickoff,
        inplay: false,
        status: "scheduled",
        parentId: null,
      }],
    };
    (radar as any).pinnacle.fetchPinnacleResearchPrices = vi.fn().mockResolvedValue({
      opening: [],
      current: [],
      sourceUrls: { AH: "", OU: "" },
    });
    const fetchPinnapi = vi.fn().mockResolvedValue([
      { market: "OU", lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 1.86 },
      { market: "OU", lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 2.02 },
    ]);
    (radar as any).pinnapi.fetchMatchPrices = fetchPinnapi;

    const outcome = await radar.refreshPinnacleOnlyResearch(NOW);
    expect(outcome).toMatchObject({ fixtures: 1, fetched: 1, failed: 0, rows: 1 });
    expect(fetchPinnapi).toHaveBeenCalledWith(pinnapiId);
    expect(rawDb.prepare(
      `SELECT fixture_source,titan_id,league,home_team,away_team
         FROM matches WHERE id=?`,
    ).get(canonicalId)).toEqual({
      fixture_source: "pinnacle",
      titan_id: titanId,
      league: "以色列甲組聯賽",
      home_team: "卡法沙巴1928",
      away_team: "耶路撒冷體育會",
    });
    expect(rawDb.prepare("SELECT COUNT(*) c FROM matches WHERE id=?").get(standaloneId))
      .toEqual({ c: 0 });
    expect(rawDb.prepare(
      `SELECT match_id,pinnapi_id,titan_id FROM pinnacle_source_map
        WHERE pinnapi_id=?`,
    ).all(pinnapiId)).toEqual([{
      match_id: canonicalId,
      pinnapi_id: pinnapiId,
      titan_id: titanId,
    }]);
    expect(rawDb.prepare(
      `SELECT DISTINCT stage,origin,source_name,source_match_id
         FROM research_timeline_snapshots
        WHERE match_id=? ORDER BY stage`,
    ).all(canonicalId)).toEqual([
      {
        stage: "T30",
        origin: "live_observation",
        source_name: "pinnapi",
        source_match_id: pinnapiId,
      },
      {
        stage: "initial",
        origin: "external_opening",
        source_name: "pinnapi-history",
        source_match_id: pinnapiId,
      },
    ]);
    expect(rawDb.prepare(
      "SELECT COUNT(*) c FROM research_timeline_snapshots WHERE match_id=?",
    ).get(standaloneId)).toEqual({ c: 0 });
    expect(rawDb.prepare(
      "SELECT COUNT(*) c FROM research_timeline_snapshots WHERE provider='crown'",
    ).get()).toEqual({ c: 0 });

    // Later collectors reuse the transferred provider id even when the
    // PinnAPI fixture index has rotated out of cache.
    (radar as any).fixtureCache = {
      at: NOW + 15 * 60_000,
      titan: [titanFixture],
      optic: [],
      pinnapi: [],
    };
    await radar.refreshPinnacleOnlyResearch(NOW + 15 * 60_000);
    expect(fetchPinnapi).toHaveBeenCalledTimes(2);
    expect(fetchPinnapi).toHaveBeenLastCalledWith(pinnapiId);
    expect(rawDb.prepare(
      `SELECT DISTINCT stage FROM research_timeline_snapshots
        WHERE match_id=? ORDER BY stage`,
    ).all(canonicalId)).toEqual([
      { stage: "T15" },
      { stage: "T30" },
      { stage: "initial" },
    ]);
    expect(rawDb.prepare(
      `SELECT COUNT(*) c FROM pinnacle_source_map WHERE pinnapi_id=?`,
    ).get(pinnapiId)).toEqual({ c: 1 });
  });

  it("shows a discovered Titan fixture as pending before its first quote arrives", () => {
    const kickoff = NOW + 20 * 60_000;
    addPinnacleOnlyFixture("pinnacle:titan:pending-3085657", kickoff);

    const dataset = researchDataset({
      window: "upcoming",
      days: 7,
      horizonDays: 1,
      provider: "pinnacle",
      market: "OU",
      limit: 300,
    }, NOW);

    expect(dataset.matches).toHaveLength(1);
    expect(dataset.matches[0]).toMatchObject({
      matchId: "pinnacle:titan:pending-3085657",
      fixtureSource: "pinnacle",
      snapshotCount: 0,
    });
    expect(dataset.matches[0].timeline.T30.status).toBe("missing");
  });

  it("creates a Pinnacle-only match row and captures live snapshots into T30/T15/T5 without touching execution tables", () => {
    const kickoff = NOW + 60 * 60_000;
    addPinnacleOnlyFixture("pinnacle:evt-100", kickoff);

    // >30 minutes out → recorded as initial (Pinnacle-only exemption)
    const initialAt = kickoff - 45 * 60_000;
    expect(captureResearchTimelinePrices(
      "pinnacle:evt-100",
      "pinnacle",
      [
        { market: "OU", lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 1.90 },
        { market: "OU", lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 1.95 },
      ],
      kickoff,
      initialAt,
    )).toBeGreaterThan(0);

    // T-30 window
    expect(captureResearchTimelinePrices(
      "pinnacle:evt-100",
      "pinnacle",
      [
        { market: "OU", lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 1.85 },
        { market: "OU", lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 2.00 },
      ],
      kickoff,
      kickoff - 25 * 60_000,
    )).toBeGreaterThan(0);

    // T-15 window
    captureResearchTimelinePrices(
      "pinnacle:evt-100",
      "pinnacle",
      [
        { market: "OU", lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 1.83 },
        { market: "OU", lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 2.02 },
      ],
      kickoff,
      kickoff - 10 * 60_000,
    );

    // T-5 window
    captureResearchTimelinePrices(
      "pinnacle:evt-100",
      "pinnacle",
      [
        { market: "OU", lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 1.80 },
        { market: "OU", lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 2.05 },
      ],
      kickoff,
      kickoff - 3 * 60_000,
    );

    const stages = rawDb.prepare(
      "SELECT stage,provider FROM research_timeline_snapshots WHERE match_id=? ORDER BY stage",
    ).all("pinnacle:evt-100") as Array<{ stage: string; provider: string }>;
    // 4 stages × 2 sides = 8 rows
    expect(stages).toHaveLength(8);
    expect(new Set(stages.map((s) => s.stage))).toEqual(new Set(["initial", "T30", "T15", "T5"]));
    expect(stages.every((s) => s.provider === "pinnacle")).toBe(true);

    // Isolation from HKJC execution tables
    for (const table of [
      "odds_latest", "odds_snapshots", "market_lines", "opportunities", "simulation_bets",
    ]) {
      const row = rawDb.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number };
      expect(row.c).toBe(0);
    }

    // expectedPairCount uses Pinnacle-only expectations
    expect(expectedPairCount("pinnacle:evt-100", "initial")).toBe(2);
    expect(expectedPairCount("pinnacle:evt-100", "T30")).toBe(2);
  });

  it("freezes the earliest Pinnacle-only live observation as initial exactly once", () => {
    const kickoff = NOW + 60 * 60_000;
    addPinnacleOnlyFixture("pinnacle:evt-101", kickoff);

    for (const observedAt of [kickoff - 50 * 60_000, kickoff - 45 * 60_000, kickoff - 40 * 60_000]) {
      captureResearchTimelinePrices(
        "pinnacle:evt-101",
        "pinnacle",
        [
          { market: "OU", lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 1.90 },
          { market: "OU", lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 1.95 },
        ],
        kickoff,
        observedAt,
      );
    }
    const rows = rawDb.prepare(
      "SELECT selection,decimal_odds,captured_at FROM research_timeline_snapshots WHERE match_id=? AND stage='initial' ORDER BY selection",
    ).all("pinnacle:evt-101") as Array<{ selection: string; decimal_odds: number; captured_at: number }>;
    expect(rows).toHaveLength(2);
    // The earliest observation wins because subsequent captures use INSERT OR IGNORE.
    expect(rows[0].captured_at).toBe(kickoff - 50 * 60_000);
  });

  it("does NOT freeze an initial for an HKJC-linked fixture even when observed early", () => {
    const kickoff = NOW + 60 * 60_000;
    addHkjcFixture("hkjc:evt-200", kickoff);

    captureResearchTimelinePrices(
      "hkjc:evt-200",
      "pinnacle",
      [
        { market: "OU", lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 1.90 },
        { market: "OU", lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 1.95 },
      ],
      kickoff,
      kickoff - 45 * 60_000, // early observation
    );
    const initialRows = rawDb.prepare(
      "SELECT COUNT(*) c FROM research_timeline_snapshots WHERE match_id=? AND stage='initial'",
    ).get("hkjc:evt-200") as { c: number };
    expect(initialRows.c).toBe(0);
  });
});

describe("Pinnacle-only in OU signal engine", () => {
  function seedTriple(
    id: string,
    prices: {
      initial: [number, number]; T30: [number, number]; T5: [number, number];
    },
    lineKey = "2.5",
    provider: "hkjc" | "pinnacle" = "pinnacle",
    fixtureType: "pinnacle-only" | "hkjc" = "pinnacle-only",
  ): void {
    const kickoff = NOW + 30 * 60_000;
    if (fixtureType === "pinnacle-only") addPinnacleOnlyFixture(id, kickoff);
    else addHkjcFixture(id, kickoff);
    addStage(id, provider, "initial", lineKey, ...prices.initial, NOW - 25 * 60_000);
    addStage(id, provider, "T30", lineKey, ...prices.T30, NOW - 20 * 60_000);
    addStage(id, provider, "T5", lineKey, ...prices.T5, NOW - 60_000);
  }

  it("produces a T-30 prealert and T-5 observation for a qualifying Pinnacle-only triple", () => {
    seedTriple("pinnacle:evt-uoo", {
      initial: [1.90, 1.80],
      T30: [1.78, 1.96],
      T5: [1.84, 2.00],
    });

    const prealertsInserted = syncOuSignalPrealerts(["pinnacle:evt-uoo"]);
    expect(prealertsInserted).toBeGreaterThanOrEqual(1);
    const observationsInserted = syncOuSignalObservations(["pinnacle:evt-uoo"]);
    expect(observationsInserted).toBeGreaterThanOrEqual(1);

    const stored = rawDb.prepare(
      "SELECT provider,rule_id FROM ou_signal_observations WHERE match_id=?",
    ).all("pinnacle:evt-uoo") as Array<{ provider: string; rule_id: string }>;
    expect(stored.length).toBeGreaterThanOrEqual(1);
    expect(stored.every((row) => row.provider === "pinnacle")).toBe(true);
    // Every triggered rule for a Pinnacle-only fixture must be a pinnacle rule.
    for (const row of stored) {
      const rule = OU_SIGNAL_RULES.find((r) => r.id === row.rule_id);
      expect(rule?.provider).toBe("pinnacle");
      expect(rule?.providerLabel).toBe("Pinnacle／平博");
    }
  });

  it("dedupes prealert and observation writes when sync runs twice", () => {
    seedTriple("pinnacle:evt-dedupe", {
      initial: [1.90, 1.80],
      T30: [1.78, 1.96],
      T5: [1.84, 2.00],
    });
    syncOuSignalPrealerts(["pinnacle:evt-dedupe"]);
    syncOuSignalObservations(["pinnacle:evt-dedupe"]);
    // Second pass must not create new rows (INSERT OR IGNORE unique_key).
    expect(syncOuSignalPrealerts(["pinnacle:evt-dedupe"])).toBe(0);
    expect(syncOuSignalObservations(["pinnacle:evt-dedupe"])).toBe(0);
  });

  it("marks a Telegram-once notification and never returns it again", () => {
    seedTriple("pinnacle:evt-once", {
      initial: [1.90, 1.80],
      T30: [1.78, 1.96],
      T5: [1.84, 2.00],
    });
    syncOuSignalObservations(["pinnacle:evt-once"]);
    const first = unsentOuSignals(["pinnacle:evt-once"], NOW);
    expect(first.length).toBeGreaterThanOrEqual(1);
    for (const row of first) markOuSignalNotified(row.uniqueKey, NOW);
    const second = unsentOuSignals(["pinnacle:evt-once"], NOW);
    expect(second).toHaveLength(0);
  });

  it("renders Titan direct Chinese names in Pinnacle-only Telegram messages", () => {
    const matchId = "pinnacle:3085481";
    const kickoff = NOW + 30 * 60_000;
    rawDb.prepare(
      `INSERT INTO matches(
        id,hkjc_id,fixture_source,titan_id,pinnacle_match_id,
        league,league_en,home_team,away_team,home_team_en,away_team_en,
        kickoff_utc,status,inplay,updated_at
      ) VALUES(?,NULL,'pinnacle','3085481','titan:3085481',
        '以色列甲組聯賽',NULL,'卡法沙巴1928','耶路撒冷體育會',NULL,NULL,
        ?,'PREEVENT',0,?)`,
    ).run(matchId, kickoff, Date.now());
    rawDb.prepare(
      `INSERT INTO pinnacle_translations(
        pinnapi_id,zh_home,zh_away,zh_league,source,updated_at,attempted_at,attempt_count,last_error
      ) VALUES('3085481','錯誤主隊翻譯','錯誤客隊翻譯','錯誤聯賽翻譯','titan',?,?,1,NULL)`,
    ).run(Date.now(), Date.now());
    addStage(matchId, "pinnacle", "initial", "2.5", 1.90, 1.80, NOW - 25 * 60_000);
    addStage(matchId, "pinnacle", "T30", "2.5", 1.78, 1.96, NOW - 20 * 60_000);
    addStage(matchId, "pinnacle", "T5", "2.5", 1.84, 2.00, NOW - 60_000);

    syncOuSignalObservations([matchId]);
    const signal = unsentOuSignals([matchId], NOW)[0];
    expect(signal).toBeDefined();
    expect(signal).toMatchObject({
      league: "以色列甲組聯賽",
      homeTeam: "卡法沙巴1928",
      awayTeam: "耶路撒冷體育會",
    });
    const message = buildOuSignalMessage([signal!]);
    expect(message).toContain("以色列甲組聯賽｜卡法沙巴1928 vs 耶路撒冷體育會");
    expect(message).not.toContain("錯誤");
  });

  it("skips a Pinnacle-only triple where any selected checkpoint price is ≤ 1.70", () => {
    seedTriple("pinnacle:evt-thresh", {
      initial: [1.70, 1.90], // selected side hits the exclusion boundary
      T30: [1.78, 1.96],
      T5: [1.84, 2.00],
    });
    expect(syncOuSignalObservations(["pinnacle:evt-thresh"])).toBe(0);
  });

  it("skips when the qualifying triple has a mismatched line", () => {
    const kickoff = NOW + 30 * 60_000;
    addPinnacleOnlyFixture("pinnacle:evt-mixed", kickoff);
    addStage("pinnacle:evt-mixed", "pinnacle", "initial", "2.5", 1.90, 1.80, NOW - 25 * 60_000);
    addStage("pinnacle:evt-mixed", "pinnacle", "T30", "2.75", 1.78, 1.96, NOW - 20 * 60_000);
    addStage("pinnacle:evt-mixed", "pinnacle", "T5", "2.5", 1.84, 2.00, NOW - 60_000);
    expect(syncOuSignalObservations(["pinnacle:evt-mixed"])).toBe(0);
  });

  it("skips when the T-5 snapshot is missing", () => {
    const kickoff = NOW + 30 * 60_000;
    addPinnacleOnlyFixture("pinnacle:evt-nostage", kickoff);
    addStage("pinnacle:evt-nostage", "pinnacle", "initial", "2.5", 1.90, 1.80, NOW - 25 * 60_000);
    addStage("pinnacle:evt-nostage", "pinnacle", "T30", "2.5", 1.78, 1.96, NOW - 20 * 60_000);
    expect(syncOuSignalObservations(["pinnacle:evt-nostage"])).toBe(0);
    // Prealert still fires because it only needs initial + T30.
    expect(syncOuSignalPrealerts(["pinnacle:evt-nostage"])).toBeGreaterThanOrEqual(1);
  });

  it("does NOT trigger a pinnacle rule from HKJC-provider rows on a Pinnacle-only fixture", () => {
    // Seed an HKJC-provider triple against a Pinnacle-only fixture: since the
    // new guard requires (fixture='hkjc' OR provider='pinnacle'), this must
    // yield zero observations.
    const kickoff = NOW + 30 * 60_000;
    addPinnacleOnlyFixture("pinnacle:evt-guard", kickoff);
    addStage("pinnacle:evt-guard", "hkjc", "initial", "2.5", 1.90, 1.80, NOW - 25 * 60_000);
    addStage("pinnacle:evt-guard", "hkjc", "T30", "2.5", 1.78, 1.96, NOW - 20 * 60_000);
    addStage("pinnacle:evt-guard", "hkjc", "T5", "2.5", 1.84, 2.00, NOW - 60_000);
    expect(syncOuSignalObservations(["pinnacle:evt-guard"])).toBe(0);
    expect(syncOuSignalPrealerts(["pinnacle:evt-guard"])).toBe(0);
  });

  it("keeps working for a normal HKJC-linked pinnacle rule (regression)", () => {
    seedTriple("hkjc:evt-regress", {
      initial: [1.90, 1.80],
      T30: [1.78, 1.96],
      T5: [1.84, 2.00],
    }, "2.5", "pinnacle", "hkjc");
    const inserted = syncOuSignalObservations(["hkjc:evt-regress"]);
    expect(inserted).toBeGreaterThanOrEqual(1);
  });
});

describe("Pinnacle-only fixtures appear in the research dataset + CSV", () => {
  it("returns a Pinnacle-only match row and hides HKJC/Crown cells as source_unavailable", () => {
    const kickoff = NOW + 60 * 60_000;
    addPinnacleOnlyFixture("pinnacle:evt-dataset", kickoff);
    addStage("pinnacle:evt-dataset", "pinnacle", "T30", "2.5", 1.85, 2.00, kickoff - 25 * 60_000);

    const ds = researchDataset({ days: 7, provider: "all", market: "all" }, NOW);
    const row = ds.matches.find((m) => m.matchId === "pinnacle:evt-dataset");
    expect(row).toBeDefined();
    expect(row!.fixtureSource).toBe("pinnacle");
    const t30 = row!.timeline.T30;
    expect(t30.cells.pinnacle.OU).toBe("captured");
    // Pinnacle-only fixtures must mark every non-pinnacle cell as source_unavailable
    expect(t30.cells.hkjc.OU).toBe("source_unavailable");
    expect(t30.cells.hkjc.AH).toBe("source_unavailable");
    expect(t30.cells.hkjc.COU).toBe("source_unavailable");
  });

  it("filters to Pinnacle-only rows when provider='pinnacle' is requested", () => {
    const kickoff = NOW + 60 * 60_000;
    addPinnacleOnlyFixture("pinnacle:evt-filter-a", kickoff);
    addHkjcFixture("hkjc:evt-filter-b", kickoff);
    addStage("pinnacle:evt-filter-a", "pinnacle", "T30", "2.5", 1.85, 2.00, kickoff - 25 * 60_000);
    addStage("hkjc:evt-filter-b", "pinnacle", "T30", "2.5", 1.85, 2.00, kickoff - 25 * 60_000);

    const ds = researchDataset({ days: 7, provider: "pinnacle", market: "OU" }, NOW);
    const ids = ds.matches.map((m) => m.matchId);
    expect(ids).toContain("pinnacle:evt-filter-a");
    expect(ids).toContain("hkjc:evt-filter-b");
  });

  it("emits fixture_source column with 'pinnacle' in the CSV export", () => {
    const kickoff = NOW + 60 * 60_000;
    addPinnacleOnlyFixture("pinnacle:evt-csv", kickoff);
    addStage("pinnacle:evt-csv", "pinnacle", "T30", "2.5", 1.85, 2.00, kickoff - 25 * 60_000);

    const csv = researchCsv("timeline", { days: 7, provider: "all", market: "OU" }, NOW);
    // Header includes fixture_source; body has at least one row with 'pinnacle'.
    expect(csv).toContain("fixture_source");
    const bodyLines = csv.split(/\r?\n/).slice(1).filter(Boolean);
    const hasPinnacleOnly = bodyLines.some((line) =>
      line.includes(",pinnacle,") && line.includes("pinnacle:evt-csv"),
    );
    expect(hasPinnacleOnly).toBe(true);
  });
});

describe("Titan-direct Chinese names in research dataset", () => {
  function insertTranslation(pinnapiId: string, zhHome: string | null, zhAway: string | null, zhLeague: string | null): void {
    rawDb.prepare(
      `INSERT OR REPLACE INTO pinnacle_translations(pinnapi_id,zh_home,zh_away,zh_league,source,updated_at,attempted_at,attempt_count,last_error)
       VALUES(?,?,?,?,?,?,?,?,NULL)`,
    ).run(pinnapiId, zhHome, zhAway, zhLeague, "titan", Date.now(), Date.now(), 1);
  }

  it("never lets a legacy translation overwrite Titan direct names", () => {
    const kickoff = NOW + 60 * 60_000;
    addPinnacleOnlyFixture("pinnacle:evt-trans-a", kickoff);
    addStage("pinnacle:evt-trans-a", "pinnacle", "T30", "2.5", 1.85, 2.00, kickoff - 25 * 60_000);
    insertTranslation("evt-trans-a", "阿仙奴", "利物浦", "英超");

    const ds = researchDataset({ days: 7, provider: "all", market: "OU" }, NOW);
    const row = ds.matches.find((m) => m.matchId === "pinnacle:evt-trans-a");
    expect(row).toBeDefined();
    expect(row!.homeTeam).toBe("pinnacle:evt-trans-a主");
    expect(row!.awayTeam).toBe("pinnacle:evt-trans-a客");
    expect(row!.league).toBe("Pinn聯");
  });

  it("uses the direct Titan fields when no legacy translation exists", () => {
    const kickoff = NOW + 60 * 60_000;
    addPinnacleOnlyFixture("pinnacle:evt-trans-b", kickoff);
    addStage("pinnacle:evt-trans-b", "pinnacle", "T30", "2.5", 1.85, 2.00, kickoff - 25 * 60_000);
    // no insertTranslation call

    const ds = researchDataset({ days: 7, provider: "all", market: "OU" }, NOW);
    const row = ds.matches.find((m) => m.matchId === "pinnacle:evt-trans-b");
    expect(row).toBeDefined();
    // These fields represent the labels parsed directly from Titan's Chinese
    // schedule and must survive without any translation row.
    expect(row!.homeTeam).toBe("pinnacle:evt-trans-b主");
    expect(row!.awayTeam).toBe("pinnacle:evt-trans-b客");
    expect(row!.league).toBe("Pinn聯");
  });

  it("does not touch HKJC-linked fixture display fields even when a stray translation row exists", () => {
    const kickoff = NOW + 60 * 60_000;
    addHkjcFixture("hkjc:evt-trans-c", kickoff);
    addStage("hkjc:evt-trans-c", "pinnacle", "T30", "2.5", 1.85, 2.00, kickoff - 25 * 60_000);
    // Intentionally seed a pinnapi_id that would collide with the numeric-only
    // trailing digits of the HKJC id to prove the join is scoped to
    // fixture_source='pinnacle'.
    insertTranslation("evt-trans-c", "不應該覆蓋", "不應該覆蓋", "不應該覆蓋");

    const ds = researchDataset({ days: 7, provider: "all", market: "OU" }, NOW);
    const row = ds.matches.find((m) => m.matchId === "hkjc:evt-trans-c");
    expect(row).toBeDefined();
    expect(row!.homeTeam).toBe("hkjc:evt-trans-c主");
    expect(row!.awayTeam).toBe("hkjc:evt-trans-c客");
    expect(row!.league).toBe("HK聯");
  });
});
