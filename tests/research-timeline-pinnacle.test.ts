import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const dbPath = `/tmp/odds-radar-research-timeline-pinnacle-${process.pid}.db`;
process.env.RADAR_DB = dbPath;

let RadarEngine: typeof import("../server/lib/engine").RadarEngine;
let rawDb: typeof import("../server/lib/store").rawDb;
let researchMilestoneCapacity: typeof import("../server/lib/engine").researchMilestoneCapacity;
let researchMilestoneConcurrency: typeof import("../server/lib/engine").researchMilestoneConcurrency;
let MIN_RESEARCH_MILESTONE_TARGETS: number;
let MAX_RESEARCH_MILESTONE_TARGETS: number;
let RESEARCH_MILESTONE_CONCURRENCY: number;

const NOW = 1_900_000_000_000;

beforeAll(async () => {
  const store = await import("../server/lib/store");
  ({
    RadarEngine,
    researchMilestoneCapacity,
    researchMilestoneConcurrency,
    MIN_RESEARCH_MILESTONE_TARGETS,
    MAX_RESEARCH_MILESTONE_TARGETS,
    RESEARCH_MILESTONE_CONCURRENCY,
  } = await import("../server/lib/engine"));
  rawDb = store.rawDb;
  store.migrate();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const table of [
    "research_timeline_snapshots",
    "research_timeline_points",
    "odds_latest",
    "odds_snapshots",
    "market_lines",
    "pinnacle_source_map",
    "match_mapping",
    "matches",
  ]) {
    rawDb.prepare(`DELETE FROM ${table}`).run();
  }
});

afterAll(() => {
  rawDb.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { rmSync(`${dbPath}${suffix}`); } catch {
      // SQLite sidecar files may not exist.
    }
  }
});

function addHkjcFixture(
  id: string,
  kickoffUtc: number,
  pinnacleMatchId: string,
  source: { pinnapiId?: string; titanId?: string },
): void {
  rawDb.prepare(
    `INSERT INTO matches(
      id,hkjc_id,fixture_source,titan_id,pinnacle_match_id,
      league,home_team,away_team,kickoff_utc,status,inplay,updated_at
    ) VALUES(?,?,'hkjc',?,?, 'Test League','Home','Away',?,'PREEVENT',0,?)`,
  ).run(id, id.slice(5), source.titanId ?? null, pinnacleMatchId, kickoffUtc, NOW);
  rawDb.prepare(
    `INSERT INTO pinnacle_source_map(
      match_id,pinnapi_id,pinnapi_reversed,optic_id,optic_reversed,
      titan_id,titan_reversed,active_source,updated_at
    ) VALUES(?,?,0,NULL,0,?,0,?,?)`,
  ).run(
    id,
    source.pinnapiId ?? null,
    source.titanId ?? null,
    source.pinnapiId ? "pinnapi" : "titan007",
    NOW,
  );
}

function addPinnacleFixture(id: string, kickoffUtc: number, titanId: string): void {
  rawDb.prepare(
    `INSERT INTO matches(
      id,hkjc_id,fixture_source,titan_id,pinnacle_match_id,
      league,home_team,away_team,kickoff_utc,status,inplay,updated_at
    ) VALUES(?,NULL,'pinnacle',?,?,'Test League','Home','Away',?,'PREEVENT',0,?)`,
  ).run(id, titanId, `titan:${titanId}`, kickoffUtc, NOW);
  rawDb.prepare(
    `INSERT INTO pinnacle_source_map(
      match_id,pinnapi_id,pinnapi_reversed,optic_id,optic_reversed,
      titan_id,titan_reversed,active_source,updated_at
    ) VALUES(?,NULL,0,NULL,0,?,0,'titan007',?)`,
  ).run(id, titanId, NOW);
}

function currentAhOu() {
  return [
    { market: "AH" as const, lineValue: -0.25, isMain: true, selection: "H" as const, decimalOdds: 1.91 },
    { market: "AH" as const, lineValue: -0.25, isMain: true, selection: "A" as const, decimalOdds: 1.97 },
    { market: "OU" as const, lineValue: 2.5, isMain: true, selection: "O" as const, decimalOdds: 1.89 },
    { market: "OU" as const, lineValue: 2.5, isMain: true, selection: "U" as const, decimalOdds: 1.99 },
  ];
}

function isolateTimelinePreparation(engine: InstanceType<typeof RadarEngine>): void {
  vi.spyOn(engine as any, "refreshHkjc").mockResolvedValue(true);
  vi.spyOn(engine as any, "refreshPinnacleFixtures").mockResolvedValue(1);
  vi.spyOn(engine, "refreshPinnacleOnlyResearch").mockResolvedValue({
    fixtures: 0,
    fetched: 0,
    failed: 0,
    rows: 0,
  });
}

