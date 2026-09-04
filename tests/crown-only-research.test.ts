/**
 * Crown-driven fixture ingestion.
 *
 * The research view is now built from the Crown (titan007) schedule:
 *   (a) HKJC + Crown common fixtures  -> the HKJC row stays canonical
 *   (b) Crown-only fixtures (馬會無盤) -> a `fixture_source='crown'` row
 *   (c) Pinnacle-only fixtures         -> HIDDEN, prices still collected
 *
 * Chinese league/team labels come straight from the titan schedule, so no
 * translation round-trip is needed for Crown-only fixtures.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const dbPath = `/tmp/odds-radar-crown-only-${process.pid}.db`;
process.env.RADAR_DB = dbPath;

let rawDb: typeof import("../server/lib/store").rawDb;
let researchDataset: typeof import("../server/lib/research").researchDataset;
let RadarEngine: typeof import("../server/lib/engine").RadarEngine;
let prioritizeCrownResearchTargets: typeof import("../server/lib/engine").prioritizeCrownResearchTargets;
let CROWN_RESEARCH_LOOP_MS: number;
let PINNACLE_RESEARCH_LOOP_MS: number;
let AUTO_SCAN_CHECK_MS: number;

type TitanFixture = {
  providerMatchId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: number;
  statusText: string;
  homeScore: number | null;
  awayScore: number | null;
  halfHome: number | null;
  halfAway: number | null;
  handicapVal: number | null;
  totalVal: number | null;
};

const NOW = Date.now();

function titanFixture(
  providerMatchId: string,
  league: string,
  homeTeam: string,
  awayTeam: string,
  kickoffUtc: number,
): TitanFixture {
  return {
    providerMatchId,
    league,
    homeTeam,
    awayTeam,
    kickoffUtc,
    statusText: "未",
    homeScore: null,
    awayScore: null,
    halfHome: null,
    halfAway: null,
    handicapVal: null,
    totalVal: null,
  };
}

const CROWN_PRICES = {
  opening: [
    { market: "AH" as const, lineValue: -0.5, isMain: true, selection: "H", decimalOdds: 1.95 },
    { market: "AH" as const, lineValue: -0.5, isMain: true, selection: "A", decimalOdds: 1.90 },
    { market: "OU" as const, lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 1.92 },
    { market: "OU" as const, lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 1.93 },
  ],
  current: [
    { market: "AH" as const, lineValue: -0.5, isMain: true, selection: "H", decimalOdds: 1.88 },
    { market: "AH" as const, lineValue: -0.5, isMain: true, selection: "A", decimalOdds: 1.97 },
    { market: "OU" as const, lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 1.85 },
    { market: "OU" as const, lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 2.00 },
  ],
  sourceUrls: { AH: "https://vip.titan007.com/AsianOdds_n.aspx?id=1", OU: "https://vip.titan007.com/OverDown_n.aspx?id=1" },
};

const PINNACLE_PRICES = [
  { market: "OU" as const, lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 1.83 },
  { market: "OU" as const, lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 2.02 },
];

/** Engine with an already-warm fixture cache and stubbed Crown/Pinnacle detail. */
async function engineWith(titan: TitanFixture[]) {
  const engine = new RadarEngine();
  vi.spyOn(engine, "refreshHkjc").mockResolvedValue([] as never);
  (engine as unknown as { fixtureCache: unknown }).fixtureCache = {
    at: Date.now(),
    pinnapi: [],
    optic: [],
    titan,
  };
  const fetchCrown = vi.fn().mockResolvedValue(CROWN_PRICES);
  const fetchPinnacle = vi.fn().mockResolvedValue(PINNACLE_PRICES);
  const provider = (engine as unknown as {
    pinnacle: { fetchCrownResearchPrices: unknown; fetchMatchPrices: unknown };
  }).pinnacle;
  provider.fetchCrownResearchPrices = fetchCrown;
  provider.fetchMatchPrices = fetchPinnacle;
  return { engine, fetchCrown, fetchPinnacle };
}

function addHkjcFixture(id: string, titanId: string | null, kickoff: number): void {
  rawDb.prepare(
    `INSERT INTO matches(
      id,hkjc_id,fixture_source,titan_id,league,home_team,away_team,kickoff_utc,status,inplay,updated_at
    ) VALUES(?,?, 'hkjc',?,'英超','曼城','阿仙奴',?,'PREEVENT',0,?)`,
  ).run(id, id, titanId, kickoff, NOW);
}

