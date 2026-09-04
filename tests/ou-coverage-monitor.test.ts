/**
 * OU three-stage coverage watchdog.
 *
 * A fixture that misses any one of initial / T30 / T5 produces NO OU signal and
 * NO error — it just quietly disappears from the alert stream, which is exactly
 * how a collector throughput regression hides. These tests pin the watchdog that
 * turns that silence into a Telegram alert, and pin the noise controls that stop
 * it from becoming one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const dbPath = `/tmp/odds-radar-ou-coverage-${process.pid}.db`;
process.env.RADAR_DB = dbPath;

let rawDb: typeof import("../server/lib/store").rawDb;
let findOuCoverageGaps: typeof import("../server/lib/ou-coverage-monitor").findOuCoverageGaps;
let unnotifiedOuCoverageGaps: typeof import("../server/lib/ou-coverage-monitor").unnotifiedOuCoverageGaps;
let buildOuCoverageGapMessage: typeof import("../server/lib/ou-coverage-monitor").buildOuCoverageGapMessage;
let notifyOuSignalCoverageGap: typeof import("../server/lib/ou-coverage-monitor").notifyOuSignalCoverageGap;

const NOW = Date.UTC(2026, 8, 4, 12, 0);
/** Far enough past kickoff that a late write is no longer an excuse. */
const CLOSED_KICKOFF = NOW - 30 * 60_000;

function addFixture(id: string, source: "crown" | "hkjc", kickoff: number): void {
  rawDb.prepare(
    `INSERT INTO matches(
      id,hkjc_id,fixture_source,titan_id,league,home_team,away_team,kickoff_utc,status,inplay,updated_at
    ) VALUES(?,?,?,?, '日職乙','岡山綠雉','德島漩渦',?,'PREEVENT',0,?)`,
  ).run(id, source === "hkjc" ? id : null, source, id.split(":")[1] ?? id, kickoff, NOW);
}

/** Write a complete O+U pair for one provider/stage — the unit the signal reads. */
function addStage(matchId: string, provider: string, stage: string, lineKey = "2.50"): void {
  for (const [selection, odds] of [["O", 1.92], ["U", 1.90]] as const) {
    rawDb.prepare(
      `INSERT INTO research_timeline_snapshots(
        match_id,provider,market,stage,line_key,selection,decimal_odds,is_main,captured_at,status,origin
      ) VALUES(?,?, 'OU',?,?,?,?,1,?,'captured','live')`,
    ).run(matchId, provider, stage, lineKey, selection, odds, NOW - 60_000);
  }
}

/** Half a stage: one side only, which the signal path cannot use. */
function addHalfStage(matchId: string, provider: string, stage: string): void {
  rawDb.prepare(
    `INSERT INTO research_timeline_snapshots(
      match_id,provider,market,stage,line_key,selection,decimal_odds,is_main,captured_at,status,origin
    ) VALUES(?,?, 'OU',?,'2.50','O',1.92,1,?,'captured','live')`,
  ).run(matchId, provider, stage, NOW - 60_000);
}

beforeAll(async () => {
  const store = await import("../server/lib/store");
  const monitor = await import("../server/lib/ou-coverage-monitor");
  rawDb = store.rawDb;
  findOuCoverageGaps = monitor.findOuCoverageGaps;
  unnotifiedOuCoverageGaps = monitor.unnotifiedOuCoverageGaps;
  buildOuCoverageGapMessage = monitor.buildOuCoverageGapMessage;
  notifyOuSignalCoverageGap = monitor.notifyOuSignalCoverageGap;
  store.migrate();
});

afterAll(() => {
  rawDb.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { rmSync(`${dbPath}${suffix}`); } catch { /* SQLite sidecar optional. */ }
  }
});

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_CHAT_ID = "test-chat";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  for (const table of ["research_timeline_snapshots", "matches", "notified_ou_coverage_gaps"]) {
    try { rawDb.prepare(`DELETE FROM ${table}`).run(); } catch { /* created lazily */ }
  }
});

