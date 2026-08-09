import { describe, expect, it } from "vitest";
import {
  hkjcHktDate,
  historicPageRanges,
  mapHkjcMatch,
  parseHkjcHistoricResults,
} from "../server/providers/hkjc";
import { canSettleCornerMarket, legReturn, settle1X2, settleCornerTotal, settleHandicap, settleLeg } from "../server/lib/settlement";

function officialRow(sequence: number, homeResult: unknown, awayResult: unknown, ttlCornerResult?: unknown) {
  return {
    resultType: 1,
    stageId: 5,
    payoutConfirmed: true,
    sequence,
    homeResult,
    awayResult,
    ttlCornerResult,
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
      { matchId: "50072522", homeScore: 1, awayScore: 3, cornersTotal: null, sequence: 3, source: "hkjc_official" },
      { matchId: "50072902", homeScore: 2, awayScore: 1, cornersTotal: null, sequence: 4, source: "hkjc_official" },
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
      { matchId: "wanted", homeScore: 0, awayScore: 0, cornersTotal: null, sequence: 1, source: "hkjc_official" },
    ]);
  });

  it("derives HKJC historic date ranges in HKT", () => {
    expect(hkjcHktDate(Date.UTC(2026, 7, 8, 15, 59))).toBe("2026-08-08");
    expect(hkjcHktDate(Date.UTC(2026, 7, 8, 16, 0))).toBe("2026-08-09");
  });
});

describe("HKJC CHL and official corner settlement", () => {
  it("excludes suspended historical lines even when HKJC still returns numeric odds", () => {
    const event = mapHkjcMatch({
      id: "50072073",
      status: "PREEVENT",
      kickOffTime: "2026-08-09T14:30:00Z",
      matchDate: "2026-08-09",
      updateAt: null,
      homeTeam: { name_ch: "巴素利", name_en: "Basel" },
      awayTeam: { name_ch: "杜安", name_en: "Thun" },
      tournament: { name_ch: "瑞士超級聯賽", name_en: "Swiss Super League" },
      foPools: [
        {
          oddsType: "HDC",
          updateAt: "2026-08-07T19:42:00.896+08:00",
          id: "hdc",
          status: "SELLINGSTARTED",
          inplay: false,
          lines: [
            {
              lineId: "current",
              status: "AVAILABLE",
              condition: "0.0/-0.5",
              main: true,
              combinations: [
                { combId: "h-current", str: "H", status: "AVAILABLE", currentOdds: "1.77" },
                { combId: "a-current", str: "A", status: "AVAILABLE", currentOdds: "2.00" },
              ],
            },
            {
              lineId: "withdrawn",
              status: "SUSPENDED",
              condition: "-0.5/-1.0",
              main: false,
              combinations: [
                { combId: "h-old", str: "H", status: "AVAILABLE", currentOdds: "2.09" },
                { combId: "a-old", str: "A", status: "AVAILABLE", currentOdds: "1.70" },
              ],
            },
            {
              lineId: "stale-alternate",
              status: "AVAILABLE",
              condition: "-1.0",
              main: false,
              combinations: [
                { combId: "h-stale", str: "H", status: "AVAILABLE", currentOdds: "3.35" },
                { combId: "a-stale", str: "A", status: "AVAILABLE", currentOdds: "1.22" },
              ],
            },
          ],
        },
      ],
    } as Parameters<typeof mapHkjcMatch>[0])!;

    expect(event.prices).toEqual([
      expect.objectContaining({ market: "AH", lineValue: -0.25, selection: "H", decimalOdds: 1.77 }),
      expect.objectContaining({ market: "AH", lineValue: -0.25, selection: "A", decimalOdds: 2.0 }),
    ]);
    expect(event.prices.some((price) => price.lineValue === -0.75)).toBe(false);
    expect(event.prices.some((price) => price.lineValue === -1)).toBe(false);
  });

  it("maps CHL H/L to the distinct COU O/U market without changing goal totals", () => {
    const event = mapHkjcMatch({
      id: "corner-1",
      status: "PREEVENT",
      kickOffTime: "2026-08-09T12:00:00Z",
      matchDate: "2026-08-09",
      updateAt: null,
      homeTeam: { name_ch: "主隊", name_en: "Home" },
      awayTeam: { name_ch: "客隊", name_en: "Away" },
      tournament: { name_ch: "測試聯賽", name_en: "Test League" },
      foPools: [
        {
          oddsType: "CHL",
          updateAt: "2026-08-09T11:00:00Z",
          id: "chl",
          status: "OPEN",
          inplay: false,
          lines: [
            {
              lineId: "line",
              status: "OPEN",
              condition: "9.5/10.0",
              main: true,
              combinations: [
                { combId: "h", str: "H", status: "OPEN", currentOdds: "1.91" },
                { combId: "l", str: "L", status: "OPEN", currentOdds: "1.99" },
              ],
            },
          ],
        },
      ],
    } as Parameters<typeof mapHkjcMatch>[0])!;
    expect(event.prices).toEqual([
      expect.objectContaining({ market: "COU", lineValue: 9.75, selection: "O", decimalOdds: 1.91 }),
      expect.objectContaining({ market: "COU", lineValue: 9.75, selection: "U", decimalOdds: 1.99 }),
    ]);
  });

  it("uses only confirmed HKJC ttlCornerResult and leaves its absence ineligible", () => {
    const withCorners = parseHkjcHistoricResults(
      {
        data: {
          matches: [
            {
              id: "corner-result",
              status: "MATCHENDED",
              results: [
                officialRow(1, 2, 1, -1),
                officialRow(2, 2, 1, 10),
                { ...officialRow(3, 2, 1, 99), payoutConfirmed: false },
              ],
            },
            { id: "corner-missing", status: "MATCHENDED", results: [officialRow(1, 0, 0)] },
          ],
        },
      },
      ["corner-result", "corner-missing"],
    );
    expect(withCorners).toEqual([
      expect.objectContaining({ matchId: "corner-result", cornersTotal: 10, source: "hkjc_official" }),
      expect.objectContaining({ matchId: "corner-missing", cornersTotal: null, source: "hkjc_official" }),
    ]);
    expect(canSettleCornerMarket(withCorners[0].source, withCorners[0].cornersTotal)).toBe(true);
    expect(canSettleCornerMarket(withCorners[1].source, withCorners[1].cornersTotal)).toBe(false);
    expect(canSettleCornerMarket("titan_over", 10)).toBe(false);
    expect(settleCornerTotal(10, 9.75, "O")).toBe("half_win");
    expect(() => settleLeg("COU", 9.75, "O", { homeScore: 0, awayScore: 0 })).toThrow(/official HKJC/i);
  });

  it("does not fall back to an earlier corner result when the latest official row omits it", () => {
    const result = parseHkjcHistoricResults(
      {
        data: {
          matches: [{
            id: "corner-latest-missing",
            status: "MATCHENDED",
            results: [
              officialRow(1, 1, 0, 11),
              officialRow(2, 2, 0),
            ],
          }],
        },
      },
      ["corner-latest-missing"],
    )[0];

    expect(result.cornersTotal).toBeNull();
    expect(canSettleCornerMarket(result.source, result.cornersTotal)).toBe(false);
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