function addPinnacleOnlyFixture(id: string, kickoff: number): void {
  rawDb.prepare(
    `INSERT INTO matches(
      id,hkjc_id,fixture_source,titan_id,pinnacle_match_id,league,home_team,away_team,
      kickoff_utc,status,inplay,updated_at
    ) VALUES(?,NULL,'pinnacle',NULL,?, 'Fiji Cup','Ba FC','Rewa FC',?,'PREEVENT',0,?)`,
  ).run(id, `pinnapi:${id.replace(/^pinnacle:/, "")}`, kickoff, NOW);
}

beforeAll(async () => {
  const store = await import("../server/lib/store");
  const research = await import("../server/lib/research");
  const engineModule = await import("../server/lib/engine");
  const scan = await import("../server/lib/scan");
  rawDb = store.rawDb;
  researchDataset = research.researchDataset;
  RadarEngine = engineModule.RadarEngine;
  prioritizeCrownResearchTargets = engineModule.prioritizeCrownResearchTargets;
  CROWN_RESEARCH_LOOP_MS = engineModule.CROWN_RESEARCH_LOOP_MS;
  PINNACLE_RESEARCH_LOOP_MS = engineModule.PINNACLE_RESEARCH_LOOP_MS;
  AUTO_SCAN_CHECK_MS = scan.AUTO_SCAN_CHECK_MS;
  store.migrate();
});

