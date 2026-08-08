import { describe, expect, it } from "vitest";
import {
  hkjcHktDate,
  historicPageRanges,
  parseHkjcHistoricResults,
} from "../server/providers/hkjc";
import { legReturn, settle1X2, settleHandicap } from "../server/lib/settlement";

function officialRow(sequence: number, homeResult: unknown, awayResult: unknown) {
  return {
    resultType: 1,
    stageId: 5,
    payoutConfirmed: true,
    sequence,
    homeResult,
    awayResult,
  };
}

describe("HKJC official historic result parser", () => {
  it("takes the highest-sequence confirmed full-time row for requested ended matches", () => {
    const results = parseHkjcHistoricResults(
      {
        data: {
          matches: [
            {
              id: "50072522",
              status: "INPLAYMATCHENDED",
              results: [
                officialRow(1, 1, 2),
                officialRow(3, 1, 3),
                { ...officialRow(99, 8, 8), resultType: 2 },
              ],
            },
            {
              id: "50072902",
              status: "MATCHENDED",
              results: [officialRow(4, 2, 1)],
            },
          ],
        },
      },
      ["hkjc:50072522", "50072902"],
    );

    expect(results).toEqual([
      { matchId: "50072522", homeScore: 1, awayScore: 3, sequence: 3, source: "hkjc_official" },
      { matchId: "50072902", homeScore: 2, awayScore: 1, sequence: 4, source: "hkjc_official" },
    ]);
  });

  it("rejects interim, unconfirmed, malformed and non-ended rows", () => {
    const results = parseHkjcHistoricResults(
      {
        data: {
          matches: [
            {
              id: "50072522",
              status: "INPLAY",
              results: [officialRow(1, 1, 3)],
            },
            {
              id: "50072902",
              status: "MATCHENDED",
              results: [
                { ...officialRow(1, 1, 3), payoutConfirmed: false },
                { ...officialRow(2, 1, 3), stageId: 2 },
                { ...officialRow(3, 1, 3), resultType: 4 },
                officialRow(4, -1, 3),
                officialRow(5, "not-a-score", 3),
              ],
            },
          ],
        },
      },
      ["50072522", "50072902"],
    );

    expect(results).toEqual([]);
  });

  it("keeps request pages bounded at 20 rows and filters unrequested IDs", () => {
    expect(historicPageRanges(3)).toEqual([
      { startIndex: 0, endIndex: 20 },
      { startIndex: 20, endIndex: 40 },
      { startIndex: 40, endIndex: 60 },
    ]);
    const results = parseHkjcHistoricResults(
      {
        data: {
          matches: [
            { id: "wanted", status: "MATCHENDED", results: [officialRow(1, 0, 0)] },
            { id: "not-requested", status: "MATCHENDED", results: [officialRow(1, 9, 9)] },
          ],
        },
      },
      ["wanted"],
    );
    expect(results).toEqual([
      { matchId: "wanted", homeScore: 0, awayScore: 0, sequence: 1, source: "hkjc_official" },
    ]);
  });

  it("derives HKJC historic date ranges in HKT", () => {
    expect(hkjcHktDate(Date.UTC(2026, 7, 8, 15, 59))).toBe("2026-08-08");
    expect(hkjcHktDate(Date.UTC(2026, 7, 8, 16, 0))).toBe("2026-08-09");
  });
});

describe("HKJC official settlement values", () => {
  it("carries official source data into correct AH push and 1X2 loss outcomes", () => {
    const official = parseHkjcHistoricResults(
      {
        data: {
          matches: [{ id: "50072522", status: "MATCHENDED", results: [officialRow(1, 1, 1)] }],
        },
      },
      ["50072522"],
    )[0];
    expect(official.source).toBe("hkjc_official");
    const score = { homeScore: official.homeScore, awayScore: official.awayScore };
    expect(settleHandicap(0, "H", score)).toBe("push");
    expect(legReturn(settleHandicap(0, "H", score), 10_000, 1.91)).toBe(10_000);
    expect(settle1X2("H", score)).toBe("loss");
    expect(legReturn(settle1X2("H", score), 10_000, 2.2)).toBe(0);
  });
});
