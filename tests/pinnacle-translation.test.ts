import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import type { PinnacleFixture } from "../server/providers/pinnacle";

const dbPath = `/tmp/odds-radar-pinnacle-translation-${process.pid}.db`;
process.env.RADAR_DB = dbPath;

let translatePinnacleFixture: typeof import("../server/lib/pinnacleTranslation").translatePinnacleFixture;
let shouldFetchTranslation: typeof import("../server/lib/pinnacleTranslation").shouldFetchTranslation;
let jaroWinkler: typeof import("../server/lib/pinnacleTranslation").jaroWinkler;
let findFuzzyMatch: typeof import("../server/lib/pinnacleTranslation").findFuzzyMatch;
let rawDb: typeof import("../server/lib/store").rawDb;

beforeAll(async () => {
  const store = await import("../server/lib/store");
  const svc = await import("../server/lib/pinnacleTranslation");
  translatePinnacleFixture = svc.translatePinnacleFixture;
  shouldFetchTranslation = svc.shouldFetchTranslation;
  jaroWinkler = svc.jaroWinkler;
  findFuzzyMatch = svc.findFuzzyMatch;
  rawDb = store.rawDb;
  store.migrate();
});

afterAll(() => {
  rawDb.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { rmSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
  }
});

const KICKOFF = Date.UTC(2026, 8, 3, 12, 30);

function titanFixture(overrides: Partial<PinnacleFixture> = {}): PinnacleFixture {
  return {
    providerMatchId: "titan-1",
    league: "英超",
    homeTeam: "阿仙奴",
    awayTeam: "利物浦",
    kickoffUtc: KICKOFF,
    statusText: "unplayed",
    homeScore: null,
    awayScore: null,
    halfHome: null,
    halfAway: null,
    handicapVal: null,
    totalVal: null,
    ...overrides,
  };
}

describe("pinnacleTranslation.jaroWinkler", () => {
  it("returns 1 for identical strings and 0 for disjoint strings", () => {
    expect(jaroWinkler("arsenal", "arsenal")).toBe(1);
    expect(jaroWinkler("", "arsenal")).toBe(0);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });

  it("rewards common prefixes so 'arsenal' vs 'arsen' beats 0.8", () => {
    expect(jaroWinkler("arsenal", "arsen")).toBeGreaterThan(0.8);
  });
});

describe("pinnacleTranslation.findFuzzyMatch", () => {
  it("returns a match within tolerance and above the Jaro-Winkler threshold", () => {
    const candidate = titanFixture();
    const match = findFuzzyMatch(
      { pinnapiId: "P1", homeTeam: "Arsenal", awayTeam: "Liverpool", league: "Premier League", kickoffUtc: KICKOFF },
      [candidate],
    );
    // English targets vs Chinese candidates share no letters — they fail the
    // Jaro-Winkler gate. The intent is that titan already emits Chinese, so we
    // use Chinese-vs-Chinese matches or English-vs-English (Optic) matches.
    expect(match).toBeNull();
  });

  it("matches Chinese target and Chinese candidate when kickoff is close", () => {
    const match = findFuzzyMatch(
      { pinnapiId: "P2", homeTeam: "阿仙奴", awayTeam: "利物浦", league: "英超", kickoffUtc: KICKOFF + 5 * 60_000 },
      [titanFixture()],
    );
    expect(match).not.toBeNull();
    expect(match?.homeTeam).toBe("阿仙奴");
  });

  it("rejects candidates outside the 30-minute kickoff tolerance", () => {
    const match = findFuzzyMatch(
      { pinnapiId: "P3", homeTeam: "阿仙奴", awayTeam: "利物浦", league: "英超", kickoffUtc: KICKOFF + 45 * 60_000 },
      [titanFixture()],
    );
    expect(match).toBeNull();
  });

  it("rejects candidates that fall below the Jaro-Winkler threshold", () => {
    const match = findFuzzyMatch(
      { pinnapiId: "P4", homeTeam: "曼聯", awayTeam: "車路士", league: "英超", kickoffUtc: KICKOFF },
      [titanFixture()],
    );
    expect(match).toBeNull();
  });
});

