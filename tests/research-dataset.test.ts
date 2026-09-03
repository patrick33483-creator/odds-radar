import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const dbPath = `/tmp/odds-radar-research-dataset-${process.pid}.db`;
process.env.RADAR_DB = dbPath;

let rawDb: typeof import("../server/lib/store").rawDb;
let researchDataset: typeof import("../server/lib/research").researchDataset;
let collectTodayCrownBackfill: typeof import("../server/lib/research").collectTodayCrownBackfill;

const NOW = 1_900_000_000_000;

beforeAll(async () => {
  const store = await import("../server/lib/store");
  const research = await import("../server/lib/research");
  rawDb = store.rawDb;
  researchDataset = research.researchDataset;
  collectTodayCrownBackfill = research.collectTodayCrownBackfill;
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

function addFixture(
  id: string,
  source: "crown" | "hkjc",
  kickoffUtc: number,
  titanId: string | null = null,
): void {
  rawDb.prepare(
    `INSERT OR REPLACE INTO matches(
      id,hkjc_id,titan_id,fixture_source,league,home_team,away_team,kickoff_utc,status,inplay,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    source === "hkjc" ? id.replace(/\D/g, "") || id : null,
    titanId,
    source,
    "研究聯賽",
    "主隊",
    "客隊",
    kickoffUtc,
    "PREEVENT",
    0,
    NOW,
  );
}

describe("research dataset surfaces tracked fixtures without snapshots", () => {
  it("shows a Crown fixture that kicked off an hour ago with no snapshot or result", () => {
    const kickoff = NOW - 60 * 60_000;
    addFixture("crown:dataset-visible", "crown", kickoff, "dataset-visible");
    const dataset = researchDataset({ days: 7, provider: "all", market: "all" }, NOW);
    const row = dataset.matches.find((match) => match.matchId === "crown:dataset-visible");
    expect(row).toBeDefined();
    expect(row?.snapshotCount).toBe(0);
    expect(row?.result).toBeNull();
    expect(row?.timeline.initial.status).toBe("pending");
    expect(row?.timeline.initial.cells.crown.AH).toBe("pending");
  });

  it("shows an HKJC fixture with no snapshot or result", () => {
    const kickoff = NOW - 90 * 60_000;
    addFixture("hkjc:dataset-visible-2", "hkjc", kickoff);
    const dataset = researchDataset({ days: 7, provider: "all", market: "all" }, NOW);
    const row = dataset.matches.find((match) => match.matchId === "hkjc:dataset-visible-2");
    expect(row).toBeDefined();
    expect(row?.fixtureSource).toBe("hkjc");
    expect(row?.timeline.initial.status).toBe("pending");
  });

  it("orders matches with the latest kickoff first", () => {
    addFixture("crown:dataset-order-early", "crown", NOW - 5 * 60 * 60_000, "order-early");
    addFixture("crown:dataset-order-late", "crown", NOW + 5 * 60 * 60_000, "order-late");
    const ids = researchDataset({ days: 7, provider: "all", market: "all" }, NOW).matches
      .map((match) => match.matchId);
    expect(ids.indexOf("crown:dataset-order-late")).toBeLessThan(ids.indexOf("crown:dataset-order-early"));
  });

  it("rolling upcoming window hides finished fixtures and orders by earliest kickoff", () => {
    addFixture("crown:rolling-past", "crown", NOW - 2 * 60 * 60_000, "rolling-past");
    addFixture("crown:rolling-near", "crown", NOW + 1 * 60 * 60_000, "rolling-near");
    addFixture("crown:rolling-far", "crown", NOW + 4 * 24 * 60 * 60_000, "rolling-far");
    const dataset = researchDataset({
      window: "upcoming",
      days: 7,
      horizonDays: 14,
      limit: 300,
      provider: "all",
      market: "all",
    }, NOW);
    const ids = dataset.matches.map((match) => match.matchId);
    expect(ids).toContain("crown:rolling-near");
    expect(ids).toContain("crown:rolling-far");
    expect(ids).not.toContain("crown:rolling-past");
    // Upcoming view sorts by earliest kickoff so the imminent fixture surfaces first.
    expect(ids.indexOf("crown:rolling-near")).toBeLessThan(ids.indexOf("crown:rolling-far"));
  });

  it("finished window keeps historical fixtures and hides future kickoffs", () => {
    addFixture("crown:finished-old", "crown", NOW - 3 * 60 * 60_000, "finished-old");
    addFixture("crown:finished-future", "crown", NOW + 3 * 60 * 60_000, "finished-future");
    const dataset = researchDataset({
      window: "finished",
      days: 7,
      horizonDays: 14,
      limit: 300,
      provider: "all",
      market: "all",
    }, NOW);
    const ids = dataset.matches.map((match) => match.matchId);
    expect(ids).toContain("crown:finished-old");
    expect(ids).not.toContain("crown:finished-future");
  });
});

describe("today Crown backfill collector", () => {
  it("inserts results and opening snapshots for Crown fixtures kicked off in the last six hours", async () => {
    const kickoff = NOW - 2 * 60 * 60_000;
    addFixture("crown:backfill-1", "crown", kickoff, "backfill-1");
    const fetchResults = vi.fn(async () => [{
      providerMatchId: "backfill-1",
      league: "研究聯賽",
      homeTeam: "主隊",
      awayTeam: "客隊",
      kickoffUtc: kickoff,
      homeScore: 2,
      awayScore: 1,
      halfHome: null,
      halfAway: null,
      source: "titan_today",
    }]);
    const fetchCrownResearchPrices = vi.fn(async () => ({
      opening: [
        { market: "AH" as const, lineValue: -0.5, isMain: true, selection: "H", decimalOdds: 1.91 },
        { market: "AH" as const, lineValue: -0.5, isMain: true, selection: "A", decimalOdds: 1.99 },
        { market: "OU" as const, lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 1.93 },
        { market: "OU" as const, lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 1.97 },
      ],
      current: [],
      sourceUrls: { AH: "https://example.test/ah", OU: "https://example.test/ou" },
    }));

    const outcome = await collectTodayCrownBackfill(
      { fetchResults, fetchCrownResearchPrices } as never,
      NOW,
    );
    expect(outcome.results).toBeGreaterThanOrEqual(1);
    expect(outcome.openings).toBeGreaterThanOrEqual(4);
    expect(outcome.errors).toBe(0);

    expect(rawDb.prepare(
      "SELECT home_score,away_score,result_source FROM research_results WHERE match_id=?",
    ).get("crown:backfill-1")).toMatchObject({ home_score: 2, away_score: 1, result_source: "titan007" });
    expect(rawDb.prepare(
      "SELECT COUNT(*) count FROM research_timeline_snapshots WHERE match_id=? AND stage='initial'",
    ).get("crown:backfill-1")).toEqual({ count: 4 });
    // Settlement tables stay untouched by the research-only backfill.
    expect(rawDb.prepare("SELECT COUNT(*) count FROM results WHERE match_id=?").get("crown:backfill-1"))
      .toEqual({ count: 0 });

    const row = researchDataset({ days: 7, provider: "all", market: "all" }, NOW).matches
      .find((match) => match.matchId === "crown:backfill-1");
    expect(row?.result).toMatchObject({ homeScore: 2, awayScore: 1 });
  });

  it("does not throw when the providers fail", async () => {
    addFixture("crown:backfill-error", "crown", NOW - 3 * 60 * 60_000, "backfill-error");
    const outcome = await collectTodayCrownBackfill(
      {
        fetchResults: vi.fn(async () => {
          throw new Error("titan down");
        }),
        fetchCrownResearchPrices: vi.fn(async () => {
          throw new Error("crown detail down");
        }),
      } as never,
      NOW,
    );
    expect(outcome.errors).toBeGreaterThanOrEqual(2);
    expect(outcome.results).toBe(0);
    expect(outcome.openings).toBe(0);
    expect(rawDb.prepare("SELECT COUNT(*) count FROM research_results WHERE match_id=?")
      .get("crown:backfill-error")).toEqual({ count: 0 });
  });
});
