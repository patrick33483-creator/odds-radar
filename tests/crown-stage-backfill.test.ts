/**
 * Crown-only stage rescue: rebuilding missed T30/T15/T5 OU checkpoints from the
 * titan007 「變化时间」 history page.
 *
 * The live Crown collector is throughput-bound (two sequential titan round
 * trips per fixture inside a 10-second slice), so on a busy slate a fixture can
 * sail past its T-30 window without ever being polled. A missing stage silently
 * kills the whole OU signal for that fixture, and the window can never be
 * re-observed live. The history page, however, still lists every quote change
 * with its timestamp hours later — which is what these tests pin down.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dbPath = `/tmp/odds-radar-stage-backfill-${process.pid}.db`;
process.env.RADAR_DB = dbPath;

/** A real (trimmed) capture of changeDetail/overunder.aspx?companyid=47. */
const SAMPLE_HTML = readFileSync(
  fileURLToPath(new URL("./fixtures/titan-changedetail-ou.html", import.meta.url)),
  "utf8",
);

let rawDb: typeof import("../server/lib/store").rawDb;
let RadarEngine: typeof import("../server/lib/engine").RadarEngine;
let prioritizeCrownResearchTargets: typeof import("../server/lib/engine").prioritizeCrownResearchTargets;
let parseTitanOuHistoryRows: typeof import("../server/providers/pinnacle").parseTitanOuHistoryRows;
let parseTitanHistoryCompany: typeof import("../server/providers/pinnacle").parseTitanHistoryCompany;
let parseTitanTotalCell: typeof import("../server/providers/pinnacle").parseTitanTotalCell;
let researchStageWindow: typeof import("../server/lib/research").researchStageWindow;
let selectStageHistoryRow: typeof import("../server/lib/research").selectStageHistoryRow;

/** The sample page belongs to a fixture kicking off 2026-09-04 13:00 HKT. */
const SAMPLE_KICKOFF = Date.UTC(2026, 8, 4, 5, 0);
const HK = 8 * 3_600_000;
/** 9-4 12:24 HKT — the last pre-match tick before the T-30 window opens. */
const TICK_1224 = Date.UTC(2026, 8, 4, 12, 24) - HK;
/** 9-4 12:59 HKT — a genuine in-window T-5 tick. */
const TICK_1259 = Date.UTC(2026, 8, 4, 12, 59) - HK;

function historyRow(minutesBeforeKickoff: number, overHk: number, prematch = true) {
  return {
    timestamp: SAMPLE_KICKOFF - minutesBeforeKickoff * 60_000,
    line: 2.5,
    overHk,
    underHk: 0.9,
    status: prematch ? "早" : "滚",
    prematch,
  };
}

function addCrownFixture(id: string, titanId: string, kickoff: number): void {
  rawDb.prepare(
    `INSERT INTO matches(
      id,hkjc_id,fixture_source,titan_id,league,home_team,away_team,kickoff_utc,status,inplay,updated_at
    ) VALUES(?,NULL,'crown',?,'日職乙','岡山綠雉','德島漩渦',?,'PREEVENT',0,?)`,
  ).run(id, titanId, kickoff, Date.now());
}

function addHkjcFixture(id: string, titanId: string, kickoff: number): void {
  rawDb.prepare(
    `INSERT INTO matches(
      id,hkjc_id,fixture_source,titan_id,league,home_team,away_team,kickoff_utc,status,inplay,updated_at
    ) VALUES(?,?, 'hkjc',?,'英超','曼城','阿仙奴',?,'PREEVENT',0,?)`,
  ).run(id, id, titanId, kickoff, Date.now());
}

/** Engine whose only live dependency is the history fetch. */
function engineWith(fetchHistory: unknown) {
  const engine = new RadarEngine();
  (engine as unknown as { pinnacle: { fetchTitanOuHistory: unknown } }).pinnacle.fetchTitanOuHistory =
    fetchHistory;
  return engine;
}

function historyPage(rows: ReturnType<typeof historyRow>[], company = "平*") {
  return { company, rows, sourceUrl: "https://vip.titan007.com/changeDetail/overunder.aspx?id=1&companyid=47&l=0" };
}