function capturedMarkets(matchId: string): Array<{ market: string; rows: number }> {
  return rawDb.prepare(
    `SELECT market,COUNT(*) rows
       FROM research_timeline_snapshots
      WHERE match_id=? AND provider='pinnacle' AND stage='T5'
      GROUP BY market ORDER BY market`,
  ).all(matchId) as Array<{ market: string; rows: number }>;
}

describe("runResearchTimelineTick Pinnacle checkpoints", () => {
  it("captures a mapped PinnAPI T5 checkpoint without relying on the dense scan", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const matchId = "hkjc:pinnapi-t5";
    addHkjcFixture(matchId, NOW + 4 * 60_000, "pinnapi:event-t5", {
      pinnapiId: "event-t5",
    });
    const engine = new RadarEngine();
    isolateTimelinePreparation(engine);
    const fetchMatchPrices = vi.fn().mockResolvedValue(currentAhOu());
    const fetchEventCornerLines = vi.fn().mockResolvedValue({ eventId: null, prices: [] });
    (engine as any).pinnapi.fetchMatchPrices = fetchMatchPrices;
    (engine as any).pinnapi.fetchEventCornerLines = fetchEventCornerLines;

    await expect(engine.runResearchTimelineTick()).resolves.toEqual({
      selected: 1,
      detailCalls: 1,
    });

    expect(fetchMatchPrices).toHaveBeenCalledOnce();
    expect(fetchMatchPrices).toHaveBeenCalledWith("event-t5");
    expect(capturedMarkets(matchId)).toEqual([
      { market: "AH", rows: 2 },
      { market: "OU", rows: 2 },
    ]);

    // Complete immutable Pinnacle AH/OU pairs are not selected or relabelled
    // by a later research tick in the same milestone.
    fetchMatchPrices.mockResolvedValue(currentAhOu().map((price) => ({
      ...price,
      decimalOdds: price.decimalOdds + 0.2,
    })));
    await expect(engine.runResearchTimelineTick()).resolves.toEqual({
      selected: 0,
      detailCalls: 0,
    });
    expect(fetchMatchPrices).toHaveBeenCalledOnce();
    expect(rawDb.prepare(
      `SELECT decimal_odds FROM research_timeline_snapshots
        WHERE match_id=? AND provider='pinnacle' AND stage='T5'
          AND market='OU' AND selection='O'`,
    ).get(matchId)).toEqual({ decimal_odds: 1.89 });
  });

  it("uses Titan only as the existing unmapped fallback for a due T5 checkpoint", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const matchId = "hkjc:titan-t5";
    addHkjcFixture(matchId, NOW + 3 * 60_000, "titan:titan-t5", {
      titanId: "titan-t5",
    });
    const engine = new RadarEngine();
    isolateTimelinePreparation(engine);
    const fetchTitan = vi.fn().mockResolvedValue(currentAhOu());
    const fetchCrown = vi.fn().mockResolvedValue([]);
    (engine as any).pinnacle.fetchMatchPrices = fetchTitan;
    (engine as any).pinnacle.fetchCrownMatchPrices = fetchCrown;
    const fetchPinnapi = vi.fn();
    (engine as any).pinnapi.fetchMatchPrices = fetchPinnapi;

    await expect(engine.runResearchTimelineTick()).resolves.toEqual({
      selected: 1,
      detailCalls: 1,
    });

    expect(fetchTitan).toHaveBeenCalledOnce();
    expect(fetchTitan).toHaveBeenCalledWith("titan-t5");
    expect(fetchPinnapi).not.toHaveBeenCalled();
    expect(capturedMarkets(matchId)).toEqual([
      { market: "AH", rows: 2 },
      { market: "OU", rows: 2 },
    ]);
  });

  it("retries a partial T5 checkpoint without replacing the earlier pair", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const matchId = "hkjc:retry-partial-t5";
    addHkjcFixture(matchId, NOW + 2 * 60_000, "pinnapi:retry-event", {
      pinnapiId: "retry-event",
    });
    const engine = new RadarEngine();
    isolateTimelinePreparation(engine);
    const firstOu = currentAhOu()
      .filter((price) => price.market === "OU")
      .map((price) => ({ ...price, decimalOdds: price.decimalOdds - 0.1 }));
    const fetchMatchPrices = vi.fn()
      .mockResolvedValueOnce(firstOu)
      .mockResolvedValueOnce(currentAhOu());
    (engine as any).pinnapi.fetchMatchPrices = fetchMatchPrices;
    (engine as any).pinnapi.fetchEventCornerLines = vi.fn()
      .mockResolvedValue({ eventId: null, prices: [] });

    await expect(engine.runResearchTimelineTick()).resolves.toEqual({
      selected: 1,
      detailCalls: 1,
    });
    expect(capturedMarkets(matchId)).toEqual([{ market: "OU", rows: 2 }]);

    await expect(engine.runResearchTimelineTick()).resolves.toEqual({
      selected: 1,
      detailCalls: 1,
    });
    expect(fetchMatchPrices).toHaveBeenCalledTimes(2);
    expect(capturedMarkets(matchId)).toEqual([
      { market: "AH", rows: 2 },
      { market: "OU", rows: 2 },
    ]);
    const frozenOu = rawDb.prepare(
      `SELECT decimal_odds FROM research_timeline_snapshots
        WHERE match_id=? AND provider='pinnacle' AND stage='T5'
          AND market='OU' AND selection='O'`,
    ).get(matchId) as { decimal_odds: number };
    expect(frozenOu.decimal_odds).toBeCloseTo(1.79);
  });

  it("does not select or capture a mapped fixture after kickoff", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const matchId = "hkjc:already-started";
    addHkjcFixture(matchId, NOW - 1, "pinnapi:past-event", {
      pinnapiId: "past-event",
    });
    const engine = new RadarEngine();
    isolateTimelinePreparation(engine);
    const fetchMatchPrices = vi.fn().mockResolvedValue(currentAhOu());
    (engine as any).pinnapi.fetchMatchPrices = fetchMatchPrices;

    await expect(engine.runResearchTimelineTick()).resolves.toEqual({
      selected: 0,
      detailCalls: 0,
    });

    expect(fetchMatchPrices).not.toHaveBeenCalled();
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM research_timeline_snapshots WHERE match_id=?",
    ).get(matchId)).toEqual({ count: 0 });
  });
});

