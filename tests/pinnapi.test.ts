import { describe, expect, it } from "vitest";
import {
  parsePinnapiFixtures,
  parsePinnapiLines,
  pinnapiConfig,
  pinnapiHeaders,
} from "../server/providers/pinnapi";

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
