import { describe, expect, it } from "vitest";
import {
  parsePinnapiFixtures,
  parsePinnapiLiveEventIds,
  parsePinnapiLiveScores,
  parsePinnapiCornerLines,
  parsePinnapiLines,
  pinnapiConfig,
  pinnapiHeaders,
} from "../server/providers/pinnapi";
import { analyzeCornerPayload } from "../server/lib/corner-validation";

describe("PinnAPI Edge fixtures", () => {
  it("maps valid scheduled fixtures and prefers a top-level parent over a duplicate child", () => {
    const fixtures = parsePinnapiFixtures({
      events: [
        {
          event_id: 101,
          parent_id: null,
          league_name: "Premier Test",
          home: "Alpha",
          away: "Beta",
          starts: "2026-08-08T12:00:00Z",
          status: "open",
          periods: { num_0: {} },
        },
        {
          event_id: 102,
          parent_id: 101,
          league_name: "Premier Test",
          home: "Alpha",
          away: "Beta",
          start_ts: 1_786_190_400,
          status: "open",
          periods: { num_0: {} },
        },
        {
          event_id: 103,
          league_name: "Premier Test",
          home: "Live",
          away: "Match",
          starts: "2026-08-08T12:00:00Z",
          status: "inplay",
        },
        {
          event_id: 104,
          league_name: "Premier Test",
          home: "Bad",
          away: "Time",
          starts: "not-a-date",
        },
      ],
    });
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toMatchObject({
      providerMatchId: "101",
      league: "Premier Test",
      homeTeam: "Alpha",
      awayTeam: "Beta",
      parentId: null,
      inplay: false,
    });
  });

  it("keeps a child with num_0 when its parent exposes only a derivative period", () => {
    const fixtures = parsePinnapiFixtures({
      events: [
        {
          event_id: 1633091876,
          parent_id: null,
          league_name: "Parent Child Regression",
          home: "Alpha",
          away: "Beta",
          starts: "2026-08-08T12:00:00Z",
          periods: { num_1: {} },
        },
        {
          event_id: 1633529609,
          parent_id: 1633091876,
          league_name: "Parent Child Regression",
          home: "Alpha",
          away: "Beta",
          starts: "2026-08-08T12:00:00Z",
          periods: { num_0: {} },
        },
      ],
    });

    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toMatchObject({
      providerMatchId: "1633529609",
      parentId: "1633091876",
    });
  });
});

describe("PinnAPI Edge full-match prices", () => {
  it("uses only num_0, retains the home-handicap sign and exact quarter lines", () => {
    const parsed = parsePinnapiLines(
      {
        event_id: 101,
        periods: {
          num_0: {
            status: "closed",
            moneyline: { home: 2.4, draw: 3.3, away: 3.1 },
            spreads: {
              "-0.75": { hdp: -0.75, home: 1.93, away: 1.95, main: true },
              "-0.6": { hdp: -0.6, home: 1.9, away: 1.9 },
              "-0.25": { hdp: -0.25, home: 1, away: 2.1 },
            },
            totals: {
              "2.75": { points: 2.75, over: 1.91, under: 1.99, main: true },
              "2.6": { points: 2.6, over: 1.91, under: 1.99 },
              "3": { points: 3, over: 1, under: 2 },
            },
          },
          num_1: {
            spreads: [{ hdp: -0.25, home: 9, away: 9 }],
            totals: [{ points: 9, over: 9, under: 9 }],
          },
        },
      },
      "101",
    );

    expect(parsed.marketStatus).toBe("closed");
    expect(parsed.prices.filter((price) => price.market === "1X2")).toHaveLength(3);
    expect(parsed.prices.filter((price) => price.market === "AH")).toEqual([
      expect.objectContaining({ market: "AH", lineValue: -0.75, selection: "H", decimalOdds: 1.93 }),
      expect.objectContaining({ market: "AH", lineValue: -0.75, selection: "A", decimalOdds: 1.95 }),
      expect.objectContaining({ market: "AH", lineValue: -0.25, selection: "A", decimalOdds: 2.1 }),
    ]);
    expect(parsed.prices.filter((price) => price.market === "OU")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ market: "OU", lineValue: 2.75, selection: "O", decimalOdds: 1.91 }),
        expect.objectContaining({ market: "OU", lineValue: 2.75, selection: "U", decimalOdds: 1.99 }),
        expect.objectContaining({ market: "OU", lineValue: 3, selection: "U", decimalOdds: 2 }),
      ]),
    );
    expect(parsed.prices.every((price) => price.decimalOdds > 1)).toBe(true);
  });

  it("does not manufacture prices when the full-match period is absent", () => {
    expect(
      parsePinnapiLines({ event_id: 101, periods: { num_1: { spreads: [{ hdp: -0.25, home: 1.9, away: 1.9 }] } } }),
    ).toMatchObject({ eventId: "101", prices: [] });
  });

  it("accepts the compact /lines full-match response without treating an alternate period as full match", () => {
    const compact = parsePinnapiLines(
      {
        status: "closed",
        money_line: { home: 1.7353, draw: 3.92, away: 4.06 },
        spreads: { "-0.75": { hdp: -0.75, home: 1.9346, away: 1.885 } },
        totals: { "2.75": { points: 2.75, over: 1.6757, under: 2.17 } },
      },
      "1633177726",
    );
    expect(compact).toMatchObject({ eventId: "1633177726", marketStatus: "closed" });
    expect(compact.prices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ market: "1X2", selection: "H", decimalOdds: 1.7353 }),
        expect.objectContaining({ market: "AH", lineValue: -0.75, selection: "H", decimalOdds: 1.9346 }),
        expect.objectContaining({ market: "OU", lineValue: 2.75, selection: "U", decimalOdds: 2.17 }),
      ]),
    );
  });
});

