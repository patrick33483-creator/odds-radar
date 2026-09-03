import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const dbPath = `/tmp/odds-radar-quote-watch-${process.pid}.db`;
process.env.RADAR_DB = dbPath;

let rawDb: typeof import("../server/lib/store").rawDb;
let sync: typeof import("../server/lib/quote-direction-watch").syncQuoteDirectionWatchObservations;
let activatedKey: typeof import("../server/lib/quote-direction-watch").QUOTE_DIRECTION_WATCH_ACTIVATED_AT;
let waterRule: typeof import("../server/lib/quote-direction-watch").WATCH_LEAGUE_WATER;
let lagRule: typeof import("../server/lib/quote-direction-watch").WATCH_T30_HKJC_LAG;

beforeAll(async () => {
  const store = await import("../server/lib/store");
  const watch = await import("../server/lib/quote-direction-watch");
  rawDb = store.rawDb;
  store.migrate();
  sync = watch.syncQuoteDirectionWatchObservations;
  activatedKey = watch.QUOTE_DIRECTION_WATCH_ACTIVATED_AT;
  waterRule = watch.WATCH_LEAGUE_WATER;
  lagRule = watch.WATCH_T30_HKJC_LAG;
});

afterEach(() => {
  for (const table of [
    "quote_direction_watch_observations",
    "research_timeline_snapshots",
    "research_timeline_points",
    "matches",
    "app_state",
    "odds_latest",
    "odds_snapshots",
    "market_lines",
    "opportunities",
    "simulation_bets",
    "ou_signal_prealerts",
    "ou_signal_observations",
  ]) rawDb.prepare(`DELETE FROM ${table}`).run();
});

afterAll(() => {
  rawDb.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { rmSync(`${dbPath}${suffix}`); } catch { /* optional SQLite sidecar */ }
  }
});

function activate(at = 1_000_000): void {
  rawDb.prepare(
    "INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
  ).run(activatedKey, String(at), at);
}

function addMatch(id: string, kickoff: number, league = "測試聯賽"): void {
  rawDb.prepare(
    `INSERT INTO matches(id,hkjc_id,fixture_source,league,home_team,away_team,kickoff_utc,status,inplay,updated_at)
     VALUES(?,?, 'hkjc', ?, '主隊', '客隊', ?, 'PREEVENT', 0, ?)`,
  ).run(id, id, league, kickoff, kickoff);
}

function pair(
  matchId: string,
  provider: "hkjc" | "pinnacle",
  stage: "initial" | "T30" | "T5",
  market: "AH" | "OU",
  lineKey: string,
  firstSelection: "H" | "A" | "O" | "U",
  firstOdds: number,
  secondSelection: "H" | "A" | "O" | "U",
  secondOdds: number,
  capturedAt: number,
  isMain = true,
): void {
  const insert = rawDb.prepare(
    `INSERT INTO research_timeline_snapshots(
      match_id,provider,market,stage,line_key,selection,decimal_odds,is_main,captured_at,status,origin
    ) VALUES(?,?,?,?,?,?,?,?,?,'captured',?)`,
  );
  insert.run(matchId, provider, market, stage, lineKey, firstSelection, firstOdds, isMain ? 1 : 0, capturedAt, stage === "initial" ? "external_opening" : "live_observation");
  insert.run(matchId, provider, market, stage, lineKey, secondSelection, secondOdds, isMain ? 1 : 0, capturedAt, stage === "initial" ? "external_opening" : "live_observation");
}

function t30Candidate(id: string, capturedAt: number, overGap = 0, underGap = 0): void {
  addMatch(id, capturedAt + 60 * 60_000);
  pair(id, "pinnacle", "T30", "OU", "2.50", "O", 1.90, "U", 1.90, capturedAt);
  pair(id, "hkjc", "T30", "OU", "2.50", "O", 1.90 + overGap, "U", 1.90 + underGap, capturedAt);
}

function ahT30Candidate(id: string, capturedAt: number): void {
  addMatch(id, capturedAt + 60 * 60_000);
  pair(id, "pinnacle", "T30", "AH", "-0.25", "H", 1.90, "A", 1.90, capturedAt);
  pair(id, "hkjc", "T30", "AH", "-0.25", "H", 1.90, "A", 1.90, capturedAt);
}

