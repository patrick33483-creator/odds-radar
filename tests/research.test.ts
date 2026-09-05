import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const dbPath = `/tmp/odds-radar-research-${process.pid}.db`;
process.env.RADAR_DB = dbPath;
process.env.RADAR_RESEARCH_RESULTS = "1";

let rawDb: typeof import("../server/lib/store").rawDb;
let collectResearchResults: typeof import("../server/lib/research").collectResearchResults;
let collectResearchInitialSnapshots: typeof import("../server/lib/research").collectResearchInitialSnapshots;
let captureResearchTimelinePrices: typeof import("../server/lib/research").captureResearchTimelinePrices;
let parseResearchFilters: typeof import("../server/lib/research").parseResearchFilters;
let parseTipsmeOpeningQuotes: typeof import("../server/providers/tipsme-opening").parseTipsmeOpeningQuotes;
let researchStageFor: typeof import("../server/lib/research").researchStageFor;
let researchCsv: typeof import("../server/lib/research").researchCsv;
let researchDataset: typeof import("../server/lib/research").researchDataset;
let saveResearchInitialSnapshots: typeof import("../server/lib/research").saveResearchInitialSnapshots;
let parseTitanTime: typeof import("../server/providers/pinnacle").parseTitanTime;

beforeAll(async () => {
  const store = await import("../server/lib/store");
  const research = await import("../server/lib/research");
  const pinnacle = await import("../server/providers/pinnacle");
  const tipsme = await import("../server/providers/tipsme-opening");
  rawDb = store.rawDb;
  captureResearchTimelinePrices = research.captureResearchTimelinePrices;
  collectResearchInitialSnapshots = research.collectResearchInitialSnapshots;
  collectResearchResults = research.collectResearchResults;
  parseResearchFilters = research.parseResearchFilters;
  researchStageFor = research.researchStageFor;
  researchCsv = research.researchCsv;
  researchDataset = research.researchDataset;
  saveResearchInitialSnapshots = research.saveResearchInitialSnapshots;
  parseTitanTime = pinnacle.parseTitanTime;
  parseTipsmeOpeningQuotes = tipsme.parseTipsmeOpeningQuotes;
  store.migrate();
});

afterAll(() => {
  rawDb.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      rmSync(`${dbPath}${suffix}`);
    } catch {
      // SQLite may not create every sidecar file.
    }
  }
});

