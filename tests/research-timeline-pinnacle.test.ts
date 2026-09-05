import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const dbPath = `/tmp/odds-radar-research-timeline-pinnacle-${process.pid}.db`;
process.env.RADAR_DB = dbPath;

let RadarEngine: typeof import("../server/lib/engine").RadarEngine;
let rawDb: typeof import("../server/lib/store").rawDb;
let researchMilestoneCapacity: typeof import("../server/lib/engine").researchMilestoneCapacity;
let allocateMilestoneTargets: typeof import("../server/lib/engine").allocateMilestoneTargets;
let allocateMilestoneTargetsBySource:
  typeof import("../server/lib/engine").allocateMilestoneTargetsBySource;
let orderMilestoneTargetsForDispatch:
  typeof import("../server/lib/engine").orderMilestoneTargetsForDispatch;
let researchMilestoneConcurrency: typeof import("../server/lib/engine").researchMilestoneConcurrency;
let isOuNotificationSenderProcess:
  typeof import("../server/lib/engine").isOuNotificationSenderProcess;
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
    isOuNotificationSenderProcess,
    allocateMilestoneTargets,
    allocateMilestoneTargetsBySource,
    orderMilestoneTargetsForDispatch,
    MIN_RESEARCH_MILESTONE_TARGETS,
    MAX_RESEARCH_MILESTONE_TARGETS,
    RESEARCH_MILESTONE_CONCURRENCY,
  } = await import("../server/lib/engine"));
  rawDb = store.rawDb;
  store.migrate();
});