describe("runResearchMilestoneTick fast checkpoint collector", () => {
  it("captures a persisted Pinnacle-only fixture without running discovery", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const matchId = "pinnacle:fast-t5";
    addPinnacleFixture(matchId, NOW + 4 * 60_000, "fast-t5");
    const engine = new RadarEngine();
    const fetchTitan = vi.fn().mockResolvedValue({
      opening: [],
      current: currentAhOu(),
      sourceUrls: { AH: "ah", OU: "ou" },
    });
    (engine as any).pinnacle.fetchPinnacleResearchPrices = fetchTitan;
    const refreshHkjc = vi.spyOn(engine as any, "refreshHkjc");
    const refreshFixtures = vi.spyOn(engine as any, "refreshPinnacleFixtures");

    await expect(engine.runResearchMilestoneTick()).resolves.toMatchObject({
      selected: 1,
      attempted: 1,
      fetched: 1,
      failed: 0,
      rows: 4,
    });

    expect(fetchTitan).toHaveBeenCalledWith("fast-t5", {
      timeoutMs: 4_000,
      retries: 1,
    });
    expect(refreshHkjc).not.toHaveBeenCalled();
    expect(refreshFixtures).not.toHaveBeenCalled();
    expect(capturedMarkets(matchId)).toEqual([
      { market: "AH", rows: 2 },
      { market: "OU", rows: 2 },
    ]);
  });

  it("uses response completion time and never fabricates a missed checkpoint", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(NOW)
      .mockReturnValue(NOW + 6 * 60_000);
    const matchId = "pinnacle:late-response";
    addPinnacleFixture(matchId, NOW + 4 * 60_000, "late-response");
    const engine = new RadarEngine();
    (engine as any).pinnacle.fetchPinnacleResearchPrices = vi.fn().mockResolvedValue({
      opening: [],
      current: currentAhOu(),
      sourceUrls: { AH: "ah", OU: "ou" },
    });

    await expect(engine.runResearchMilestoneTick()).resolves.toMatchObject({
      selected: 1,
      attempted: 1,
      fetched: 0,
      failed: 1,
      rows: 0,
    });
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM research_timeline_snapshots WHERE match_id=?",
    ).get(matchId)).toEqual({ count: 0 });
  });

  it("uses the active source per market and fills a missing market from fallback", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const matchId = "hkjc:market-aware-fallback";
    addHkjcFixture(matchId, NOW + 4 * 60_000, "titan:market-aware", {
      pinnapiId: "pinnapi-market-aware",
      titanId: "market-aware",
    });
    rawDb.prepare(
      "UPDATE pinnacle_source_map SET active_source='titan007' WHERE match_id=?",
    ).run(matchId);
    const engine = new RadarEngine();
    (engine as any).pinnacle.fetchPinnacleResearchPrices = vi.fn().mockResolvedValue({
      opening: [],
      current: currentAhOu().filter((price) => price.market === "AH"),
      sourceUrls: { AH: "ah", OU: "ou" },
    });
    (engine as any).pinnapi.fetchMatchPrices = vi.fn().mockResolvedValue(
      currentAhOu().filter((price) => price.market === "OU"),
    );

    await expect(engine.runResearchMilestoneTick()).resolves.toMatchObject({
      selected: 1,
      fetched: 1,
      failed: 0,
      rows: 4,
    });
    expect(rawDb.prepare(
      `SELECT market,source_name,COUNT(*) rows
         FROM research_timeline_snapshots
        WHERE match_id=? AND stage='T5'
        GROUP BY market,source_name ORDER BY market`,
    ).all(matchId)).toEqual([
      { market: "AH", source_name: "titan007-pinnacle", rows: 2 },
      { market: "OU", source_name: "pinnapi", rows: 2 },
    ]);
  });

  it("prioritizes T5 but no longer drops the rest of the window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    for (let i = 0; i < 13; i++) {
      addPinnacleFixture(`pinnacle:t5-${i}`, NOW + (i + 1) * 10_000, `t5-${i}`);
    }
    addPinnacleFixture("pinnacle:t15", NOW + 10 * 60_000, "t15");
    addPinnacleFixture("pinnacle:t30", NOW + 20 * 60_000, "t30");
    const engine = new RadarEngine();
    const requested: string[] = [];
    (engine as any).pinnacle.fetchPinnacleResearchPrices = vi.fn(async (id: string) => {
      requested.push(id);
      return {
        opening: [],
        current: currentAhOu(),
        sourceUrls: { AH: "ah", OU: "ou" },
      };
    });

    await expect(engine.runResearchMilestoneTick()).resolves.toMatchObject({
      selected: 15,
      attempted: 15,
      fetched: 15,
    });
    // T5 keeps absolute priority, but T15/T30 in the same window are served in
    // the same tick instead of being starved by a fixed 12-fixture slice.
    expect(requested.slice(0, 13).every((id) => id.startsWith("t5-"))).toBe(true);
    expect(requested).toContain("t15");
    expect(requested).toContain("t30");
  });

  it("scales the per-tick budget past the capacity floor and honours the ceiling", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    for (let i = 0; i < 60; i++) {
      addPinnacleFixture(`pinnacle:burst-${i}`, NOW + 16 * 60_000 + i * 1_000, `burst-${i}`);
    }
    const engine = new RadarEngine();
    (engine as any).pinnacle.fetchPinnacleResearchPrices = vi.fn().mockResolvedValue({
      opening: [],
      current: currentAhOu(),
      sourceUrls: { AH: "ah", OU: "ou" },
    });

    await expect(engine.runResearchMilestoneTick()).resolves.toMatchObject({
      selected: 60,
      attempted: 60,
      fetched: 60,
    });
  });
});