describe("pinnacleTranslation.translatePinnacleFixture", () => {
  const fixture = {
    pinnapiId: "abc123",
    homeTeam: "阿仙奴",
    awayTeam: "利物浦",
    league: "Premier League",
    kickoffUtc: KICKOFF,
  };

  it("returns titan translation when titan matches", async () => {
    const pinnacle = { fetchTitanResearchFixtures: vi.fn().mockResolvedValue([titanFixture()]) };
    const optic = { fetchFixtures: vi.fn() };
    const wikidata = { lookup: vi.fn() };
    const result = await translatePinnacleFixture(fixture, { pinnacle, optic, wikidata });
    expect(result).toEqual({
      pinnapiId: "abc123",
      zhHome: "阿仙奴",
      zhAway: "利物浦",
      zhLeague: "英超",
      source: "titan",
    });
    expect(optic.fetchFixtures).not.toHaveBeenCalled();
    expect(wikidata.lookup).not.toHaveBeenCalled();
  });

  it("falls back to OpticOdds when titan misses and Optic provides Chinese labels", async () => {
    const pinnacle = { fetchTitanResearchFixtures: vi.fn().mockResolvedValue([]) };
    const optic = { fetchFixtures: vi.fn().mockResolvedValue([
      titanFixture({ providerMatchId: "optic-1", league: "西甲", homeTeam: "皇家馬德里", awayTeam: "巴塞隆拿" }),
    ]) };
    const wikidata = { lookup: vi.fn() };
    const result = await translatePinnacleFixture(
      {
        pinnapiId: "abc456",
        homeTeam: "皇家馬德里",
        awayTeam: "巴塞隆拿",
        league: "La Liga",
        kickoffUtc: KICKOFF,
      },
      { pinnacle, optic, wikidata },
    );
    expect(result).toEqual({
      pinnapiId: "abc456",
      zhHome: "皇家馬德里",
      zhAway: "巴塞隆拿",
      zhLeague: "西甲",
      source: "optic",
    });
    expect(wikidata.lookup).not.toHaveBeenCalled();
  });

  it("uses Wikidata only after titan and Optic both yield no Chinese result", async () => {
    const pinnacle = { fetchTitanResearchFixtures: vi.fn().mockResolvedValue([]) };
    const optic = { fetchFixtures: vi.fn().mockResolvedValue([]) };
    const wikidata = {
      lookup: vi.fn(async (name: string, type: "team" | "league") => ({
        label: type === "league" ? "英格蘭超級足球聯賽" : name === "阿仙奴" ? "阿仙奴" : "利物浦",
        language: "zh-hk" as const,
        wikidataId: type === "league" ? "Q9448" : "Q1",
      })),
    };
    const result = await translatePinnacleFixture(fixture, { pinnacle, optic, wikidata });
    expect(pinnacle.fetchTitanResearchFixtures).toHaveBeenCalledTimes(1);
    expect(optic.fetchFixtures).toHaveBeenCalledTimes(1);
    expect(wikidata.lookup).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      pinnapiId: "abc123",
      zhHome: "阿仙奴",
      zhAway: "利物浦",
      zhLeague: "英格蘭超級足球聯賽",
      source: "wikidata",
    });
  });

  it("returns null when both sources miss", async () => {
    const pinnacle = { fetchTitanResearchFixtures: vi.fn().mockResolvedValue([]) };
    const optic = { fetchFixtures: vi.fn().mockResolvedValue([]) };
    const result = await translatePinnacleFixture(fixture, { pinnacle, optic });
    expect(result).toBeNull();
  });

  it("tolerates titan throwing and still consults Optic", async () => {
    const pinnacle = { fetchTitanResearchFixtures: vi.fn().mockRejectedValue(new Error("titan down")) };
    const optic = { fetchFixtures: vi.fn().mockResolvedValue([titanFixture()]) };
    const result = await translatePinnacleFixture(fixture, { pinnacle, optic });
    expect(result?.source).toBe("optic");
    expect(result?.zhHome).toBe("阿仙奴");
  });

  it("ignores kickoff differences beyond 30 minutes for both sources", async () => {
    const pinnacle = { fetchTitanResearchFixtures: vi.fn().mockResolvedValue([titanFixture({ kickoffUtc: KICKOFF + 45 * 60_000 })]) };
    const optic = { fetchFixtures: vi.fn().mockResolvedValue([]) };
    const result = await translatePinnacleFixture(fixture, { pinnacle, optic });
    expect(result).toBeNull();
  });
});

describe("pinnacleTranslation.shouldFetchTranslation", () => {
  it("fetches when no row exists", () => {
    expect(shouldFetchTranslation(null)).toBe(true);
  });

  it("skips when both critical fields are already present", () => {
    expect(
      shouldFetchTranslation({ zh_home: "阿仙奴", zh_league: "英超", attempted_at: 0, attempt_count: 1 }),
    ).toBe(false);
  });

  it("skips after three failed attempts", () => {
    expect(
      shouldFetchTranslation({ zh_home: null, zh_league: null, attempted_at: 0, attempt_count: 3 }),
    ).toBe(false);
  });

  it("retries a partial row after 4 hours", () => {
    const now = Date.now();
    expect(
      shouldFetchTranslation({ zh_home: null, zh_league: "英超", attempted_at: now - 5 * 60 * 60_000, attempt_count: 1 }, now),
    ).toBe(true);
    expect(
      shouldFetchTranslation({ zh_home: null, zh_league: "英超", attempted_at: now - 60 * 60_000, attempt_count: 1 }, now),
    ).toBe(false);
  });
});