describe("PinnAPI Edge full-match corner child prices", () => {
  it("accepts exactly one num_0 corner child with complete two-sided quarter totals", () => {
    const parsed = parsePinnapiCornerLines(
      {
        event_id: "parent-1",
        events: [
          {
            event_id: "corner-child",
            league_name: "Premier Test Corners",
            home: "Alpha Corners",
            away: "Beta Corners",
            periods: {
              num_0: {
                updated_at: 1_786_190_400,
                totals: {
                  "9.75": { points: 9.75, over: 1.91, under: 1.99 },
                  "10.1": { points: 10.1, over: 1.9, under: 1.9 },
                  "10.5": { points: 10.5, over: 1.95 },
                },
              },
              num_1: { totals: { "4.5": { points: 4.5, over: 9, under: 9 } } },
            },
          },
        ],
      },
      "parent-1",
    );

    expect(parsed).toMatchObject({ eventId: "parent-1", cornerEventId: "corner-child", candidateCount: 1 });
    expect(parsed.prices).toEqual([
      expect.objectContaining({ market: "COU", lineValue: 9.75, selection: "O", decimalOdds: 1.91 }),
      expect.objectContaining({ market: "COU", lineValue: 9.75, selection: "U", decimalOdds: 1.99 }),
    ]);
  });

  it("fails closed for absent num_0, ambiguous corner children, partial sides, and ordinary totals", () => {
    expect(
      parsePinnapiCornerLines({
        events: [{ event_id: "half", league: "Corners", periods: { num_1: { totals: [{ points: 4.5, over: 1.9, under: 1.9 }] } } }],
      }),
    ).toMatchObject({ candidateCount: 0, prices: [] });
    expect(
      parsePinnapiCornerLines({
        events: [
          { event_id: "c1", league: "Corners", periods: { num_0: { totals: [{ points: 9.5, over: 1.9, under: 1.9 }] } } },
          { event_id: "c2", league: "Corners", periods: { num_0: { totals: [{ points: 9.5, over: 1.9, under: 1.9 }] } } },
        ],
      }),
    ).toMatchObject({ candidateCount: 2, marketStatus: "ambiguous", prices: [] });
    expect(
      parsePinnapiCornerLines({
        events: [{ event_id: "c1", league: "Corners", periods: { num_0: { totals: [{ points: 9.5, over: 1.9 }] } } }],
      }),
    ).toMatchObject({ candidateCount: 1, prices: [] });
    expect(
      parsePinnapiCornerLines({
        events: [{ event_id: "ordinary", league: "Premier Test", periods: { num_0: { totals: [{ points: 2.5, over: 1.9, under: 1.9 }] } } }],
      }),
    ).toMatchObject({ candidateCount: 0, prices: [] });
  });
});

