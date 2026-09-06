import { describe, expect, it, vi } from "vitest";
import { parseTitanCorners, resolveTitanIdByNameDate } from "../server/providers/titan-corners";
import { PinnacleProvider } from "../server/providers/pinnacle";

/** Shape observed on a real titan007 detail page (live.titan007.com/detail/<id>cn.htm). */
const page = (stat: string): string =>
  `<script type="text/javascript">var scheduleID = 2962613; var state = 3;\n`
  + `var teamTvStatisticData = "${stat}"\n</script>`;

describe("parseTitanCorners", () => {
  it("reads full-match corners from stat code 0", () => {
    const parsed = parseTitanCorners(
      page("0,5,1,83,17^2,2,4,33,67^4,12,10,55,45^11,50%,50%,50,50"),
      "2962613",
    );
    expect(parsed).toEqual({
      titanId: "2962613",
      homeCorners: 5,
      awayCorners: 1,
      cornersTotal: 6,
    });
  });

  it("keeps a genuine nil-nil corner count", () => {
    expect(parseTitanCorners(page("0,0,0,50,50"), "1")).toMatchObject({ cornersTotal: 0 });
  });

  it("does not confuse another statistic for corners", () => {
    // Code 4 is 射門; a page without code 0 has no corner statistic at all.
    expect(parseTitanCorners(page("2,2,4,33,67^4,12,10,55,45"), "1")).toBeNull();
  });

  it("returns null when the page carries no statistics block", () => {
    expect(parseTitanCorners("<html>var scheduleID = 1;</html>", "1")).toBeNull();
  });

  it("rejects non-integer and negative counts rather than storing junk", () => {
    expect(parseTitanCorners(page("0,,,0,0"), "1")).toBeNull();
    expect(parseTitanCorners(page("0,-1,3,0,0"), "1")).toBeNull();
  });

  it("adds home and away rather than trusting a single total", () => {
    expect(parseTitanCorners(page("0,7,9,44,56"), "1")).toMatchObject({ cornersTotal: 16 });
  });
});

describe("resolveTitanIdByNameDate", () => {
  const kickoff = Date.UTC(2026, 8, 5, 11, 0); // 2026-09-05 19:00 HKT
  const fixture = {
    providerMatchId: "2962613",
    league: "中超",
    homeTeam: "上海海港",
    awayTeam: "北京國安",
    kickoffUtc: kickoff,
    statusText: "完",
    homeScore: 2, awayScore: 1,
    halfHome: 1, halfAway: 0,
    handicapVal: null, totalVal: null,
  };

  it("returns a titan id when exactly one schedule row matches", async () => {
    const spy = vi
      .spyOn(PinnacleProvider.prototype, "fetchTitanResearchFixtures")
      .mockResolvedValue([fixture]);
    try {
      const got = await resolveTitanIdByNameDate({
        homeTeam: "上海海港",
        awayTeam: "北京國安",
        kickoffUtc: kickoff + 5 * 60_000, // 5 min drift, well inside tolerance
      });
      expect(got).toEqual({ titanId: "2962613", method: "name+date", candidateCount: 1 });
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses to guess when zero rows match", async () => {
    const spy = vi
      .spyOn(PinnacleProvider.prototype, "fetchTitanResearchFixtures")
      .mockResolvedValue([{ ...fixture, homeTeam: "其他隊" }]);
    try {
      const got = await resolveTitanIdByNameDate({
        homeTeam: "上海海港",
        awayTeam: "北京國安",
        kickoffUtc: kickoff,
      });
      expect(got).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses to guess when multiple rows match ambiguously", async () => {
    const spy = vi
      .spyOn(PinnacleProvider.prototype, "fetchTitanResearchFixtures")
      .mockResolvedValue([fixture, { ...fixture, providerMatchId: "9999999" }]);
    try {
      const got = await resolveTitanIdByNameDate({
        homeTeam: "上海海港",
        awayTeam: "北京國安",
        kickoffUtc: kickoff,
      });
      expect(got).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects a row whose kickoff drifts beyond tolerance", async () => {
    const spy = vi
      .spyOn(PinnacleProvider.prototype, "fetchTitanResearchFixtures")
      .mockResolvedValue([fixture]);
    try {
      const got = await resolveTitanIdByNameDate({
        homeTeam: "上海海港",
        awayTeam: "北京國安",
        kickoffUtc: kickoff + 90 * 60_000, // 90 min > 30 min tolerance
      });
      expect(got).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("returns null when the schedule fetch throws", async () => {
    const spy = vi
      .spyOn(PinnacleProvider.prototype, "fetchTitanResearchFixtures")
      .mockRejectedValue(new Error("titan schedule offline"));
    try {
      const got = await resolveTitanIdByNameDate({
        homeTeam: "上海海港",
        awayTeam: "北京國安",
        kickoffUtc: kickoff,
      });
      expect(got).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