describe("OU notification sender ownership", () => {
  it("assigns production delivery exclusively to the milestone worker", () => {
    expect(isOuNotificationSenderProcess("production", true, undefined)).toBe(false);
    expect(isOuNotificationSenderProcess("production", false, "collector")).toBe(false);
    expect(isOuNotificationSenderProcess("production", false, "milestone")).toBe(true);
    expect(isOuNotificationSenderProcess("test", true, undefined)).toBe(true);
  });

  it("lets collectors request a pass but only the designated sender complete it", async () => {
    const collector = new RadarEngine({ ouNotificationSender: false });
    await (collector as any).syncAndDrainOuNotifications([], "collector-test");
    expect(rawDb.prepare(
      `SELECT requested_version,completed_version
         FROM ou_notification_drain_state WHERE singleton=1`,
    ).get()).toEqual({ requested_version: 1, completed_version: 0 });

    const milestone = new RadarEngine({ ouNotificationSender: true });
    await (milestone as any).syncAndDrainOuNotifications([], "milestone-test");
    expect(rawDb.prepare(
      `SELECT requested_version,completed_version
         FROM ou_notification_drain_state WHERE singleton=1`,
    ).get()).toEqual({ requested_version: 2, completed_version: 2 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const table of [
    "ou_signal_prealerts",
    "ou_signal_observations",
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
  rawDb.prepare(
    `UPDATE ou_notification_drain_state
        SET requested_version=0,completed_version=0`,
  ).run();
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
  it("aborts an in-flight Titan fixture refresh when the core milestone starts", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const engine = new RadarEngine();
    vi.spyOn(engine as any, "refreshHkjc").mockResolvedValue(true);
    (engine as any).pinnapi.status = vi.fn().mockReturnValue({ configured: false });
    (engine as any).optic.fetchFixtures = vi.fn().mockResolvedValue([]);
    const fetchTitanLiveFixtures = vi.fn();
    (engine as any).pinnacle.fetchTitanLiveFixtures = fetchTitanLiveFixtures;
    let fixtureSignal: AbortSignal | undefined;
    let fixtureStarted!: () => void;
    const started = new Promise<void>((resolve) => { fixtureStarted = resolve; });
    (engine as any).pinnacle.fetchTitanResearchFixtures = vi.fn(
      (_days: number[], options: { signal: AbortSignal }) => {
        fixtureSignal = options.signal;
        fixtureStarted();
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );
    const timelineRun = engine.runResearchTimelineTick({ captureMilestones: false });
    await started;

    await expect(engine.runResearchMilestoneTick()).resolves.toMatchObject({
      selected: 0,
      attempted: 0,
    });
    await expect(timelineRun).resolves.toEqual({ selected: 0, detailCalls: 0 });
    expect(fixtureSignal?.aborted).toBe(true);
    expect(fetchTitanLiveFixtures).not.toHaveBeenCalled();
  });

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
  it("finishes HKJC + Pinnacle before starting a Pinnacle + Crown fixture", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    addHkjcFixture("hkjc:priority-t30", NOW + 20 * 60_000, "pinnapi:priority-t30", {
      pinnapiId: "priority-t30",
    });
    addPinnacleFixture("pinnacle:crown-t5", NOW + 4 * 60_000, "crown-t5");
    const engine = new RadarEngine();
    const notificationDrain = vi.spyOn(
      engine as any,
      "syncAndDrainOuNotifications",
    ).mockResolvedValue(undefined);
    const requested: string[] = [];
    (engine as any).pinnapi.fetchMatchPrices = vi.fn(async (id: string) => {
      requested.push(`hkjc:${id}`);
      return currentAhOu();
    });
    (engine as any).pinnacle.fetchPinnacleResearchPrices = vi.fn(async (id: string) => {
      requested.push(`crown:${id}`);
      return {
        opening: [],
        current: currentAhOu(),
        sourceUrls: { AH: "ah", OU: "ou" },
      };
    });

    await expect(engine.runResearchMilestoneTick()).resolves.toMatchObject({
      selected: 1,
      selectedHkjcPinnacle: 1,
      selectedPinnacleCrown: 0,
      attempted: 1,
      fetched: 1,
    });
    await expect(engine.runResearchLowerMilestoneTick()).resolves.toMatchObject({
      selectedHkjcPinnacle: 0,
      selectedPinnacleCrown: 1,
      attempted: 1,
      fetched: 1,
    });
    expect(requested).toEqual(["hkjc:priority-t30", "crown:crown-t5"]);
    expect(notificationDrain).toHaveBeenCalledWith(["hkjc:priority-t30"], "research_milestone");
    expect(notificationDrain).toHaveBeenCalledWith(
      ["pinnacle:crown-t5"],
      "research_milestone_lower_tier",
      true,
    );
  });

  it("guarantees a bounded Pinnacle + Crown wave after tier 1 exhausts the normal deadline", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(NOW)
      .mockReturnValue(NOW + 20_001);
    addHkjcFixture("hkjc:deadline-priority", NOW + 20 * 60_000, "pinnapi:deadline-priority", {
      pinnapiId: "deadline-priority",
    });
    for (let i = 0; i < RESEARCH_MILESTONE_CONCURRENCY + 2; i++) {
      addPinnacleFixture(
        `pinnacle:deadline-crown-${i}`,
        NOW + 4 * 60_000,
        `deadline-crown-${i}`,
      );
    }
    const engine = new RadarEngine();
    vi.spyOn(engine as any, "syncAndDrainOuNotifications").mockResolvedValue(undefined);
    (engine as any).pinnapi.fetchMatchPrices = vi.fn().mockResolvedValue(currentAhOu());
    const fetchTitan = vi.fn().mockResolvedValue({
      opening: [],
      current: currentAhOu(),
      sourceUrls: { AH: "ah", OU: "ou" },
    });
    (engine as any).pinnacle.fetchPinnacleResearchPrices = fetchTitan;

    await expect(engine.runResearchMilestoneTick()).resolves.toMatchObject({
      selectedHkjcPinnacle: 1,
      selectedPinnacleCrown: 0,
      attemptedBySource: {
        "hkjc-pinnacle": 1,
        "pinnacle-crown": 0,
      },
      deadlineSkippedBySource: {
        "hkjc-pinnacle": 0,
        "pinnacle-crown": 0,
      },
    });
    await expect(engine.runResearchLowerMilestoneTick()).resolves.toMatchObject({
      selectedHkjcPinnacle: 0,
      selectedPinnacleCrown: RESEARCH_MILESTONE_CONCURRENCY,
      attemptedBySource: {
        "hkjc-pinnacle": 0,
        "pinnacle-crown": RESEARCH_MILESTONE_CONCURRENCY,
      },
    });
    expect(fetchTitan).toHaveBeenCalledTimes(RESEARCH_MILESTONE_CONCURRENCY);
  });

  it("aborts an in-flight lower-tier Titan request when the core milestone starts", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const crownMatchId = "pinnacle:interruptible";
    addPinnacleFixture(crownMatchId, NOW + 4 * 60_000, "interruptible");
    addHkjcFixture("hkjc:interrupt-priority", NOW + 20 * 60_000, "pinnapi:interrupt-priority", {
      pinnapiId: "interrupt-priority",
    });
    const engine = new RadarEngine();
    (engine as any).fixtureCache = {
      at: NOW,
      pinnapi: [],
      optic: [],
      titan: [{
        providerMatchId: "interruptible",
        league: "Test League",
        homeTeam: "Home",
        awayTeam: "Away",
        kickoffUtc: NOW + 4 * 60_000,
        statusText: "PREEVENT",
        homeScore: null,
        awayScore: null,
        halfHome: null,
        halfAway: null,
        handicapVal: 0.25,
        totalVal: 2.5,
      }],
    };
    let lowerSignal: AbortSignal | undefined;
    let lowerStarted!: () => void;
    const started = new Promise<void>((resolve) => { lowerStarted = resolve; });
    const fetchTitan = vi.fn()
      .mockImplementationOnce((_id: string, options: { signal: AbortSignal }) => {
        lowerSignal = options.signal;
        lowerStarted();
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      })
      .mockResolvedValue({
        opening: [],
        current: currentAhOu(),
        sourceUrls: { AH: "ah", OU: "ou" },
      });
    (engine as any).pinnacle.fetchPinnacleResearchPrices = fetchTitan;
    (engine as any).pinnapi.fetchMatchPrices = vi.fn().mockResolvedValue(currentAhOu());

    const lowerTierRun = engine.refreshPinnacleOnlyResearch(NOW);
    await started;
    await expect(engine.runResearchMilestoneTick()).resolves.toMatchObject({
      selectedHkjcPinnacle: 1,
      fetched: 1,
    });
    await expect(lowerTierRun).resolves.toMatchObject({ fetched: 0 });
    expect(lowerSignal?.aborted).toBe(true);
  });

  it("aborts an in-flight lower-tier PinnAPI fallback when the core milestone starts", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const crownMatchId = "pinnacle:interruptible-fallback";
    addPinnacleFixture(crownMatchId, NOW + 4 * 60_000, "interruptible-fallback");
    rawDb.prepare(
      "UPDATE pinnacle_source_map SET pinnapi_id=?,active_source='titan007' WHERE match_id=?",
    ).run("fallback-event", crownMatchId);
    addHkjcFixture("hkjc:fallback-priority", NOW + 20 * 60_000, "pinnapi:fallback-priority", {
      pinnapiId: "fallback-priority",
    });
    const engine = new RadarEngine();
    (engine as any).fixtureCache = {
      at: NOW,
      pinnapi: [],
      optic: [],
      titan: [{
        providerMatchId: "interruptible-fallback",
        league: "Test League",
        homeTeam: "Home",
        awayTeam: "Away",
        kickoffUtc: NOW + 4 * 60_000,
        statusText: "PREEVENT",
        homeScore: null,
        awayScore: null,
        halfHome: null,
        halfAway: null,
        handicapVal: 0.25,
        totalVal: 2.5,
      }],
    };
    (engine as any).pinnacle.fetchPinnacleResearchPrices = vi.fn().mockResolvedValue({
      opening: [],
      current: [],
      sourceUrls: { AH: "ah", OU: "ou" },
    });
    let fallbackSignal: AbortSignal | undefined;
    let fallbackStarted!: () => void;
    const started = new Promise<void>((resolve) => { fallbackStarted = resolve; });
    let firstFallback = true;
    (engine as any).pinnapi.fetchMatchPrices = vi.fn(
      (id: string, options: { signal?: AbortSignal } = {}) => {
        if (id !== "fallback-event" || !firstFallback) return Promise.resolve(currentAhOu());
        firstFallback = false;
        fallbackSignal = options.signal;
        fallbackStarted();
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );

    const lowerTierRun = engine.refreshPinnacleOnlyResearch(NOW);
    await started;
    await expect(engine.runResearchMilestoneTick()).resolves.toMatchObject({
      selectedHkjcPinnacle: 1,
      fetched: 1,
    });
    await expect(lowerTierRun).resolves.toMatchObject({ fetched: 0 });
    expect(fallbackSignal?.aborted).toBe(true);
  });

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

    await expect(engine.runResearchLowerMilestoneTick()).resolves.toMatchObject({
      selected: 1,
      attempted: 1,
      fetched: 1,
      failed: 0,
      rows: 4,
    });

    expect(fetchTitan).toHaveBeenCalledWith("fast-t5", expect.objectContaining({
      timeoutMs: 4_000,
      retries: 0,
    }));
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

    await expect(engine.runResearchLowerMilestoneTick()).resolves.toMatchObject({
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

    await expect(engine.runResearchLowerMilestoneTick()).resolves.toMatchObject({
      selected: 15,
      attempted: RESEARCH_MILESTONE_CONCURRENCY - 1,
      fetched: RESEARCH_MILESTONE_CONCURRENCY - 1,
    });
    // T5 keeps the largest dispatch share, while T15/T30 are interleaved into
    // the first worker wave so an upstream slowdown cannot strand them.
    expect(requested.slice(0, 4).filter((id) => id.startsWith("t5-"))).toHaveLength(2);
    expect(requested.slice(0, 4)).toContain("t15");
    expect(requested.slice(0, 4)).toContain("t30");
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

    await expect(engine.runResearchLowerMilestoneTick()).resolves.toMatchObject({
      selected: RESEARCH_MILESTONE_CONCURRENCY,
      attempted: RESEARCH_MILESTONE_CONCURRENCY,
      fetched: RESEARCH_MILESTONE_CONCURRENCY,
    });
    expect((engine as any).pinnacle.fetchPinnacleResearchPrices)
      .toHaveBeenCalledTimes(RESEARCH_MILESTONE_CONCURRENCY);
  });

  it("rotates disposable one-worker lower-tier waves across T5, T15 and T30", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const previous = process.env.RADAR_MILESTONE_CONCURRENCY;
    process.env.RADAR_MILESTONE_CONCURRENCY = "1";
    addPinnacleFixture("pinnacle:rotate-t5-a", NOW + 3 * 60_000, "rotate-t5-a");
    addPinnacleFixture("pinnacle:rotate-t5-b", NOW + 4 * 60_000, "rotate-t5-b");
    addPinnacleFixture("pinnacle:rotate-t15", NOW + 10 * 60_000, "rotate-t15");
    addPinnacleFixture("pinnacle:rotate-t30", NOW + 20 * 60_000, "rotate-t30");
    const requested: string[] = [];

    try {
      for (let i = 0; i < 4; i++) {
        // Production creates a fresh disposable worker for each lower cycle,
        // so fairness must come from the owner-provided offset rather than
        // mutable state retained by one RadarEngine instance.
        const engine = new RadarEngine();
        (engine as any).pinnacle.fetchPinnacleResearchPrices = vi.fn(async (id: string) => {
          requested.push(id);
          throw new Error("simulated provider failure");
        });
        await engine.runResearchLowerMilestoneTick(i);
      }
    } finally {
      if (previous === undefined) delete process.env.RADAR_MILESTONE_CONCURRENCY;
      else process.env.RADAR_MILESTONE_CONCURRENCY = previous;
    }
    expect(requested).toEqual([
      "rotate-t5-a",
      "rotate-t5-b",
      "rotate-t15",
      "rotate-t30",
    ]);
  });

  it("advances disposable lower-tier offsets by a whole concurrent wave", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const previous = process.env.RADAR_MILESTONE_CONCURRENCY;
    process.env.RADAR_MILESTONE_CONCURRENCY = "4";
    for (let i = 0; i < 8; i++) {
      addPinnacleFixture(
        `pinnacle:wave-${i}`,
        NOW + (3 * 60_000) + i * 1_000,
        `wave-${i}`,
      );
    }
    const requested: string[] = [];

    try {
      for (let sequence = 0; sequence < 2; sequence++) {
        const engine = new RadarEngine();
        (engine as any).pinnacle.fetchPinnacleResearchPrices = vi.fn(async (id: string) => {
          requested.push(id);
          throw new Error("simulated provider failure");
        });
        await engine.runResearchLowerMilestoneTick(sequence);
      }
    } finally {
      if (previous === undefined) delete process.env.RADAR_MILESTONE_CONCURRENCY;
      else process.env.RADAR_MILESTONE_CONCURRENCY = previous;
    }

    expect(requested).toEqual([
      "wave-0",
      "wave-1",
      "wave-2",
      "wave-3",
      "wave-4",
      "wave-5",
      "wave-6",
      "wave-7",
    ]);
  });

  it("keeps a stalled lower worker from blocking an independent core worker", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    addPinnacleFixture("pinnacle:detached-stall", NOW + 4 * 60_000, "detached-stall");
    const lowerEngine = new RadarEngine();
    const coreEngine = new RadarEngine();
    vi.spyOn(lowerEngine as any, "syncAndDrainOuNotifications").mockResolvedValue(undefined);
    vi.spyOn(coreEngine as any, "syncAndDrainOuNotifications").mockResolvedValue(undefined);
    let markStarted!: () => void;
    const lowerStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const fetchTitan = vi.fn()
      .mockImplementationOnce(() => {
        markStarted();
        return new Promise(() => undefined);
      })
      .mockResolvedValue({
        opening: [],
        current: currentAhOu(),
        sourceUrls: { AH: "ah", OU: "ou" },
      });
    (lowerEngine as any).pinnacle.fetchPinnacleResearchPrices = fetchTitan;
    (coreEngine as any).pinnapi.fetchMatchPrices = vi.fn().mockResolvedValue(currentAhOu());

    void lowerEngine.runResearchLowerMilestoneTick();
    await lowerStarted;

    addHkjcFixture("hkjc:next-core", NOW + 20 * 60_000, "pinnapi:next-core", {
      pinnapiId: "next-core",
    });
    await expect(coreEngine.runResearchMilestoneTick()).resolves.toMatchObject({
      selectedHkjcPinnacle: 1,
      attempted: 1,
      fetched: 1,
    });
  });

  it("fails lower-tier SQLite capture fast under writer contention and restores the timeout", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    addPinnacleFixture("pinnacle:locked-write", NOW + 4 * 60_000, "locked-write");
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const blocker = new BetterSqlite3(dbPath);
    blocker.pragma("journal_mode = WAL");
    blocker.pragma("busy_timeout = 1");
    const engine = new RadarEngine();
    let releaseProvider!: (value: {
      opening: never[];
      current: ReturnType<typeof currentAhOu>;
      sourceUrls: { AH: string; OU: string };
    }) => void;
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    (engine as any).pinnacle.fetchPinnacleResearchPrices = vi.fn().mockReturnValue(new Promise(
      (resolve) => {
        releaseProvider = resolve;
        markProviderStarted();
      },
    ));

    try {
      const lowerRun = engine.runResearchLowerMilestoneTick();
      await providerStarted;
      blocker.exec("BEGIN IMMEDIATE");
      const started = process.hrtime.bigint();
      releaseProvider({
        opening: [],
        current: currentAhOu(),
        sourceUrls: { AH: "ah", OU: "ou" },
      });
      await lowerRun;
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      expect(elapsedMs).toBeLessThan(1_000);
      expect(rawDb.pragma("busy_timeout", { simple: true })).toBe(5_000);
      expect(rawDb.prepare(
        "SELECT COUNT(*) count FROM research_timeline_snapshots WHERE match_id=?",
      ).get("pinnacle:locked-write")).toEqual({ count: 0 });
    } finally {
      if (blocker.inTransaction) blocker.exec("ROLLBACK");
      blocker.close();
    }
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

describe("per-stage fair allocation", () => {
  const make = (stage: "T30" | "T15" | "T5", n: number) =>
    Array.from({ length: n }, (_, i) => ({ stage, id: `${stage}-${i}` }));

  it("returns everything when the budget is not binding", () => {
    const targets = [...make("T5", 3), ...make("T30", 2)];
    expect(allocateMilestoneTargets(targets, 10)).toHaveLength(5);
  });

  it("keeps guaranteed floors for T30 and T15 when T5 would take the tick", () => {
    const targets = [...make("T5", 200), ...make("T15", 50), ...make("T30", 50)];
    const picked = allocateMilestoneTargets(targets, 100);
    expect(picked).toHaveLength(100);
    const count = (stage: string) => picked.filter((t) => t.stage === stage).length;
    // 40% floor for T30 and 25% for T15; T5 still claims every free slot.
    expect(count("T30")).toBe(40);
    expect(count("T15")).toBe(25);
    expect(count("T5")).toBe(35);
    // Execution order stays T5 -> T15 -> T30.
    expect(picked[0].stage).toBe("T5");
    expect(picked[picked.length - 1].stage).toBe("T30");
  });

  it("gives unused reserved slots back to T5", () => {
    const targets = [...make("T5", 100), ...make("T30", 3)];
    const picked = allocateMilestoneTargets(targets, 20);
    expect(picked.filter((t) => t.stage === "T30")).toHaveLength(3);
    expect(picked.filter((t) => t.stage === "T5")).toHaveLength(17);
  });

  it("handles an empty budget", () => {
    expect(allocateMilestoneTargets(make("T5", 5), 0)).toEqual([]);
  });
});

describe("source-tier allocation", () => {
  const make = (
    sourceTier: "hkjc-pinnacle" | "pinnacle-crown",
    stage: "T30" | "T15" | "T5",
    n: number,
  ) => Array.from({ length: n }, (_, i) => ({
    sourceTier,
    stage,
    id: `${sourceTier}-${stage}-${i}`,
  }));

  it("fills capacity with HKJC + Pinnacle before Pinnacle + Crown", () => {
    const targets = [
      ...make("pinnacle-crown", "T5", 20),
      ...make("hkjc-pinnacle", "T30", 10),
    ];
    const picked = allocateMilestoneTargetsBySource(targets, 10);
    expect(picked).toHaveLength(10);
    expect(picked.every((target) => target.sourceTier === "hkjc-pinnacle")).toBe(true);
  });

  it("uses Pinnacle + Crown only for capacity left by HKJC + Pinnacle", () => {
    const targets = [
      ...make("pinnacle-crown", "T5", 20),
      ...make("hkjc-pinnacle", "T30", 3),
    ];
    const picked = allocateMilestoneTargetsBySource(targets, 10);
    expect(picked.map((target) => target.sourceTier)).toEqual([
      "hkjc-pinnacle",
      "hkjc-pinnacle",
      "hkjc-pinnacle",
      "pinnacle-crown",
      "pinnacle-crown",
      "pinnacle-crown",
      "pinnacle-crown",
      "pinnacle-crown",
      "pinnacle-crown",
      "pinnacle-crown",
    ]);
  });

  it("adds a lower-tier floor without taking capacity away from HKJC + Pinnacle", () => {
    const targets = [
      ...make("hkjc-pinnacle", "T5", 10),
      ...make("pinnacle-crown", "T5", 2),
      ...make("pinnacle-crown", "T15", 2),
      ...make("pinnacle-crown", "T30", 1),
    ];
    const picked = allocateMilestoneTargetsBySource(targets, 10, 4);
    const core = picked.filter((target) => target.sourceTier === "hkjc-pinnacle");
    const lower = picked.filter((target) => target.sourceTier === "pinnacle-crown");

    expect(core).toHaveLength(10);
    expect(lower).toHaveLength(4);
    expect(lower.map((target) => target.stage))
      .toEqual(expect.arrayContaining(["T5", "T15", "T30"]));
  });

  it("dispatches T15 and T30 in the first worker wave", () => {
    const ordered = orderMilestoneTargetsForDispatch([
      ...make("hkjc-pinnacle", "T5", 20),
      ...make("hkjc-pinnacle", "T15", 5),
      ...make("hkjc-pinnacle", "T30", 5),
    ]);
    const firstWave = ordered.slice(0, 16);
    expect(firstWave.some((target) => target.stage === "T15")).toBe(true);
    expect(firstWave.some((target) => target.stage === "T30")).toBe(true);
    expect(firstWave.filter((target) => target.stage === "T5")).toHaveLength(8);
  });
});

describe("unmapped fixtures are reported, not counted as failures", () => {
  it("skips a fixture with no Pinnacle or Titan id and reports it separately", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const matchId = "hkjc:no-mapping";
    rawDb.prepare(
      `INSERT INTO matches(id,fixture_source,hkjc_id,titan_id,pinnacle_match_id,league,home_team,away_team,kickoff_utc,inplay,status,updated_at)
       VALUES(?,'hkjc',?,NULL,NULL,'Iceland - 1. Deild','Vestri','Throttur',?,0,'PREMATCH',?)`,
    ).run(matchId, "no-mapping", NOW + 4 * 60_000, NOW);
    const engine = new RadarEngine();
    const fetchTitan = vi.fn();
    (engine as any).pinnacle.fetchPinnacleResearchPrices = fetchTitan;

    await expect(engine.runResearchMilestoneTick()).resolves.toMatchObject({
      selected: 0,
      attempted: 0,
      failed: 0,
      unmapped: 1,
    });
    expect(fetchTitan).not.toHaveBeenCalled();
  });
});