describe("PinnAPI Edge live-score snapshots", () => {
  it("uses state scores first and only falls back to num_0 metadata for live rows", () => {
    const payload = {
      events: [
        {
          event_id: 901,
          status: "live",
          state: {
            home: { score: 2 },
            away: { score: 1 },
            match: { minutes: 74, status: "running" },
          },
          periods: { num_0: { meta: { home_score: 9, away_score: 9 } } },
        },
        {
          event_id: 902,
          live: true,
          state: { match: { minutes: "90+3" } },
          periods: { num_0: { meta: { home_score: 0, away_score: 0 } } },
        },
        {
          event_id: 903,
          status: "open",
          periods: { num_0: { meta: { home_score: 0, away_score: 0 } } },
        },
      ],
    };

    expect(parsePinnapiLiveScores(payload, 123_456)).toEqual([
      { eventId: "901", homeScore: 2, awayScore: 1, minutes: 74, state: "running", observedAt: 123_456 },
      { eventId: "902", homeScore: 0, awayScore: 0, minutes: 90, state: null, observedAt: 123_456 },
    ]);
    // The endpoint may list an incomplete live row. Its ID still prevents an
    // already-observed event from being falsely marked as ended.
    expect(parsePinnapiLiveEventIds(payload)).toEqual(["901", "902"]);
  });
});

describe("PinnAPI Edge configuration", () => {
  it("uses either supported credential as x-api-key and keeps a safe default base URL", () => {
    expect(pinnapiConfig({} as NodeJS.ProcessEnv)).toEqual({ baseUrl: "https://pinnapi.com", configured: false });
    expect(pinnapiHeaders({ PINNAPI_API_KEY: "test-direct-key" } as NodeJS.ProcessEnv)).toMatchObject({ "x-api-key": "test-direct-key" });
    expect(
      pinnapiHeaders({ PINNAPI_API_KEY: "test-direct-key", CUSTOM_CRED_PINNAPI_COM_TOKEN: "test-platform-token" } as NodeJS.ProcessEnv),
    ).toMatchObject({ "x-api-key": "test-platform-token" });
    expect(
      pinnapiConfig({ CUSTOM_CRED_PINNAPI_COM_TOKEN: "token", CUSTOM_CRED_PINNAPI_COM_URL: "https://edge.example/" } as NodeJS.ProcessEnv),
    ).toEqual({ baseUrl: "https://edge.example", configured: true });
    expect(
      pinnapiConfig({ PINNAPI_BASE_URL: "https://user:secret@edge.example/path?api_key=secret#fragment" } as NodeJS.ProcessEnv),
    ).toEqual({ baseUrl: "https://edge.example/path", configured: false });
  });
});

describe("PinnAPI corner-market validation", () => {
  it("requires explicit corner context and a complete over/under quote", () => {
    const analysis = analyzeCornerPayload({
      updated_at: "2026-08-09T02:00:00Z",
      periods: {
        num_0: {
          totals: [{ points: 2.5, over: 1.9, under: 1.95 }],
          corner_totals: [
            { points: 9.5, over: 1.91, under: 1.99 },
            { points: 10.5, over: 1.94 },
          ],
        },
      },
    });
    expect(analysis.quotes).toEqual([
      expect.objectContaining({ line: 9.5, over: 1.91, under: 1.99, sourceTimestamp: "2026-08-09T02:00:00Z" }),
    ]);
    expect(analysis.signalPaths.some((path) => path.includes("corner_totals"))).toBe(true);
  });

  it("does not mistake ordinary match totals for corner markets", () => {
    const analysis = analyzeCornerPayload({
      periods: { num_0: { totals: [{ points: 2.75, over: 1.9, under: 1.95 }] } },
    });
    expect(analysis.signalPaths).toEqual([]);
    expect(analysis.quotes).toEqual([]);
  });
});
