import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

const dbPath = `/tmp/odds-radar-research-dataset-${process.pid}.db`;
process.env.RADAR_DB = dbPath;

let rawDb: typeof import("../server/lib/store").rawDb;
let researchDataset: typeof import("../server/lib/research").researchDataset;
let researchCsv: typeof import("../server/lib/research").researchCsv;

const NOW = 1_900_000_000_000;

beforeAll(async () => {
  const store = await import("../server/lib/store");
  const research = await import("../server/lib/research");
  rawDb = store.rawDb;
  researchDataset = research.researchDataset;
  researchCsv = research.researchCsv;
  store.migrate();
});

afterAll(() => {
  rawDb.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { rmSync(`${dbPath}${suffix}`); } catch { /* SQLite sidecar optional. */ }
  }
});

function addFixture(id: string, source: "crown" | "hkjc" | "pinnacle", kickoffUtc: number): void {
  rawDb.prepare(
    `INSERT INTO matches(
      id,hkjc_id,fixture_source,titan_id,league,home_team,away_team,kickoff_utc,status,inplay,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    source === "hkjc" ? id : null,
    source,
    source === "crown" ? id.replace("crown:", "") : null,
    "研究聯賽",
    "主隊",
    "客隊",
    kickoffUtc,
    "PREEVENT",
    0,
    NOW,
  );
}

function addOuPair(matchId: string, provider: "crown" | "hkjc" | "pinnacle"): void {
  const insert = rawDb.prepare(
    `INSERT INTO research_timeline_snapshots(
      match_id,provider,market,stage,line_key,selection,decimal_odds,is_main,captured_at,status,origin
    ) VALUES(?,?, 'OU','T30','2.5',?,?,1,?,'captured','test')`,
  );
  insert.run(matchId, provider, "O", 1.91, NOW);
  insert.run(matchId, provider, "U", 1.99, NOW);
}

describe("research dataset shows HKJC + Crown and hides Pinnacle-only", () => {
  it("keeps HKJC and Crown-only fixtures visible under a 300-row limit despite 3,500 Crown futures, and excludes Pinnacle-only from summary, matches and CSV", () => {
    for (let i = 0; i < 3500; i++) {
      addFixture(`crown:bulk-${i}`, "crown", NOW + ((i % 7) + 1) * 60 * 60_000);
    }
    for (let i = 0; i < 100; i++) {
      addFixture(`hkjc:bulk-${i}`, "hkjc", NOW + ((i % 7) + 1) * 60 * 60_000);
    }
    // Featured fixtures kick off before every bulk row so the 300-row limit can
    // never reorder them out of the assertion window.
    addFixture("hkjc:featured", "hkjc", NOW + 20 * 60_000);
    addFixture("crown:featured", "crown", NOW + 25 * 60_000);
    addFixture("pinnacle:featured", "pinnacle", NOW + 30 * 60_000);
    addOuPair("hkjc:featured", "hkjc");
    addOuPair("hkjc:featured", "pinnacle");
    addOuPair("crown:featured", "crown");
    addOuPair("crown:featured", "pinnacle");
    addOuPair("pinnacle:featured", "pinnacle");
    for (const [matchId, hkjcId, source] of [
      ["hkjc:featured", "hkjc:featured", "hkjc"],
      ["crown:featured", null, "titan"],
      ["pinnacle:featured", null, "titan"],
    ] as Array<[string, string | null, string]>) {
      rawDb.prepare(
        `INSERT INTO research_results(match_id,hkjc_id,home_score,away_score,corners_total,source,result_source,fetched_at)
         VALUES(?,?,2,1,NULL,?,?,?)`,
      ).run(matchId, hkjcId, source, source === "hkjc" ? "hkjc" : "titan007", NOW);
    }

    const filters = { window: "upcoming" as const, days: 7, horizonDays: 14, limit: 300, provider: "all" as const, market: "all" as const };
    const dataset = researchDataset(filters, NOW);
    expect(dataset.matches).toHaveLength(300);
    const ids = dataset.matches.map((row) => row.matchId);
    // (a) HKJC + Crown common/HKJC-owned fixtures and (b) Crown-only fixtures
    // are both part of the research view now.
    expect(ids).toContain("hkjc:featured");
    expect(ids).toContain("crown:featured");
    // Pinnacle-only fixtures (e.g. Fiji Cup) stay hidden everywhere.
    expect(ids).not.toContain("pinnacle:featured");
    expect(dataset.matches.every((row) => row.fixtureSource === "hkjc" || row.fixtureSource === "crown")).toBe(true);
    expect(new Set(dataset.matches.map((row) => row.fixtureSource))).toEqual(new Set(["hkjc", "crown"]));
    // Every visible id is unique: an HKJC fixture that also has a titan_id must
    // never be duplicated by a second Crown row.
    expect(new Set(ids).size).toBe(ids.length);
    expect(dataset.summary.providerCounts.map((row) => row.name).sort()).toEqual(["crown", "hkjc", "pinnacle"]);
    expect(dataset.summary.marketCounts.map((row) => row.name)).toEqual(["OU"]);
    const hkjc = dataset.matches.find((row) => row.matchId === "hkjc:featured")!;
    expect(hkjc.timeline.T30.quotes.map((quote) => quote.provider).sort()).toEqual([
      "hkjc", "hkjc", "pinnacle", "pinnacle",
    ]);
    // Crown-only rows carry Chinese labels straight from the titan schedule.
    const crown = dataset.matches.find((row) => row.matchId === "crown:featured")!;
    expect(crown.league).toBe("研究聯賽");
    expect(crown.homeTeam).toBe("主隊");
    expect(crown.awayTeam).toBe("客隊");
    expect(crown.titanId).toBe("featured");
    // HKJC has no schedule for a Crown-only fixture; Pinnacle rides along.
    expect(crown.timeline.T30.cells.hkjc.OU).toBe("source_unavailable");
    expect(crown.timeline.T30.cells.pinnacle.OU).toBe("captured");

    const timelineCsv = researchCsv("timeline", filters, NOW);
    const resultsCsv = researchCsv("results", filters, NOW);
    expect(timelineCsv).toContain("hkjc:featured");
    expect(timelineCsv).toContain("crown:featured");
    expect(timelineCsv).not.toContain("pinnacle:featured");
    expect(resultsCsv).toContain("hkjc:featured");
    expect(resultsCsv).toContain("crown:featured");
    expect(resultsCsv).not.toContain("pinnacle:featured");
  });

  it("retains a snapshot-free HKJC fixture as pending", () => {
    // Earlier than every bulk fixture so the 300-row limit cannot hide it.
    addFixture("hkjc:pending-no-snapshot", "hkjc", NOW + 5 * 60_000);
    const row = researchDataset({ window: "upcoming", days: 7, horizonDays: 14, limit: 300, provider: "all", market: "all" }, NOW)
      .matches.find((match) => match.matchId === "hkjc:pending-no-snapshot");
    expect(row).toBeDefined();
    expect(row?.snapshotCount).toBe(0);
    expect(row?.timeline.initial.status).toBe("pending");
  });

  it("keeps a snapshot-free Crown-only fixture visible as pending", () => {
    addFixture("crown:pending-no-snapshot", "crown", NOW + 6 * 60_000);
    const row = researchDataset({ window: "upcoming", days: 7, horizonDays: 14, limit: 300, provider: "all", market: "all" }, NOW)
      .matches.find((match) => match.matchId === "crown:pending-no-snapshot");
    expect(row).toBeDefined();
    expect(row?.fixtureSource).toBe("crown");
    expect(row?.snapshotCount).toBe(0);
    expect(row?.timeline.initial.status).toBe("pending");
  });
});
