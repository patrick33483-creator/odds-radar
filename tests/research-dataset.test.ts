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

function addFixture(id: string, source: "crown" | "hkjc", kickoffUtc: number): void {
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

describe("research dataset excludes Crown without hiding HKJC", () => {
  it("keeps 100 HKJC fixtures visible with a 300-row limit despite 3,500 Crown futures, and excludes Crown from summary, matches and CSV", () => {
    for (let i = 0; i < 3500; i++) {
      addFixture(`crown:bulk-${i}`, "crown", NOW + ((i % 7) + 1) * 60 * 60_000);
    }
    for (let i = 0; i < 100; i++) {
      addFixture(`hkjc:bulk-${i}`, "hkjc", NOW + ((i % 7) + 1) * 60 * 60_000);
    }
    addOuPair("crown:bulk-0", "crown");
    addOuPair("hkjc:bulk-0", "hkjc");
    addOuPair("hkjc:bulk-0", "pinnacle");
    rawDb.prepare(
      `INSERT INTO research_results(match_id,hkjc_id,home_score,away_score,corners_total,source,result_source,fetched_at)
       VALUES('crown:bulk-0',NULL,2,1,NULL,'titan','titan007',?)`,
    ).run(NOW);
    rawDb.prepare(
      `INSERT INTO research_results(match_id,hkjc_id,home_score,away_score,corners_total,source,result_source,fetched_at)
       VALUES('hkjc:bulk-0','hkjc:bulk-0',2,1,NULL,'hkjc','hkjc',?)`,
    ).run(NOW);

    const filters = { window: "upcoming" as const, days: 7, horizonDays: 14, limit: 300, provider: "all" as const, market: "all" as const };
    const dataset = researchDataset(filters, NOW);
    expect(dataset.matches).toHaveLength(100);
    expect(dataset.matches.every((row) => row.fixtureSource === "hkjc")).toBe(true);
    expect(dataset.matches.map((row) => row.matchId)).toContain("hkjc:bulk-0");
    expect(dataset.matches.map((row) => row.matchId)).not.toContain("crown:bulk-0");
    expect(dataset.summary.providerCounts.map((row) => row.name).sort()).toEqual(["hkjc", "pinnacle"]);
    expect(dataset.summary.marketCounts.map((row) => row.name)).toEqual(["OU"]);
    const hkjc = dataset.matches.find((row) => row.matchId === "hkjc:bulk-0")!;
    expect(hkjc.timeline.T30.quotes.map((quote) => quote.provider).sort()).toEqual([
      "hkjc", "hkjc", "pinnacle", "pinnacle",
    ]);

    const timelineCsv = researchCsv("timeline", filters, NOW);
    const resultsCsv = researchCsv("results", filters, NOW);
    expect(timelineCsv).toContain("hkjc:bulk-0");
    expect(timelineCsv).not.toContain("crown:bulk-0");
    expect(resultsCsv).toContain("hkjc:bulk-0");
    expect(resultsCsv).not.toContain("crown:bulk-0");
  });

  it("retains a snapshot-free HKJC fixture as pending", () => {
    addFixture("hkjc:pending-no-snapshot", "hkjc", NOW + 8 * 60 * 60_000);
    const row = researchDataset({ window: "upcoming", days: 7, horizonDays: 14, limit: 300, provider: "all", market: "all" }, NOW)
      .matches.find((match) => match.matchId === "hkjc:pending-no-snapshot");
    expect(row).toBeDefined();
    expect(row?.snapshotCount).toBe(0);
    expect(row?.timeline.initial.status).toBe("pending");
  });
});