afterAll(() => {
  rawDb.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { rmSync(`${dbPath}${suffix}`); } catch { /* SQLite sidecar optional. */ }
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const table of [
    "research_timeline_snapshots", "research_timeline_points", "research_results",
    "odds_latest", "odds_snapshots", "market_lines", "ou_signal_observations",
    "ou_signal_prealerts", "matches",
  ]) {
    rawDb.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("Crown-driven ingestion", () => {
  it("creates a Crown-only fixture with Chinese labels straight from the titan schedule", async () => {
    const kickoff = NOW + 20 * 60_000;
    const { engine, fetchCrown, fetchPinnacle } = await engineWith([
      titanFixture("900001", "日職乙", "岡山綠雉", "德島漩渦", kickoff),
    ]);

    const outcome = await engine.refreshCrownOnlyResearch(NOW);
    expect(outcome).toEqual({ fixtures: 1, fetched: 1, failed: 0, rows: expect.any(Number) });
    expect(fetchCrown).toHaveBeenCalledWith("900001");
    expect(fetchPinnacle).toHaveBeenCalledWith("900001");

    const row = rawDb.prepare("SELECT * FROM matches WHERE id=?").get("crown:900001") as Record<string, unknown>;
    expect(row.fixture_source).toBe("crown");
    expect(row.titan_id).toBe("900001");
    expect(row.hkjc_id).toBeNull();
    expect(row.league).toBe("日職乙");
    expect(row.home_team).toBe("岡山綠雉");
    expect(row.away_team).toBe("德島漩渦");

    const dataset = researchDataset({ days: 7, provider: "all", market: "all" }, NOW);
    const match = dataset.matches.find((m) => m.matchId === "crown:900001");
    expect(match).toBeDefined();
    expect(match!.fixtureSource).toBe("crown");
    // 全部聯賽名同隊名要中文 — no translation backfill involved.
    expect(match!.league).toBe("日職乙");
    expect(match!.homeTeam).toBe("岡山綠雉");
    expect(match!.awayTeam).toBe("德島漩渦");
    expect(match!.titanId).toBe("900001");
  });

  it("persists the Crown opening, the current Crown prices and the Pinnacle prices", async () => {
    const kickoff = NOW + 20 * 60_000;
    const { engine } = await engineWith([titanFixture("900002", "英超", "阿仙奴", "利物浦", kickoff)]);
    await engine.refreshCrownOnlyResearch(NOW);

    const snapshots = rawDb.prepare(
      "SELECT provider,stage,market,origin FROM research_timeline_snapshots WHERE match_id=?",
    ).all("crown:900002") as Array<{ provider: string; stage: string; market: string; origin: string }>;
    // Crown opening (AH+OU) frozen as `initial` from the external opening page.
    const opening = snapshots.filter((s) => s.stage === "initial");
    expect(opening).toHaveLength(4);
    expect(opening.every((s) => s.provider === "crown" && s.origin === "external_opening")).toBe(true);
    // Current Crown + Pinnacle prices land on the live T30 checkpoint.
    const t30 = snapshots.filter((s) => s.stage === "T30");
    expect(new Set(t30.map((s) => s.provider))).toEqual(new Set(["crown", "pinnacle"]));
    expect(t30.filter((s) => s.provider === "pinnacle")).toHaveLength(2);

    const latest = rawDb.prepare(
      "SELECT DISTINCT provider FROM odds_latest WHERE match_id=? ORDER BY provider",
    ).all("crown:900002") as Array<{ provider: string }>;
    expect(latest.map((r) => r.provider)).toEqual(["crown", "pinnacle"]);
  });

  it("never shadows an HKJC-linked fixture: the common fixture appears exactly once", async () => {
    const kickoff = NOW + 20 * 60_000;
    addHkjcFixture("hkjc:common", "900003", kickoff);
    const { engine, fetchCrown } = await engineWith([
      titanFixture("900003", "英超", "曼城", "阿仙奴", kickoff),
      titanFixture("900004", "西乙", "希汗", "利雲特", kickoff),
    ]);

    const outcome = await engine.refreshCrownOnlyResearch(NOW);
    expect(outcome.fixtures).toBe(1); // only the Crown-only fixture
    expect(fetchCrown).toHaveBeenCalledTimes(1);
    expect(fetchCrown).toHaveBeenCalledWith("900004");
    expect(rawDb.prepare("SELECT COUNT(*) c FROM matches WHERE id=?").get("crown:900003")).toEqual({ c: 0 });

    const dataset = researchDataset({ days: 7, provider: "all", market: "all" }, NOW);
    const ids = dataset.matches.map((m) => m.matchId);
    expect(ids).toContain("hkjc:common");
    expect(ids).toContain("crown:900004");
    // titan 900003 is represented once, by the HKJC row.
    expect(ids).not.toContain("crown:900003");
    expect(dataset.matches.filter((m) => m.titanId === "900003").map((m) => m.matchId)).toEqual(["hkjc:common"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("skips fixtures that already kicked off", async () => {
    const { engine, fetchCrown } = await engineWith([
      titanFixture("900005", "英超", "車路士", "熱刺", NOW - 10 * 60_000),
    ]);
    expect(await engine.refreshCrownOnlyResearch(NOW)).toEqual({ fixtures: 0, fetched: 0, failed: 0, rows: 0 });
    expect(fetchCrown).not.toHaveBeenCalled();
    expect(rawDb.prepare("SELECT COUNT(*) c FROM matches").get()).toEqual({ c: 0 });
  });

  it("keeps a Crown detail failure from losing the fixture row", async () => {
    const kickoff = NOW + 20 * 60_000;
    const { engine } = await engineWith([titanFixture("900006", "英超", "般尼", "李斯特城", kickoff)]);
    (engine as unknown as { pinnacle: { fetchCrownResearchPrices: unknown } }).pinnacle
      .fetchCrownResearchPrices = vi.fn().mockRejectedValue(new Error("crown down"));

    const outcome = await engine.refreshCrownOnlyResearch(NOW);
    expect(outcome.fixtures).toBe(1);
    expect(outcome.failed).toBe(1);
    expect(rawDb.prepare("SELECT COUNT(*) c FROM matches WHERE id=?").get("crown:900006")).toEqual({ c: 1 });
    // Pinnacle still rides along for the same titan id.
    const pinnacle = rawDb.prepare(
      "SELECT COUNT(*) c FROM research_timeline_snapshots WHERE match_id=? AND provider='pinnacle'",
    ).get("crown:900006") as { c: number };
    expect(pinnacle.c).toBe(2);
  });

  it("hides Pinnacle-only fixtures from the dataset while Crown-only fixtures stay visible", async () => {
    const kickoff = NOW + 20 * 60_000;
    addPinnacleOnlyFixture("pinnacle:fiji-1", kickoff);
    const { engine } = await engineWith([titanFixture("900007", "英超", "愛華頓", "白禮頓", kickoff)]);
    await engine.refreshCrownOnlyResearch(NOW);

    const ids = researchDataset({ days: 7, provider: "all", market: "all" }, NOW).matches.map((m) => m.matchId);
    expect(ids).toContain("crown:900007");
    expect(ids).not.toContain("pinnacle:fiji-1");
    // The Pinnacle-only fixture row itself is untouched — prices keep flowing.
    expect(rawDb.prepare("SELECT COUNT(*) c FROM matches WHERE id=?").get("pinnacle:fiji-1")).toEqual({ c: 1 });
  });

  it("does not re-fetch a Crown fixture whose opening and current checkpoint are already stored", async () => {
    const kickoff = NOW + 20 * 60_000;
    const first = await engineWith([titanFixture("900008", "英超", "阿仙奴", "利物浦", kickoff)]);
    await first.engine.refreshCrownOnlyResearch(NOW);
    expect(first.fetchCrown).toHaveBeenCalledTimes(1);

    const second = await engineWith([titanFixture("900008", "英超", "阿仙奴", "利物浦", kickoff)]);
    const outcome = await second.engine.refreshCrownOnlyResearch(NOW);
    expect(second.fetchCrown).not.toHaveBeenCalled();
    expect(outcome).toEqual({ fixtures: 1, fetched: 0, failed: 0, rows: 0 });
  });

  it("runs from the research timeline tick after the Pinnacle-only collector", async () => {
    const kickoff = NOW + 20 * 60_000;
    const { engine, fetchCrown } = await engineWith([
      titanFixture("900009", "英超", "水晶宮", "富咸", kickoff),
    ]);
    vi.spyOn(engine, "refreshPinnacleFixtures").mockResolvedValue(0);
    const order: string[] = [];
    vi.spyOn(engine, "refreshPinnacleOnlyResearch").mockImplementation(async () => {
      order.push("pinnacle-only");
      return { fixtures: 0, fetched: 0, failed: 0, rows: 0 };
    });
    const crown = vi.spyOn(engine, "refreshCrownOnlyResearch");

    await expect(engine.runResearchTimelineTick()).resolves.toEqual({ selected: 0, detailCalls: 0 });
    expect(crown).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["pinnacle-only"]);
    expect(fetchCrown).toHaveBeenCalledWith("900009");
  });
});

describe("Crown research target prioritisation", () => {
  const MINUTE = 60_000;
  const base = 1_800_000_000_000;
  const target = (id: string, kickoffUtc: number) => ({
    matchId: `crown:${id}`,
    titanId: id,
    kickoffUtc,
    league: "英超",
    homeTeam: "主隊",
    awayTeam: "客隊",
  });

  it("must yield before the next automatic scan tick, together with the Pinnacle loop", () => {
    expect(CROWN_RESEARCH_LOOP_MS).toBeLessThan(AUTO_SCAN_CHECK_MS);
    expect(PINNACLE_RESEARCH_LOOP_MS + CROWN_RESEARCH_LOOP_MS).toBeLessThanOrEqual(AUTO_SCAN_CHECK_MS);
  });

  it("puts due milestones ahead of opening-only work, nearest kickoff first", () => {
    const result = prioritizeCrownResearchTargets(
      [
        target("opening-far", base + 6 * 60 * MINUTE),
        target("t30", base + 20 * MINUTE),
        target("t5", base + 3 * MINUTE),
      ],
      new Set(),
      new Set(),
      base,
    );
    expect(result.map((row) => [row.titanId, row.reason, row.stage])).toEqual([
      ["t5", "milestone", "T5"],
      ["t30", "milestone", "T30"],
      ["opening-far", "opening", null],
    ]);
  });

  it("skips fixtures with nothing left to collect and anything outside the 24-hour horizon", () => {
    const result = prioritizeCrownResearchTargets(
      [
        target("done", base + 20 * MINUTE),
        target("past", base),
        target("far", base + 24 * 60 * MINUTE + 1),
        target("needs-opening", base + 20 * MINUTE),
      ],
      new Set(["crown:done"]),
      new Set(["crown:done:T30"]),
      base,
    );
    expect(result.map((row) => row.titanId)).toEqual(["needs-opening"]);
  });
});