function addMatch(id: string, kickoff: number, home = "甲隊", away = "乙隊"): void {
  rawDb.prepare(
    `INSERT INTO matches(
      id,hkjc_id,league,home_team,away_team,kickoff_utc,status,inplay,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(id, id.replace(/\D/g, "") || id, "研究聯賽", home, away, kickoff, "PREEVENT", 0, Date.now());
}

const twoWayPrices = [
  { market: "AH", lineValue: -0.25, isMain: true, selection: "H", decimalOdds: 1.91 },
  { market: "AH", lineValue: -0.25, isMain: true, selection: "A", decimalOdds: 1.99 },
  { market: "OU", lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 1.92 },
  { market: "OU", lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 1.98 },
  { market: "COU", lineValue: 9.5, isMain: true, selection: "O", decimalOdds: 1.93 },
  { market: "COU", lineValue: 9.5, isMain: true, selection: "U", decimalOdds: 1.97 },
] as const;

describe("research data collection", () => {
  it("assigns the first post-target observation to each research checkpoint", () => {
    const kickoff = 1_000_000_000;
    expect(researchStageFor(kickoff, kickoff - 30 * 60_000)).toBe("T30");
    expect(researchStageFor(kickoff, kickoff - 20 * 60_000)).toBe("T30");
    expect(researchStageFor(kickoff, kickoff - 15 * 60_000)).toBe("T15");
    expect(researchStageFor(kickoff, kickoff - 10 * 60_000)).toBe("T15");
    expect(researchStageFor(kickoff, kickoff - 5 * 60_000)).toBe("T5");
    expect(researchStageFor(kickoff, kickoff - 60_000)).toBe("T5");
    expect(researchStageFor(kickoff, kickoff)).toBeNull();
  });

  it("bounds lookback and accepts only supported provider and market filters", () => {
    expect(parseResearchFilters({ days: "999", provider: "pinnacle", market: "OU" })).toEqual({
      window: "upcoming",
      days: 120,
      horizonDays: 14,
      limit: 300,
      provider: "pinnacle",
      market: "OU",
    });
    expect(parseResearchFilters({ days: "bad", provider: "unknown", market: "HDC" })).toEqual({
      window: "upcoming",
      days: 7,
      horizonDays: 14,
      limit: 300,
      provider: "all",
      market: "all",
    });
  });

  it("parses rolling-window params and bounds them", () => {
    expect(parseResearchFilters({ window: "upcoming", horizonDays: "999", limit: "5000", provider: "hkjc", market: "AH" })).toEqual({
      window: "upcoming",
      days: 7,
      horizonDays: 60,
      limit: 1000,
      provider: "hkjc",
      market: "AH",
    });
    expect(parseResearchFilters({ window: "finished", days: "30", limit: "5000", provider: "all", market: "all" })).toEqual({
      window: "finished",
      days: 30,
      horizonDays: 14,
      limit: 2000,
      provider: "all",
      market: "all",
    });
    expect(parseResearchFilters({ window: "nonsense" })).toMatchObject({ window: "upcoming" });
  });

  it("never treats the first live observation as an initial opening", () => {
    const now = Date.now();
    const kickoff = now + 25 * 60_000;
    addMatch("no-first-seen-initial", kickoff);
    captureResearchTimelinePrices("no-first-seen-initial", "hkjc", twoWayPrices as never, kickoff, now);
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM research_timeline_snapshots WHERE match_id=? AND stage='initial'",
    ).get("no-first-seen-initial")).toEqual({ count: 0 });
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM research_timeline_snapshots WHERE match_id=? AND stage='T30'",
    ).get("no-first-seen-initial")).toEqual({ count: 6 });
  });

  it("stores official results in the isolated research table without touching settlement results", async () => {
    const now = Date.now();
    addMatch("research-only", now - 2 * 60 * 60_000, "主隊", "客隊");
    rawDb.prepare("UPDATE matches SET hkjc_id='123' WHERE id='research-only'").run();

    const provider = {
      fetchHistoricResults: async () => [{
        matchId: "123",
        homeScore: 2,
        awayScore: 1,
        cornersTotal: 9,
        sequence: 1,
        source: "hkjc_official",
      }],
    };
    await expect(collectResearchResults(provider as never, now)).resolves.toEqual({
      candidates: 1,
      collected: 1,
    });

    expect(rawDb.prepare("SELECT COUNT(*) count FROM results").get()).toEqual({ count: 0 });
    expect(rawDb.prepare("SELECT match_id,home_score,away_score,corners_total FROM research_results").get()).toEqual({
      match_id: "research-only", home_score: 2, away_score: 1, corners_total: 9,
    });
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM research_timeline_snapshots WHERE match_id='research-only'",
    ).get()).toEqual({ count: 0 });
    const dataset = researchDataset({ days: 7, provider: "all", market: "all" });
    expect(dataset.summary.completedResults).toBe(1);
    expect(dataset.matches.find((match) => match.matchId === "research-only")?.result).toMatchObject({
      homeScore: 2, awayScore: 1, cornersTotal: 9, source: "hkjc_official",
    });
    expect(dataset.matches.find((match) => match.matchId === "research-only")).toMatchObject({
      snapshotCount: 0,
      firstSnapshotAt: null,
      lastSnapshotAt: null,
    });
    expect(researchCsv("results", { days: 7, provider: "all", market: "all" })).toContain(
      "hkjc:123,research-only,hkjc,,123,研究聯賽,主隊,客隊",
    );
  });

  it("replaces unsafe manual scores with Titan results by exact sId or strict full-fixture matching", async () => {
    const now = Date.parse("2026-09-04T06:00:00Z");
    const exactKickoff = Date.parse("2026-09-04T02:00:00Z");
    const matchedKickoff = Date.parse("2026-09-04T02:05:00Z");

    addMatch("pinnacle:titan-result-exact", exactKickoff, "IH Hafnarfjordur", "KFR");
    rawDb.prepare(
      `UPDATE matches
          SET fixture_source='pinnacle',titan_id='3100001',league='Iceland 4 Deild'
        WHERE id='pinnacle:titan-result-exact'`,
    ).run();
    addMatch("pinnacle:result-strict-match", matchedKickoff, "Deportivo Capiata", "3 De Noviembre");
    rawDb.prepare(
      `UPDATE matches
          SET fixture_source='pinnacle',titan_id=NULL,league='Paraguay Division Intermedia'
        WHERE id='pinnacle:result-strict-match'`,
    ).run();
    rawDb.prepare(
      `INSERT INTO pinnacle_translations(
         pinnapi_id,zh_home,zh_away,zh_league,source,updated_at,attempt_count
       ) VALUES('result-strict-match','Deportivo Capiata','3 De Noviembre',
                'Paraguay Division Intermedia','titan',?,0)`,
    ).run(now);
    const insertManual = rawDb.prepare(
      `INSERT INTO research_results(
         match_id,hkjc_id,home_score,away_score,corners_total,source,
         result_source,source_match_id,fetched_at
       ) VALUES(?,NULL,?,?,NULL,'manual','manual',NULL,?)`,
    );
    insertManual.run("pinnacle:titan-result-exact", 2, 0, now - 1_000);
    insertManual.run("pinnacle:result-strict-match", 1, 1, now - 1_000);

    const page = [
      "<table>",
      "<tr sId='3100001'><td>Iceland 4 Deild</td><td>9-4 10:00</td><td>-1</td><td>IH Hafnarfjordur</td><td>3 - 2</td><td>KFR</td><td>2 - 2</td></tr>",
      "<tr sId='3100002'><td>Paraguay Division Intermedia</td><td>9-4 10:05</td><td>-1</td><td>Deportivo Capiata</td><td>4 - 3</td><td>3 De Noviembre</td><td>2 - 1</td></tr>",
      "</table>",
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(page)));
    try {
      await expect(collectResearchResults({ fetchHistoricResults: async () => [] } as never, now))
        .resolves.toEqual({ candidates: 2, collected: 2 });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(rawDb.prepare(
      `SELECT match_id,home_score,away_score,source,result_source,source_match_id
         FROM research_results
        WHERE match_id IN ('pinnacle:titan-result-exact','pinnacle:result-strict-match')
        ORDER BY match_id`,
    ).all()).toEqual([
      {
        match_id: "pinnacle:result-strict-match",
        home_score: 4,
        away_score: 3,
        source: "titan007",
        result_source: "titan007",
        source_match_id: "3100002",
      },
      {
        match_id: "pinnacle:titan-result-exact",
        home_score: 3,
        away_score: 2,
        source: "titan007",
        result_source: "titan007",
        source_match_id: "3100001",
      },
    ]);
  });

  it("finds an early-HKT final result on Titan's previous-day Over page", async () => {
    const now = Date.parse("2026-09-05T06:00:00Z");
    const kickoff = Date.parse("2026-09-04T19:30:00Z");
    addMatch("pinnacle:previous-day-over", kickoff, "Deportivo Capiata", "3 De Noviembre");
    rawDb.prepare(
      `UPDATE matches
          SET fixture_source='pinnacle',titan_id='3200001',league='Paraguay Division Intermedia'
        WHERE id='pinnacle:previous-day-over'`,
    ).run();

    const previousDayPage = [
      "<table>",
      "<tr sId='3200001'><td>Paraguay Division Intermedia</td><td>9-5 03:30</td><td>-1</td>",
      "<td>Deportivo Capiata</td><td>4 - 3</td><td>3 De Noviembre</td><td>2 - 1</td></tr>",
      "</table>",
    ].join("");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      return new Response(url.includes("Over_20260904.htm") ? previousDayPage : "<table></table>");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await collectResearchResults({ fetchHistoricResults: async () => [] } as never, now);
      expect(result).toEqual({ candidates: 1, collected: 1 });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("Over_20260904.htm"))).toBe(true);
    expect(rawDb.prepare(
      `SELECT home_score,away_score,result_source,source_match_id
         FROM research_results WHERE match_id='pinnacle:previous-day-over'`,
    ).get()).toEqual({
      home_score: 4,
      away_score: 3,
      result_source: "titan007",
      source_match_id: "3200001",
    });
  });

  it("does not persist a live score found on Titan's previous-day page", async () => {
    const now = Date.parse("2026-09-05T06:00:00Z");
    const kickoff = Date.parse("2026-09-04T19:30:00Z");
    addMatch("pinnacle:previous-day-live", kickoff, "Live Home", "Live Away");
    rawDb.prepare(
      `UPDATE matches
          SET fixture_source='pinnacle',titan_id='3200002',league='Live League'
        WHERE id='pinnacle:previous-day-live'`,
    ).run();
    const livePage = [
      "<table>",
      "<tr sId='3200002'><td>Live League</td><td>9-5 03:30</td><td>70</td>",
      "<td>Live Home</td><td>1 - 0</td><td>Live Away</td><td>0 - 0</td></tr>",
      "</table>",
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      return new Response(url.includes("Over_20260904.htm") ? livePage : "<table></table>");
    }));
    try {
      await expect(collectResearchResults({ fetchHistoricResults: async () => [] } as never, now))
        .resolves.toEqual({ candidates: 1, collected: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM research_results WHERE match_id='pinnacle:previous-day-live'",
    ).get()).toEqual({ count: 0 });
    rawDb.prepare("DELETE FROM matches WHERE id='pinnacle:previous-day-live'").run();
  });

  it("resolves Titan cross-month and cross-year schedule times around the page date", () => {
    expect(parseTitanTime("1日03:30", "20260831")).toBe(Date.parse("2026-08-31T19:30:00Z"));
    expect(parseTitanTime("1-1 03:30", "20251231")).toBe(Date.parse("2025-12-31T19:30:00Z"));
  });

  it("fails closed when two Titan IDs both strictly match one unmapped result", async () => {
    const now = Date.parse("2026-09-05T06:00:00Z");
    const kickoff = Date.parse("2026-09-04T19:30:00Z");
    addMatch("pinnacle:ambiguous-cross-day", kickoff, "Same Home", "Same Away");
    rawDb.prepare(
      `UPDATE matches
          SET fixture_source='pinnacle',titan_id=NULL,league='Same League'
        WHERE id='pinnacle:ambiguous-cross-day'`,
    ).run();
    const previousPage = [
      "<table>",
      "<tr sId='3300001'><td>Same League</td><td>9-5 03:30</td><td>-1</td>",
      "<td>Same Home</td><td>2 - 0</td><td>Same Away</td><td>1 - 0</td></tr>",
      "<tr sId='3300002'><td>Same League</td><td>9-5 03:30</td><td>-1</td>",
      "<td>Same Home</td><td>1 - 1</td><td>Same Away</td><td>0 - 0</td></tr>",
      "</table>",
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      return new Response(url.includes("Over_20260904.htm") ? previousPage : "<table></table>");
    }));
    try {
      await expect(collectResearchResults({ fetchHistoricResults: async () => [] } as never, now))
        .resolves.toEqual({ candidates: 1, collected: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM research_results WHERE match_id='pinnacle:ambiguous-cross-day'",
    ).get()).toEqual({ count: 0 });
    rawDb.prepare("DELETE FROM matches WHERE id='pinnacle:ambiguous-cross-day'").run();
  });

  it("does not reintroduce a Titan ID after conflicting final scores across pages", async () => {
    const now = Date.parse("2026-09-05T06:00:00Z");
    const kickoff = Date.parse("2026-09-04T19:30:00Z");
    addMatch("pinnacle:conflicting-titan-id", kickoff, "Conflict Home", "Conflict Away");
    rawDb.prepare(
      `UPDATE matches
          SET fixture_source='pinnacle',titan_id='3400001',league='Conflict League'
        WHERE id='pinnacle:conflicting-titan-id'`,
    ).run();
    const page = (score: string) => [
      "<table>",
      "<tr sId='3400001'><td>Conflict League</td><td>9-5 03:30</td><td>-1</td>",
      `<td>Conflict Home</td><td>${score}</td><td>Conflict Away</td><td>0 - 0</td></tr>`,
      "</table>",
    ].join("");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("Over_20260905.htm")) return new Response(page("2 - 0"));
      if (url.includes("Next_20260905.htm")) return new Response(page("1 - 1"));
      if (url.includes("Over_20260904.htm")) return new Response(page("2 - 0"));
      return new Response("<table></table>");
    }));
    try {
      await expect(collectResearchResults({ fetchHistoricResults: async () => [] } as never, now))
        .resolves.toEqual({ candidates: 1, collected: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM research_results WHERE match_id='pinnacle:conflicting-titan-id'",
    ).get()).toEqual({ count: 0 });
  });

  it("locks a complete checkpoint and does not overwrite it on later scans", () => {
    const now = Date.now();
    const kickoff = now + 30 * 60_000;
    addMatch("timeline-lock", kickoff);
    captureResearchTimelinePrices("timeline-lock", "hkjc", twoWayPrices as never, kickoff, now);
    expect(rawDb.prepare(
      `SELECT status,first_captured_at,last_retry_at,captured_at
         FROM research_timeline_points WHERE match_id=? AND stage='T30'`,
    ).get("timeline-lock")).toEqual({
      status: "partial",
      first_captured_at: now,
      last_retry_at: null,
      captured_at: now,
    });
    captureResearchTimelinePrices("timeline-lock", "pinnacle", twoWayPrices as never, kickoff, now + 1_000);
    expect(rawDb.prepare(
      `SELECT status,first_captured_at,last_retry_at,captured_at
         FROM research_timeline_points WHERE match_id=? AND stage='T30'`,
    ).get("timeline-lock")).toEqual({
      status: "captured",
      first_captured_at: now,
      last_retry_at: now + 1_000,
      captured_at: now,
    });

    const changed = twoWayPrices.map((price) => ({ ...price, decimalOdds: 2.5 }));
    captureResearchTimelinePrices("timeline-lock", "hkjc", changed as never, kickoff, now + 2_000);
    expect(rawDb.prepare(
      `SELECT decimal_odds FROM research_timeline_snapshots
        WHERE match_id=? AND stage='T30' AND provider='hkjc'
          AND market='AH' AND selection='H'`,
    ).get("timeline-lock")).toEqual({ decimal_odds: 1.91 });
    expect(rawDb.prepare(
      `SELECT first_captured_at,last_retry_at,captured_at
         FROM research_timeline_points WHERE match_id=? AND stage='T30'`,
    ).get("timeline-lock")).toEqual({
      first_captured_at: now,
      last_retry_at: now + 1_000,
      captured_at: now,
    });
    expect(
      researchDataset({ days: 7, provider: "all", market: "all" })
        .matches.find((match) => match.matchId === "timeline-lock")?.timeline.T30,
    ).toMatchObject({
      firstCapturedAt: now,
      lastRetryAt: now + 1_000,
      capturedAt: now,
      cells: {
        hkjc: { AH: "captured", OU: "captured", COU: "captured" },
        pinnacle: { AH: "captured", OU: "captured", COU: "captured" },
      },
    });
  });

  it("parses HKJC first records and converts Pinnacle Hong Kong water to decimal", () => {
    const parsed = parseTipsmeOpeningQuotes("tipsme-1", {
      hdpOdds: [
        { home_cap: "[+0/+0.5]", home_win_odds: 1.91, away_win_odds: 1.99, create_time: "2026-08-20T10:00:00Z" },
        { home_cap: "[+0/+0.5]", home_win_odds: 2.1, away_win_odds: 1.8, create_time: "2026-08-20T11:00:00Z" },
      ],
      hiloOdds: [{ number_of_goals: "[2.5]", big_odds: "1.80", small_odds: "2.00", create_time: "2026-08-20T10:00:00Z" }],
      chiloOdds: [{ number_of_corners: "[9.5]", big_odds: "1.90", small_odds: "1.90", create_time: "2026-08-20T10:00:00Z" }],
    }, {
      hdpDetails: [{ companyName: "平*", hdpBeginCap: "半/一", hdpBeginHomeOdds: "0.77", hdpBeginAwayOdds: "1.07" }],
      hiloDetails: [{ companyName: "平*", hiloBeginCap: "2.5/3", hiloBeginBigOdds: "0.81", hiloBeginSmallOdds: "1.00" }],
    });
    expect(parsed.quotes.find((quote) => quote.provider === "hkjc" && quote.market === "AH" && quote.selection === "H"))
      .toMatchObject({ lineValue: 0.25, decimalOdds: 1.91, isMain: false, sourceUpdatedAt: Date.parse("2026-08-20T10:00:00Z") });
    expect(parsed.quotes.find((quote) => quote.provider === "pinnacle" && quote.market === "AH" && quote.selection === "H"))
      .toMatchObject({ lineValue: -0.75, decimalOdds: 1.77, isMain: true, sourceUpdatedAt: null });
    expect(parsed.quotes.find((quote) => quote.provider === "pinnacle" && quote.market === "OU" && quote.selection === "O"))
      .toMatchObject({ lineValue: 2.75, decimalOdds: 1.81, isMain: true });
    expect(parsed.quotes.filter((quote) => quote.provider === "pinnacle").every((quote) => quote.isMain)).toBe(true);
    expect(parsed.quotes.filter((quote) => quote.provider === "hkjc").every((quote) => !quote.isMain)).toBe(true);
  });

  it("keeps external initial rows immutable and records the missing Pinnacle COU source", () => {
    const now = Date.now();
    addMatch("external-initial-lock", now + 3 * 60 * 60_000);
    const source = (decimalOdds: number) => ({
      quotes: [{
        provider: "hkjc" as const,
        market: "AH" as const,
        lineValue: 0.25,
        isMain: false,
        selection: "H" as const,
        decimalOdds,
        sourceUpdatedAt: now - 1000,
        origin: "external_opening" as const,
        sourceName: "tipsme" as const,
        sourceMatchId: "source-99",
        sourceUrl: "https://tipsme-web.azurewebsites.net/api/Score/odds/hkjc/source-99",
      }],
      missing: [{ provider: "pinnacle" as const, market: "COU" as const, note: "Pinnacle COU opening unavailable: Tipsme public v2 has no Pinnacle corner-opening source." }],
    });
    expect(saveResearchInitialSnapshots("external-initial-lock", source(1.91), now)).toBe(1);
    expect(saveResearchInitialSnapshots("external-initial-lock", source(2.4), now + 1_000)).toBe(0);
    expect(rawDb.prepare(
      `SELECT decimal_odds,origin,source_name,source_match_id,source_url
         FROM research_timeline_snapshots WHERE match_id=? AND stage='initial'`,
    ).get("external-initial-lock")).toEqual({
      decimal_odds: 1.91,
      origin: "external_opening",
      source_name: "tipsme",
      source_match_id: "source-99",
      source_url: "https://tipsme-web.azurewebsites.net/api/Score/odds/hkjc/source-99",
    });
    expect(rawDb.prepare(
      `SELECT note,first_captured_at,last_retry_at,captured_at
         FROM research_timeline_points WHERE match_id=? AND stage='initial'`,
    ).get("external-initial-lock")).toEqual({
      note: "Pinnacle COU opening unavailable: Tipsme public v2 has no Pinnacle corner-opening source.",
      first_captured_at: now,
      last_retry_at: now + 1_000,
      captured_at: now,
    });
    expect(
      researchDataset({ days: 7, provider: "all", market: "all" })
        .matches.find((match) => match.matchId === "external-initial-lock")?.timeline.initial.note,
    ).toBe("Pinnacle COU opening unavailable: Tipsme public v2 has no Pinnacle corner-opening source.");
    expect(
      researchDataset({ days: 7, provider: "all", market: "all" })
        .matches.find((match) => match.matchId === "external-initial-lock")?.timeline.initial.cells,
    ).toMatchObject({
      hkjc: { AH: "partial", OU: "market_unavailable", COU: "market_unavailable" },
      pinnacle: { AH: "market_unavailable", OU: "market_unavailable", COU: "source_unavailable" },
    });
    const timelineCsv = researchCsv("timeline", { days: 7, provider: "all", market: "all" });
    expect(timelineCsv).toContain("first_captured_at,last_retry_at");
    expect(timelineCsv).toContain("source_match_id");
  });

  it("blocks a later initial line after a complete pair while same-line retries stay idempotent", () => {
    const now = Date.now();
    addMatch("initial-line-lock", now + 3 * 60 * 60_000);
    const quote = (lineValue: number, selection: "H" | "A", decimalOdds: number) => ({
      provider: "pinnacle" as const, market: "AH" as const, lineValue, isMain: true, selection, decimalOdds,
      sourceUpdatedAt: null, origin: "external_opening" as const, sourceName: "tipsme" as const,
      sourceMatchId: "tipsme-line-lock", sourceUrl: "https://tipsme-web.azurewebsites.net/api/Score/odds/v2/tipsme-line-lock",
    });
    const missing = [{ provider: "pinnacle" as const, market: "COU" as const, note: "Pinnacle COU opening unavailable: Tipsme public v2 has no Pinnacle corner-opening source." }];
    expect(saveResearchInitialSnapshots("initial-line-lock", {
      quotes: [quote(-0.25, "H", 1.91), quote(-0.25, "A", 1.99)], missing,
    }, now)).toBe(2);
    expect(saveResearchInitialSnapshots("initial-line-lock", {
      quotes: [quote(-0.5, "H", 1.91), quote(-0.5, "A", 1.99)], missing,
    }, now + 1_000)).toBe(0);
    expect(saveResearchInitialSnapshots("initial-line-lock", {
      quotes: [quote(-0.25, "H", 2.2), quote(-0.25, "A", 1.8)], missing,
    }, now + 2_000)).toBe(0);
    expect(rawDb.prepare(
      "SELECT line_key,selection,decimal_odds FROM research_timeline_snapshots WHERE match_id=? AND stage='initial' ORDER BY selection",
    ).all("initial-line-lock")).toEqual([
      { line_key: "-0.25", selection: "A", decimal_odds: 1.99 },
      { line_key: "-0.25", selection: "H", decimal_odds: 1.91 },
    ]);
  });

  it("retains and explicitly records pre-existing multi-line initial ambiguity without inferring a main", () => {
    const now = Date.now();
    addMatch("initial-ambiguous", now + 3 * 60 * 60_000);
    const quote = (lineValue: number, selection: "O" | "U") => ({
      provider: "hkjc" as const, market: "OU" as const, lineValue, isMain: false, selection, decimalOdds: 1.91,
      sourceUpdatedAt: now, origin: "external_opening" as const, sourceName: "tipsme" as const,
      sourceMatchId: "tipsme-ambiguous", sourceUrl: "https://tipsme-web.azurewebsites.net/api/Score/odds/hkjc/tipsme-ambiguous",
    });
    expect(saveResearchInitialSnapshots("initial-ambiguous", {
      quotes: [quote(2.5, "O"), quote(2.5, "U"), quote(2.75, "O"), quote(2.75, "U")],
      missing: [{ provider: "pinnacle" as const, market: "COU" as const, note: "Pinnacle COU opening unavailable: Tipsme public v2 has no Pinnacle corner-opening source." }],
    }, now)).toBe(4);
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM research_timeline_snapshots WHERE match_id=? AND is_main=1",
    ).get("initial-ambiguous")).toEqual({ count: 0 });
    expect(rawDb.prepare(
      "SELECT note FROM research_timeline_points WHERE match_id=? AND stage='initial'",
    ).get("initial-ambiguous")).toEqual(expect.objectContaining({
      note: expect.stringContaining("Ambiguous initial lines retained; no main inferred: hkjc/OU=2 lines."),
    }));
  });

  it("matches public schedules and cannot write simulation or live snapshot tables", async () => {
    const now = Date.now();
    const kickoff = now + 90 * 60_000;
    addMatch("opening-isolated-7", kickoff, "主隊", "客隊");
    const beforeBets = rawDb.prepare("SELECT COUNT(*) count FROM simulation_bets").get() as { count: number };
    const beforeLive = rawDb.prepare("SELECT COUNT(*) count FROM odds_snapshots").get() as { count: number };
    const outcome = await collectResearchInitialSnapshots({
      fetchSchedule: async () => [{
        sourceMatchId: "tipsme-7",
        league: "研究聯賽",
        homeTeam: "主隊",
        awayTeam: "客隊",
        kickoffUtc: kickoff + 2 * 60_000,
      }],
      fetchOpening: async () => ({
        quotes: [
          {
            provider: "hkjc" as const, market: "AH" as const, lineValue: 0.25, isMain: false,
            selection: "H" as const, decimalOdds: 1.91, sourceUpdatedAt: now - 10_000,
            origin: "external_opening" as const, sourceName: "tipsme" as const,
            sourceMatchId: "tipsme-7", sourceUrl: "https://tipsme-web.azurewebsites.net/api/Score/odds/hkjc/tipsme-7",
          },
          {
            provider: "hkjc" as const, market: "AH" as const, lineValue: 0.25, isMain: false,
            selection: "A" as const, decimalOdds: 1.99, sourceUpdatedAt: now - 10_000,
            origin: "external_opening" as const, sourceName: "tipsme" as const,
            sourceMatchId: "tipsme-7", sourceUrl: "https://tipsme-web.azurewebsites.net/api/Score/odds/hkjc/tipsme-7",
          },
        ],
        missing: [{ provider: "pinnacle" as const, market: "COU" as const, note: "Pinnacle COU opening unavailable: Tipsme public v2 has no Pinnacle corner-opening source." }],
      }),
    }, now);
    expect(outcome).toMatchObject({ matched: 1, fetched: 1, inserted: 2 });
    expect(outcome.candidates).toBeGreaterThanOrEqual(1);
    expect(rawDb.prepare("SELECT COUNT(*) count FROM simulation_bets").get()).toEqual(beforeBets);
    expect(rawDb.prepare("SELECT COUNT(*) count FROM odds_snapshots").get()).toEqual(beforeLive);
  });

  it("distinguishes historical gaps from a genuinely missed live checkpoint", () => {
    const collectionStartedAt = Number((rawDb.prepare(
      "SELECT MIN(COALESCE(first_captured_at,created_at)) value FROM research_timeline_points",
    ).get() as { value: number }).value);
    const historicalKickoff = collectionStartedAt - 60 * 60_000;
    addMatch("historical-gap", historicalKickoff);
    rawDb.prepare(
      `INSERT INTO research_results(
        match_id,hkjc_id,home_score,away_score,corners_total,source,fetched_at
      ) VALUES(?,?,?,?,?,?,?)`,
    ).run("historical-gap", "historical-gap", 1, 0, 8, "test", collectionStartedAt);

    const missedKickoff = collectionStartedAt + 31 * 60_000;
    addMatch("missed-checkpoint", missedKickoff);
    rawDb.prepare(
      `INSERT INTO research_results(
        match_id,hkjc_id,home_score,away_score,corners_total,source,fetched_at
      ) VALUES(?,?,?,?,?,?,?)`,
    ).run("missed-checkpoint", "missed-checkpoint", 1, 1, 10, "test", missedKickoff + 60_000);

    const dataset = researchDataset(
      { days: 7, provider: "all", market: "all" },
      missedKickoff + 60_000,
    );
    const historical = dataset.matches.find((match) => match.matchId === "historical-gap");
    const missed = dataset.matches.find((match) => match.matchId === "missed-checkpoint");

    expect(historical?.timeline.T30.cells.hkjc.AH).toBe("historical_unavailable");
    expect(missed?.timeline.T30.cells.hkjc.AH).toBe("checkpoint_missed");
    expect(missed?.timeline.initial.cells.pinnacle.COU).toBe("source_unavailable");
    expect(dataset.summary.collectionStartedAt).toBe(collectionStartedAt);
  });
});