describe("milestone capacity helpers", () => {
  it("never selects fewer than the floor and never exceeds the ceiling", () => {
    expect(researchMilestoneCapacity(3, {})).toBe(MIN_RESEARCH_MILESTONE_TARGETS);
    expect(researchMilestoneCapacity(120, {})).toBe(120);
    expect(researchMilestoneCapacity(5_000, {})).toBe(MAX_RESEARCH_MILESTONE_TARGETS);
    expect(researchMilestoneCapacity(5_000, { RADAR_MILESTONE_MAX_TARGETS: "90" })).toBe(90);
    expect(researchMilestoneCapacity(5_000, { RADAR_MILESTONE_MAX_TARGETS: "nope" }))
      .toBe(MAX_RESEARCH_MILESTONE_TARGETS);
  });

  it("caps worker fan-out by the work available", () => {
    expect(researchMilestoneConcurrency(0, {})).toBe(0);
    expect(researchMilestoneConcurrency(3, {})).toBe(3);
    expect(researchMilestoneConcurrency(100, {})).toBe(RESEARCH_MILESTONE_CONCURRENCY);
    expect(researchMilestoneConcurrency(100, { RADAR_MILESTONE_CONCURRENCY: "24" })).toBe(24);
    expect(researchMilestoneConcurrency(100, { RADAR_MILESTONE_CONCURRENCY: "999" })).toBe(64);
  });
});
