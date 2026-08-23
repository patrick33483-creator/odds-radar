import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

const dbPath = `/tmp/odds-radar-research-${process.pid}.db`;
process.env.RADAR_DB = dbPath;
process.env.RADAR_RESEARCH_RESULTS = "1";

let rawDb: typeof import("../server/lib/store").rawDb;
let collectResearchResults: typeof import("../server/lib/research").collectResearchResults;
let parseResearchFilters: typeof import("../server/lib/research").parseResearchFilters;
let researchCsv: typeof import("../server/lib/research").researchCsv;
let researchDataset: typeof import("../server/lib/research").researchDataset;

beforeAll(async () => {
  const store = await import("../server/lib/store");
  const research = await import("../server/lib/research");
  rawDb = store.rawDb;
  collectResearchResults = research.collectResearchResults;
  parseResearchFilters = research.parseResearchFilters;
  researchCsv = research.researchCsv;
  researchDataset = research.researchDataset;
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

describe("research data collection", () => {
  it("bounds lookback and accepts only supported provider and market filters", () => {
    expect(parseResearchFilters({ days: "999", provider: "pinnacle", market: "OU" })).toEqual({
      days: 120,
      provider: "pinnacle",
      market: "OU",
    });
    expect(parseResearchFilters({ days: "bad", provider: "unknown", market: "HDC" })).toEqual({
      days: 7,
      provider: "all",
      market: "all",
    });
  });

  it("stores official results in the isolated research table without touching settlement results", async () => {
    const now = Date.now();
    rawDb
      .prepare(
        `INSERT INTO matches(
          id,hkjc_id,league,home_team,away_team,kickoff_utc,status,inplay,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run("research-only", "123", "測試聯賽", "主隊", "客隊", now - 2 * 60 * 60_000, "MATCHENDED", 0, now);
    rawDb
      .prepare(
        `INSERT INTO odds_snapshots(
          match_id,provider,market,line_key,selection,decimal_odds,source_updated_at,fetched_at,phase
        ) VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run("research-only", "hkjc", "OU", "2.50", "O", 1.91, now - 60_000, now - 60_000, "prematch");

    const provider = {
      fetchHistoricResults: async () => [
        {
          matchId: "123",
          homeScore: 2,
          awayScore: 1,
          cornersTotal: 9,
          sequence: 1,
          source: "hkjc_official",
        },
      ],
    };
    await expect(collectResearchResults(provider as never, now)).resolves.toEqual({
      candidates: 1,
      collected: 1,
    });

    expect(rawDb.prepare("SELECT COUNT(*) count FROM results").get()).toEqual({ count: 0 });
    expect(
      rawDb
        .prepare("SELECT match_id,home_score,away_score,corners_total FROM research_results")
        .get(),
    ).toEqual({ match_id: "research-only", home_score: 2, away_score: 1, corners_total: 9 });

    const dataset = researchDataset({ days: 7, provider: "all", market: "all" });
    expect(dataset.summary.completedResults).toBe(1);
    expect(dataset.matches[0].result).toMatchObject({
      homeScore: 2,
      awayScore: 1,
      cornersTotal: 9,
      source: "hkjc_official",
    });
    expect(researchCsv("results", { days: 7, provider: "all", market: "all" })).toContain(
      "research-only,123,測試聯賽,主隊,客隊",
    );
  });
});