describe("findOuCoverageGaps", () => {
  it("reports a fixture that captured some but not all three stages", () => {
    addFixture("crown:930001", "crown", CLOSED_KICKOFF);
    addStage("crown:930001", "pinnacle", "initial");
    addStage("crown:930001", "pinnacle", "T30");

    const gaps = findOuCoverageGaps(NOW);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      matchId: "crown:930001",
      provider: "pinnacle",
      fixtureSource: "crown",
      capturedStages: ["initial", "T30"],
      missingStages: ["T5"],
    });
  });

  it("stays silent for complete coverage, for never-in-scope fixtures and before settle time", () => {
    // Complete: all three stages present.
    addFixture("crown:930002", "crown", CLOSED_KICKOFF);
    for (const stage of ["initial", "T30", "T5"]) addStage("crown:930002", "pinnacle", stage);
    // Never in scope: no OU snapshot at all (no board, no mapping) — reporting
    // these would bury the real regressions in noise.
    addFixture("crown:930003", "crown", CLOSED_KICKOFF);
    // Too fresh: kicked off two minutes ago, a late T5 write is still plausible.
    addFixture("crown:930004", "crown", NOW - 2 * 60_000);
    addStage("crown:930004", "pinnacle", "initial");

    expect(findOuCoverageGaps(NOW)).toEqual([]);
  });

  it("counts a stage only when the same provider holds BOTH sides of one line", () => {
    addFixture("crown:930005", "crown", CLOSED_KICKOFF);
    addStage("crown:930005", "pinnacle", "initial");
    addStage("crown:930005", "pinnacle", "T30");
    addHalfStage("crown:930005", "pinnacle", "T5"); // over only — unusable

    const gaps = findOuCoverageGaps(NOW);
    expect(gaps[0].missingStages).toEqual(["T5"]);
  });

  it("treats a fixture as healthy when ANY single provider is complete", () => {
    addFixture("hkjc:930006", "hkjc", CLOSED_KICKOFF);
    for (const stage of ["initial", "T30", "T5"]) addStage("hkjc:930006", "hkjc", stage);
    addStage("hkjc:930006", "pinnacle", "initial"); // partial second provider

    expect(findOuCoverageGaps(NOW)).toEqual([]);
  });
});

describe("notifyOuSignalCoverageGap", () => {
  it("sends one grouped alert and never repeats a fixture", async () => {
    addFixture("crown:930007", "crown", CLOSED_KICKOFF);
    addStage("crown:930007", "pinnacle", "initial");
    addFixture("crown:930008", "crown", CLOSED_KICKOFF - 60_000);
    addStage("crown:930008", "pinnacle", "T30");

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    expect(await notifyOuSignalCoverageGap(NOW)).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1); // one message, not one per fixture
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { text: string };
    expect(body.text).toContain("OU 三段覆蓋缺口");
    expect(body.text).toContain("岡山綠雉");

    // Second run: already announced, so nothing is sent again.
    expect(await notifyOuSignalCoverageGap(NOW)).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(unnotifiedOuCoverageGaps(NOW)).toEqual([]);
  });

  it("does not mark anything as notified when Telegram rejects the message", async () => {
    addFixture("crown:930009", "crown", CLOSED_KICKOFF);
    addStage("crown:930009", "pinnacle", "initial");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 }),
    );

    await expect(notifyOuSignalCoverageGap(NOW)).rejects.toThrow(/chat not found/);
    // The gap must stay outstanding so the next tick can retry it.
    expect(unnotifiedOuCoverageGaps(NOW)).toHaveLength(1);
  });

  it("is inert without Telegram credentials", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    addFixture("crown:930010", "crown", CLOSED_KICKOFF);
    addStage("crown:930010", "pinnacle", "initial");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    expect(await notifyOuSignalCoverageGap(NOW)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the missing stages in the message so a gap is actionable", () => {
    const message = buildOuCoverageGapMessage([{
      matchId: "crown:930011",
      league: "日職乙",
      homeTeam: "岡山綠雉",
      awayTeam: "德島漩渦",
      kickoffUtc: CLOSED_KICKOFF,
      fixtureSource: "crown",
      provider: "pinnacle",
      capturedStages: ["initial"],
      missingStages: ["T30", "T5"],
    }]);
    expect(message).toContain("缺 T30/T5");
    expect(message).toContain("crown｜pinnacle");
  });
});