describe("isolated quote-direction watches", () => {
  it("accepts the inclusive 0.030 HKJC lag but not 0.029", () => {
    activate();
    t30Candidate("lag-029", 1_010_000, 0.029, 0);
    t30Candidate("lag-030", 1_020_000, 0.030, 0);

    expect(sync()).toMatchObject({ candidates: 2, inserted: 1 });
    expect(rawDb.prepare(
      "SELECT match_id,selection,decision_odds,reference_odds,odds_gap,status,notified_at FROM quote_direction_watch_observations WHERE rule_id=?",
    ).all(lagRule)).toEqual([{
      match_id: "lag-030", selection: "O", decision_odds: 1.93, reference_odds: 1.9,
      odds_gap: 0.03, status: "pending", notified_at: null,
    }]);
  });

  it("records insufficient baseline instead of forcing the league-water group", () => {
    activate();
    ahT30Candidate("water-insufficient", 1_020_000);
    pair("water-insufficient", "pinnacle", "initial", "AH", "-0.25", "H", 1.95, "A", 1.95, 1_010_000);

    expect(sync()).toMatchObject({ insufficientBaseline: 2 });
    expect(rawDb.prepare(
      "SELECT selection,status,baseline_count,baseline_version,percentile_low,percentile_high FROM quote_direction_watch_observations WHERE rule_id=? ORDER BY selection",
    ).all(waterRule)).toEqual([
      expect.objectContaining({ selection: "A", status: "insufficient_baseline", baseline_count: 0, percentile_low: null, percentile_high: null }),
      expect.objectContaining({ selection: "H", status: "insufficient_baseline", baseline_count: 0, percentile_low: null, percentile_high: null }),
    ]);
  });

  it("freezes the audited AH league-water P70-P90 decision from prior same-line observations", () => {
    activate();
    for (let i = 0; i < 15; i++) {
      const captured = 1_010_000 + i * 1_000;
      ahT30Candidate(`baseline-${i}`, captured);
      const water = i < 11 ? 0.02 : 0.06;
      pair(`baseline-${i}`, "pinnacle", "initial", "AH", "-0.25", "H", 1.90 + water, "A", 1.90 + water, captured - 500);
    }
    ahT30Candidate("water-in-band", 1_100_000);
    pair("water-in-band", "pinnacle", "initial", "AH", "-0.25", "H", 1.94, "A", 1.94, 1_090_000);

    sync();
    expect(rawDb.prepare(
      "SELECT selection,status,percentile_low,percentile_high,baseline_count,decision_odds FROM quote_direction_watch_observations WHERE rule_id=? AND match_id=? ORDER BY selection",
    ).all(waterRule, "water-in-band")).toEqual([
      { selection: "A", status: "pending", percentile_low: 0.02, percentile_high: 0.06, baseline_count: 30, decision_odds: 1.9 },
      { selection: "H", status: "pending", percentile_low: 0.02, percentile_high: 0.06, baseline_count: 30, decision_odds: 1.9 },
    ]);
  });

  it("never backfills a pre-activation fixture", () => {
    activate(2_000_000);
    t30Candidate("before-activation", 1_999_999, 0.05, 0.05);
    pair("before-activation", "pinnacle", "initial", "OU", "2.50", "O", 1.95, "U", 1.95, 1_900_000);

    expect(sync()).toEqual({ candidates: 0, inserted: 0, insufficientBaseline: 0, t5Confirmed: 0 });
    expect(rawDb.prepare("SELECT COUNT(*) count FROM quote_direction_watch_observations").get()).toEqual({ count: 0 });
  });

  it("stores T5 confirmation without changing the selected side or T30 decision odds", () => {
    activate();
    t30Candidate("t5-confirm", 1_020_000, 0.03, 0);
    expect(sync().inserted).toBe(1);
    pair("t5-confirm", "pinnacle", "T5", "OU", "2.50", "O", 1.85, "U", 1.95, 1_030_000);

    expect(sync().t5Confirmed).toBe(1);
    expect(rawDb.prepare(
      "SELECT selection,decision_odds,reference_odds,status,t5_odds,t5_change,t5_confirmation FROM quote_direction_watch_observations WHERE rule_id=?",
    ).get(lagRule)).toEqual({
      selection: "O", decision_odds: 1.93, reference_odds: 1.9, status: "pending",
      t5_odds: 1.85, t5_change: 0.05, t5_confirmation: "continue_water",
    });
    expect(sync().inserted).toBe(0);
  });

  it("writes only its own ledger and makes no Telegram HTTP call", () => {
    activate();
    t30Candidate("isolated", 1_020_000, 0.03, 0);
    const executionTables = [
      "odds_latest", "odds_snapshots", "market_lines", "opportunities",
      "simulation_bets", "ou_signal_prealerts", "ou_signal_observations",
    ];
    const before = Object.fromEntries(executionTables.map((table) => [
      table, (rawDb.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count,
    ]));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    sync();
    expect(Object.fromEntries(executionTables.map((table) => [
      table, (rawDb.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count,
    ]))).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
