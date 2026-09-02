import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

const dbPath = `/tmp/odds-radar-ou-signals-${process.pid}.db`;
process.env.RADAR_DB = dbPath;

let rawDb: typeof import("../server/lib/store").rawDb;
let markOuPrealertNotified: typeof import("../server/lib/ou-signals").markOuPrealertNotified;
let markOuSignalNotified: typeof import("../server/lib/ou-signals").markOuSignalNotified;
let ouSignalDataset: typeof import("../server/lib/ou-signals").ouSignalDataset;
let syncOuSignalObservations: typeof import("../server/lib/ou-signals").syncOuSignalObservations;
let syncOuSignalPrealerts: typeof import("../server/lib/ou-signals").syncOuSignalPrealerts;
let unsentOuPrealerts: typeof import("../server/lib/ou-signals").unsentOuPrealerts;
let unsentOuSignals: typeof import("../server/lib/ou-signals").unsentOuSignals;

beforeAll(async () => {
  const store = await import("../server/lib/store");
  const signals = await import("../server/lib/ou-signals");
  rawDb = store.rawDb;
  markOuPrealertNotified = signals.markOuPrealertNotified;
  markOuSignalNotified = signals.markOuSignalNotified;
  ouSignalDataset = signals.ouSignalDataset;
  syncOuSignalObservations = signals.syncOuSignalObservations;
  syncOuSignalPrealerts = signals.syncOuSignalPrealerts;
  unsentOuPrealerts = signals.unsentOuPrealerts;
  unsentOuSignals = signals.unsentOuSignals;
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

type Side = "O" | "U";
type Stage = "initial" | "T30" | "T5";

function addMatch(id: string, kickoff: number): void {
  rawDb.prepare(
    `INSERT INTO matches(
      id,hkjc_id,league,home_team,away_team,kickoff_utc,status,inplay,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(id, id, "訊號聯賽", `${id}主隊`, `${id}客隊`, kickoff, "PREEVENT", 0, Date.now());
}

function addStage(
  matchId: string,
  provider: "hkjc" | "pinnacle",
  stage: Stage,
  lineKey: string,
  over: number,
  under: number,
  capturedAt: number,
): void {
  const insert = rawDb.prepare(
    `INSERT INTO research_timeline_snapshots(
      match_id,provider,market,stage,line_key,selection,decimal_odds,is_main,
      captured_at,status,origin,source_name
    ) VALUES(?,?,?,?,?,?,?,1,?,'captured','test','test')`,
  );
  for (const [selection, odds] of [["O", over], ["U", under]] as Array<[Side, number]>) {
    insert.run(matchId, provider, "OU", stage, lineKey, selection, odds, capturedAt);
  }
}

function addPath(
  id: string,
  provider: "hkjc" | "pinnacle",
  prices: Record<Stage, [number, number]>,
  now: number,
  lineKey = "2.5",
): void {
  addMatch(id, now + 30 * 60_000);
  addStage(id, provider, "initial", lineKey, ...prices.initial, now - 25 * 60_000);
  addStage(id, provider, "T30", lineKey, ...prices.T30, now - 20 * 60_000);
  addStage(id, provider, "T5", lineKey, ...prices.T5, now - 60_000);
}

describe("OU signal monitor", () => {
  it("locks active rules with exact drift boundaries and retires UUU reverse", () => {
    const now = Date.now();
    addPath("uoo", "pinnacle", {
      initial: [1.90, 1.80],
      T30: [1.78, 1.96],
      T5: [1.84, 2.00],
    }, now);
    addPath("ooo", "pinnacle", {
      initial: [1.95, 2.02],
      T30: [1.88, 2.00],
      T5: [1.83, 2.01],
    }, now);
    addPath("ouu-reverse", "pinnacle", {
      initial: [1.80, 1.95],
      T30: [1.96, 1.82],
      T5: [1.98, 1.83],
    }, now);
    addPath("ooo-reverse", "hkjc", {
      initial: [1.80, 1.92],
      T30: [1.82, 1.94],
      T5: [1.85, 1.96],
    }, now);
    addPath("uuu-reverse", "pinnacle", {
      initial: [1.95, 1.80],
      T30: [1.96, 1.82],
      T5: [1.98, 1.85],
    }, now);

    expect(syncOuSignalObservations()).toBe(4);
    expect(syncOuSignalObservations()).toBe(0);
    expect(
      (rawDb.prepare("SELECT COUNT(*) AS total FROM ou_signal_observations").get() as { total: number }).total,
    ).toBe(4);
    const dataset = ouSignalDataset(now);
    expect(dataset.observations).toHaveLength(2);
    expect(dataset.observations.map((row) => [row.ruleId, row.signalSelection])).toEqual(expect.arrayContaining([
      ["pinnacle-uoo-short-005-010", "O"],
      ["pinnacle-ooo-short-010-020", "O"],
    ]));
    expect(dataset.observations.map((row) => row.ruleId)).not.toContain(
      "pinnacle-uuu-flat-wide-reverse",
    );
    expect(dataset.observations.find((row) => row.matchId === "ouu-reverse")).toBeUndefined();
    expect(dataset.observations.find((row) => row.matchId === "ooo-reverse")).toBeUndefined();
  });

  it("excludes a row when any selected checkpoint price is not strictly above 1.70", () => {
    const now = Date.now();
    addPath("threshold-fail", "pinnacle", {
      initial: [1.90, 1.70],
      T30: [1.78, 1.96],
      T5: [1.84, 2.00],
    }, now);
    expect(syncOuSignalObservations(["threshold-fail"])).toBe(0);
  });

  it("keeps active T-30 candidates but suppresses disabled Telegram rules", () => {
    expect(syncOuSignalPrealerts()).toBe(4);
    expect(syncOuSignalPrealerts()).toBe(0);
    const rows = rawDb.prepare(
      "SELECT unique_key,match_id,rule_id,signal_t30_odds,detected_at FROM ou_signal_prealerts ORDER BY match_id",
    ).all() as Array<{
      unique_key: string;
      match_id: string;
      rule_id: string;
      signal_t30_odds: number;
      detected_at: number;
    }>;
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.match_id === "ouu-reverse")).toMatchObject({
      rule_id: "pinnacle-ouu-short-010-020-reverse",
      signal_t30_odds: 1.96,
    });

    const earliest = Math.min(...rows.map((row) => row.detected_at));
    rawDb.prepare(
      "UPDATE app_state SET value=?,updated_at=? WHERE key='ou_signal_prealert_activated_at'",
    ).run(String(earliest - 1), earliest - 1);
    const pending = unsentOuPrealerts();
    expect(pending).toHaveLength(2);
    expect(pending.map((row) => row.ruleId)).not.toContain("pinnacle-ouu-short-010-020-reverse");
    expect(pending.map((row) => row.ruleId)).not.toContain("hkjc-ooo-flat-wide-reverse");
    markOuPrealertNotified(pending[0].uniqueKey, Date.now());
    expect(unsentOuPrealerts()).toHaveLength(1);
  });

  it("does not back-notify observations before activation and marks new sends idempotently", () => {
    const rows = rawDb.prepare(
      "SELECT unique_key,detected_at FROM ou_signal_observations ORDER BY detected_at",
    ).all() as Array<{ unique_key: string; detected_at: number }>;
    const latestDetected = Math.max(...rows.map((row) => row.detected_at));
    rawDb.prepare(
      "UPDATE app_state SET value=?,updated_at=? WHERE key='ou_signal_monitor_activated_at'",
    ).run(String(latestDetected + 1), latestDetected + 1);
    expect(unsentOuSignals()).toHaveLength(0);

    rawDb.prepare(
      "UPDATE app_state SET value=?,updated_at=? WHERE key='ou_signal_monitor_activated_at'",
    ).run(String(latestDetected - 1), latestDetected - 1);
    const pending = unsentOuSignals();
    expect(pending).toHaveLength(2);
    expect(pending.map((row) => row.ruleId)).not.toContain("pinnacle-ouu-short-010-020-reverse");
    expect(pending.map((row) => row.ruleId)).not.toContain("hkjc-ooo-flat-wide-reverse");
    markOuSignalNotified(pending[0].uniqueKey, latestDetected + 2);
    expect(unsentOuSignals()).toHaveLength(1);
  });

  it("collects the two line watches without duplicating user-visible signals", () => {
    const now = Date.now();
    addPath("ooo-high-watch", "pinnacle", {
      initial: [1.95, 2.02],
      T30: [1.88, 2.00],
      T5: [1.83, 2.01],
    }, now, "3.0");
    addPath("uoo-mid-watch", "pinnacle", {
      initial: [1.90, 1.80],
      T30: [1.78, 1.96],
      T5: [1.84, 2.00],
    }, now, "2.75");

    expect(syncOuSignalObservations(["ooo-high-watch", "uoo-mid-watch"])).toBe(4);
    const stored = rawDb.prepare(
      "SELECT match_id,rule_id FROM ou_signal_observations WHERE match_id IN (?,?) ORDER BY match_id,rule_id",
    ).all("ooo-high-watch", "uoo-mid-watch") as Array<{ match_id: string; rule_id: string }>;
    expect(stored).toEqual(expect.arrayContaining([
      { match_id: "ooo-high-watch", rule_id: "pinnacle-ooo-short-010-020" },
      { match_id: "ooo-high-watch", rule_id: "pinnacle-ooo-line-gt-275-over-watch" },
      { match_id: "uoo-mid-watch", rule_id: "pinnacle-uoo-short-005-010" },
      { match_id: "uoo-mid-watch", rule_id: "pinnacle-uoo-line-250-275-over-watch" },
    ]));
    const visible = ouSignalDataset(now).observations
      .filter((row) => ["ooo-high-watch", "uoo-mid-watch"].includes(row.matchId));
    expect(visible).toHaveLength(2);
    expect(visible.map((row) => row.ruleId)).toEqual(expect.arrayContaining([
      "pinnacle-ooo-short-010-020",
      "pinnacle-uoo-short-005-010",
    ]));
  });

  it("keeps prospective results separate from the frozen historical edge", () => {
    rawDb.prepare(
      "INSERT INTO research_results(match_id,hkjc_id,home_score,away_score,source,fetched_at) VALUES(?,?,?,?,?,?)",
    ).run("uoo", "uoo", 2, 1, "test", Date.now());
    const dataset = ouSignalDataset();
    const uoo = dataset.observations.find((row) => row.matchId === "uoo");
    expect(uoo?.result).toMatchObject({ totalGoals: 3, outcome: "hit" });
    expect(dataset.summaries.find((row) => row.rule.id === "pinnacle-uoo-short-005-010")).toMatchObject({
      settled: 1,
      hits: 1,
      prospectiveHitRate: 1,
    });
    expect(dataset.rules.map((rule) => rule.id)).not.toContain("pinnacle-ouu-short-010-020-reverse");
    expect(dataset.rules.map((rule) => rule.id)).not.toContain("hkjc-ooo-flat-wide-reverse");
    expect(dataset.observations.map((row) => row.ruleId)).not.toContain(
      "pinnacle-ouu-short-010-020-reverse",
    );
    expect(dataset.observations.map((row) => row.ruleId)).not.toContain(
      "hkjc-ooo-flat-wide-reverse",
    );
  });
});