function ouSnapshots(matchId: string) {
  return rawDb.prepare(
    `SELECT provider,stage,selection,decimal_odds,captured_at,origin,source_name
       FROM research_timeline_snapshots WHERE match_id=? AND market='OU'
      ORDER BY stage,provider,selection`,
  ).all(matchId) as Array<{
    provider: string;
    stage: string;
    selection: string;
    decimal_odds: number;
    captured_at: number;
    origin: string;
    source_name: string;
  }>;
}

beforeAll(async () => {
  const store = await import("../server/lib/store");
  const research = await import("../server/lib/research");
  const engineModule = await import("../server/lib/engine");
  const pinnacle = await import("../server/providers/pinnacle");
  rawDb = store.rawDb;
  RadarEngine = engineModule.RadarEngine;
  prioritizeCrownResearchTargets = engineModule.prioritizeCrownResearchTargets;
  parseTitanOuHistoryRows = pinnacle.parseTitanOuHistoryRows;
  parseTitanHistoryCompany = pinnacle.parseTitanHistoryCompany;
  parseTitanTotalCell = pinnacle.parseTitanTotalCell;
  researchStageWindow = research.researchStageWindow;
  selectStageHistoryRow = research.selectStageHistoryRow;
  store.migrate();
});

afterAll(() => {
  rawDb.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { rmSync(`${dbPath}${suffix}`); } catch { /* SQLite sidecar optional. */ }
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const table of [
    "research_timeline_snapshots", "research_timeline_points", "research_results",
    "odds_latest", "odds_snapshots", "market_lines", "ou_signal_observations",
    "ou_signal_prealerts", "matches",
  ]) {
    rawDb.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("titan007 history parsing", () => {
  it("reads the real 「變化时间」 table, keeping pre-match and in-play ticks apart", () => {
    const rows = parseTitanOuHistoryRows(SAMPLE_HTML, SAMPLE_KICKOFF);
    // Oldest first, and the 封 (closed) rows must not survive as prices.
    expect(rows.map((r) => r.status)).toEqual(["早", "早", "即", "即", "滚", "滚"]);
    expect(rows.every((r) => r.prematch === (r.status !== "滚"))).toBe(true);

    const prematch = rows.filter((r) => r.prematch);
    // Prices stay in Hong Kong format; the 2.5/3 quarter line becomes 2.75.
    expect(prematch.map((r) => r.overHk)).toEqual([0.9, 0.92, 0.89, 0.87]);
    expect(prematch.every((r) => r.line === 2.75)).toBe(true);
    // Year is inferred from the kickoff because titan omits it.
    expect(prematch[prematch.length - 1].timestamp).toBe(TICK_1259);
  });

  it("verifies the bookmaker by its masked label instead of the numeric id", () => {
    expect(parseTitanHistoryCompany(SAMPLE_HTML)).toBe("平*");
    expect(parseTitanHistoryCompany("<html>no chart iframe</html>")).toBe("");
  });

  it("snaps quarter totals and rejects closed cells", () => {
    expect(parseTitanTotalCell("2.5/3")).toBe(2.75);
    expect(parseTitanTotalCell("4.5")).toBe(4.5);
    expect(parseTitanTotalCell("封")).toBeNull();
    expect(parseTitanTotalCell("2-2")).toBeNull();
  });
});

describe("stage window selection", () => {
  it("derives windows that agree with researchStageFor's minute bounds", () => {
    expect(researchStageWindow("T30", SAMPLE_KICKOFF)).toEqual({
      from: SAMPLE_KICKOFF - 30 * 60_000,
      to: SAMPLE_KICKOFF - 15 * 60_000,
    });
    expect(researchStageWindow("T5", SAMPLE_KICKOFF)).toEqual({
      from: SAMPLE_KICKOFF - 5 * 60_000,
      to: SAMPLE_KICKOFF,
    });
  });

  it("prefers an in-window tick, else carries the last standing quote forward", () => {
    const rows = parseTitanOuHistoryRows(SAMPLE_HTML, SAMPLE_KICKOFF).filter((r) => r.prematch);

    // 12:59 sits inside [12:55, 13:00) — exact evidence for T5.
    const t5 = selectStageHistoryRow(rows, SAMPLE_KICKOFF, "T5");
    expect(t5).toMatchObject({ inWindow: true });
    expect(t5!.row.timestamp).toBe(TICK_1259);

    // Nothing moved between 12:30 and 12:45, so the 12:24 quote was the price
    // actually standing during T-30 — that is what a live poll would have seen.
    const t30 = selectStageHistoryRow(rows, SAMPLE_KICKOFF, "T30");
    expect(t30).toMatchObject({ inWindow: false });
    expect(t30!.row.timestamp).toBe(TICK_1224);
  });

  it("never promotes an in-play tick into a pre-match checkpoint", () => {
    const onlyInplay = [historyRow(-10, 1.5, false), historyRow(-2, 1.6, false)];
    expect(selectStageHistoryRow(onlyInplay, SAMPLE_KICKOFF, "T5")).toBeNull();
    // A pre-match tick behind an in-play one is still selectable.
    const mixed = [historyRow(40, 0.95), ...onlyInplay];
    expect(selectStageHistoryRow(mixed, SAMPLE_KICKOFF, "T5")!.row.overHk).toBe(0.95);
  });
});

describe("Crown research prioritisation", () => {
  it("serves the checkpoint nearest kickoff first, not merely the earliest kickoff", () => {
    const now = Date.UTC(2026, 8, 4, 5, 0);
    const target = (matchId: string, minutesToKickoff: number) => ({
      matchId,
      titanId: matchId,
      kickoffUtc: now + minutesToKickoff * 60_000,
      league: "L",
      homeTeam: "H",
      awayTeam: "A",
    });
    // t5 kicks off LATEST of the three, so a kickoff-only sort would rank it last.
    const ordered = prioritizeCrownResearchTargets(
      [target("t30", 20), target("t15", 10), target("t5", 3)],
      new Set(),
      new Set(),
      now,
    );
    expect(ordered.map((t) => t.matchId)).toEqual(["t5", "t15", "t30"]);
    expect(ordered.map((t) => t.stage)).toEqual(["T5", "T15", "T30"]);
  });

  it("still ranks every due milestone above opening-only work", () => {
    const now = Date.UTC(2026, 8, 4, 5, 0);
    const base = { league: "L", homeTeam: "H", awayTeam: "A" };
    const ordered = prioritizeCrownResearchTargets(
      [
        { matchId: "opening", titanId: "opening", kickoffUtc: now + 90 * 60_000, ...base },
        { matchId: "t30", titanId: "t30", kickoffUtc: now + 20 * 60_000, ...base },
      ],
      new Set(),
      new Set(),
      now,
    );
    expect(ordered.map((t) => t.reason)).toEqual(["milestone", "opening"]);
  });
});

describe("rescueCrownStageBackfill", () => {
  it("rebuilds the missed stages of a Crown-only fixture as Pinnacle OU rows", async () => {
    const kickoff = Date.now() - 20 * 60_000; // every window already closed
    addCrownFixture("crown:910001", "910001", kickoff);
    const rows = [
      { timestamp: kickoff - 28 * 60_000, line: 2.5, overHk: 0.92, underHk: 0.88, status: "早", prematch: true },
      { timestamp: kickoff - 12 * 60_000, line: 2.5, overHk: 0.85, underHk: 0.95, status: "即", prematch: true },
      { timestamp: kickoff - 2 * 60_000, line: 2.5, overHk: 0.80, underHk: 1.00, status: "即", prematch: true },
    ];
    const fetchHistory = vi.fn().mockImplementation(async (_id: string, companyId: string) =>
      companyId === "3" ? historyPage([], "Crow*") : historyPage(rows));
    const engine = engineWith(fetchHistory);

    const outcome = await engine.rescueCrownStageBackfill(Date.now());
    expect(outcome).toMatchObject({ fixtures: 1, failed: 0, stages: 3, rows: 6 });

    const snapshots = ouSnapshots("crown:910001").filter((s) => s.provider === "pinnacle");
    expect(new Set(snapshots.map((s) => s.stage))).toEqual(new Set(["T30", "T15", "T5"]));
    // Rescued rows are labelled and timestamped honestly: captured_at is the
    // historical tick, never "now".
    expect(snapshots.every((s) => s.origin === "backfill")).toBe(true);
    expect(snapshots.every((s) => s.source_name === "titan007-history-pinnacle")).toBe(true);
    const t5 = snapshots.filter((s) => s.stage === "T5");
    expect(t5.map((s) => s.captured_at)).toEqual([kickoff - 2 * 60_000, kickoff - 2 * 60_000]);
    // 0.80 HK -> 1.80 decimal for the over side.
    expect(t5.find((s) => s.selection === "O")!.decimal_odds).toBeCloseTo(1.8, 6);
  });

  it("is idempotent and never overwrites a stage captured live", async () => {
    const kickoff = Date.now() - 20 * 60_000;
    addCrownFixture("crown:910002", "910002", kickoff);
    // A live T5 capture already exists at a different price.
    for (const [selection, odds] of [["O", 1.95], ["U", 1.90]] as const) {
      rawDb.prepare(
        `INSERT INTO research_timeline_snapshots(
          match_id,provider,market,stage,line_key,selection,decimal_odds,is_main,
          captured_at,status,origin
        ) VALUES(?,'pinnacle','OU','T5','2.50',?,?,1,?, 'captured','live')`,
      ).run("crown:910002", selection, odds, kickoff - 60_000);
    }
    const rows = [
      { timestamp: kickoff - 28 * 60_000, line: 2.5, overHk: 0.92, underHk: 0.88, status: "早", prematch: true },
      { timestamp: kickoff - 2 * 60_000, line: 2.5, overHk: 0.80, underHk: 1.00, status: "即", prematch: true },
    ];
    const engine = engineWith(vi.fn().mockImplementation(async (_id: string, companyId: string) =>
      companyId === "3" ? historyPage([], "Crow*") : historyPage(rows)));

    const first = await engine.rescueCrownStageBackfill(Date.now());
    // Only T30 and T15 were owed; T5 was already held.
    expect(first.stages).toBe(2);
    const live = ouSnapshots("crown:910002").filter((s) => s.stage === "T5");
    expect(live.every((s) => s.origin === "live")).toBe(true);
    expect(live.find((s) => s.selection === "O")!.decimal_odds).toBe(1.95);

    // A second pass writes nothing: Pinnacle is complete, and the Crown lookup
    // that came back empty is not retried at all.
    const second = await engine.rescueCrownStageBackfill(Date.now());
    expect(second).toEqual({ fixtures: 0, fetched: 0, failed: 0, stages: 0, rows: 0 });
  });

  it("leaves HKJC fixtures, open windows and mislabelled pages alone", async () => {
    const closed = Date.now() - 20 * 60_000;
    addHkjcFixture("hkjc:1", "920001", closed);
    addCrownFixture("crown:910003", "910003", Date.now() + 10 * 60_000); // T15/T5 still open
    addCrownFixture("crown:910004", "910004", closed);
    const rows = [
      { timestamp: closed - 40 * 60_000, line: 2.5, overHk: 0.92, underHk: 0.88, status: "早", prematch: true },
    ];
    // Every request answers with a page whose label is NOT the book we asked for.
    const fetchHistory = vi.fn().mockResolvedValue(historyPage(rows, "Interwet*"));
    const engine = engineWith(fetchHistory);

    const outcome = await engine.rescueCrownStageBackfill(Date.now());
    // The HKJC fixture is never even requested — its code path is untouched.
    expect(fetchHistory.mock.calls.every((call) => call[0] !== "920001")).toBe(true);
    // The still-open fixture only owes its already-closed T30 window.
    expect(outcome.fetched).toBeGreaterThan(0);
    // …and nothing is written, because the page is not Pinnacle or Crown.
    expect(outcome).toMatchObject({ stages: 0, rows: 0 });
    expect(ouSnapshots("crown:910004")).toHaveLength(0);
  });

  it("survives a provider failure and honours its time budget", async () => {
    const kickoff = Date.now() - 20 * 60_000;
    addCrownFixture("crown:910005", "910005", kickoff);
    const engine = engineWith(vi.fn().mockRejectedValue(new Error("titan 502")));

    const failed = await engine.rescueCrownStageBackfill(Date.now());
    expect(failed).toMatchObject({ fixtures: 1, fetched: 0, stages: 0, rows: 0 });
    expect(failed.failed).toBeGreaterThan(0);

    // An exhausted budget short-circuits before any fetch is attempted.
    const noBudget = vi.fn();
    const starved = await engineWith(noBudget).rescueCrownStageBackfill(Date.now(), Date.now());
    expect(starved).toEqual({ fixtures: 0, fetched: 0, failed: 0, stages: 0, rows: 0 });
    expect(noBudget).not.toHaveBeenCalled();
  });
});
