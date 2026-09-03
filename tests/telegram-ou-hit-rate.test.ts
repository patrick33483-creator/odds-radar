import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import type { OuSignalObservation, OuSignalPrealert } from "@shared/types";

const dbPath = `/tmp/odds-radar-ou-hit-rate-${process.pid}.db`;
process.env.RADAR_DB = dbPath;

// Dynamic imports so RADAR_DB is applied before store initialises.
let buildOuSignalMessage: typeof import("../server/lib/telegram").buildOuSignalMessage;
let buildOuPrealertMessage: typeof import("../server/lib/telegram").buildOuPrealertMessage;
let formatOuHitRateLine: typeof import("../server/lib/telegram").formatOuHitRateLine;
let computeOuRuleHitRate: typeof import("../server/lib/ou-signals").computeOuRuleHitRate;
let rawDb: typeof import("../server/lib/store").rawDb;

// A real rule id used in RULE_BY_ID / OU_SIGNAL_RULES: reverse Under signal.
const RULE_ID = "hkjc-ooo-flat-wide-reverse";
const LINE_KEY = "2.5";

beforeAll(async () => {
  const store = await import("../server/lib/store");
  const tg = await import("../server/lib/telegram");
  const ou = await import("../server/lib/ou-signals");
  buildOuSignalMessage = tg.buildOuSignalMessage;
  buildOuPrealertMessage = tg.buildOuPrealertMessage;
  formatOuHitRateLine = tg.formatOuHitRateLine;
  computeOuRuleHitRate = ou.computeOuRuleHitRate;
  rawDb = store.rawDb;
  store.migrate();
});

afterAll(() => {
  rawDb.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { rmSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
  }
});

function insertMatch(id: string, kickoffUtc: number, fixtureSource: "hkjc" | "pinnacle" = "hkjc"): void {
  rawDb.prepare(
    `INSERT OR REPLACE INTO matches(id,hkjc_id,fixture_source,titan_id,league,home_team,away_team,kickoff_utc,status,inplay,updated_at)
     VALUES(?,?,?,?,?,?,?,?,'unplayed',0,?)`,
  ).run(id, id, fixtureSource, null, "測試聯賽", "主隊", "客隊", kickoffUtc, Date.now());
}

function insertObservation(matchId: string, seq: number): void {
  rawDb.prepare(
    `INSERT OR REPLACE INTO ou_signal_observations(
       unique_key,match_id,provider,rule_id,line_key,direction_path,drift_bucket,
       original_selection,signal_selection,initial_signal_odds,t5_signal_odds,
       signal_t5_odds,odds_gap,detected_at,notified_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
  ).run(
    `${RULE_ID}:${matchId}:${seq}`,
    matchId,
    "hkjc",
    RULE_ID,
    LINE_KEY,
    "O→O→O",
    "持平或拉闊",
    "O",
    "U", // reverse -> Under
    1.9,
    1.8,
    2.05,
    -0.1,
    Date.now(),
  );
}

function insertResult(matchId: string, home: number, away: number): void {
  rawDb.prepare(
    `INSERT OR REPLACE INTO research_results(match_id,home_score,away_score,corners_total,source,result_source,source_match_id,fetched_at)
     VALUES(?,?,?,NULL,'test','test',NULL,?)`,
  ).run(matchId, home, away, Date.now());
}

/**
 * Seed N past matches for RULE_ID at line 2.5 with a specified number of Under
 * hits. The reverse-Under rule "hits" when total goals < 2.5.
 */
function seedHistory(count: number, hits: number): void {
  const base = Date.UTC(2025, 0, 1);
  for (let i = 0; i < count; i += 1) {
    const matchId = `hkjc:hist${i}`;
    insertMatch(matchId, base + i * 86_400_000);
    insertObservation(matchId, i);
    // hit == Under (total < 2.5). Non-hit == Over (total > 2.5). No pushes at .5 lines.
    if (i < hits) insertResult(matchId, 0, 1); // total 1 → Under → hit
    else insertResult(matchId, 2, 2); // total 4 → Over → miss
  }
}

function clearHistory(): void {
  rawDb.exec("DELETE FROM ou_signal_observations");
  rawDb.exec("DELETE FROM research_results");
  rawDb.exec("DELETE FROM matches");
}

function observation(): OuSignalObservation {
  return {
    uniqueKey: `${RULE_ID}:live`,
    matchId: "hkjc:live",
    league: "測試聯賽",
    homeTeam: "主隊",
    awayTeam: "客隊",
    kickoffUtc: Date.now() + 3_600_000,
    matchStatus: "upcoming",
    provider: "hkjc",
    providerLabel: "馬會",
    ruleId: RULE_ID,
    lineKey: LINE_KEY,
    directionPath: "O→O→O",
    driftBucket: "持平或拉闊",
    originalSelection: "O",
    signalSelection: "U",
    mode: "reverse",
    referenceInitialOdds: 1.9,
    referenceT5Odds: 1.8,
    signalT5Odds: 2.05,
    oddsGap: -0.1,
    detectedAt: Date.now(),
    notifiedAt: null,
    result: null,
  };
}

function prealert(): OuSignalPrealert {
  return {
    uniqueKey: `${RULE_ID}:live:prealert`,
    matchId: "hkjc:live",
    league: "測試聯賽",
    homeTeam: "主隊",
    awayTeam: "客隊",
    kickoffUtc: Date.now() + 1_800_000,
    provider: "hkjc",
    providerLabel: "馬會",
    ruleId: RULE_ID,
    lineKey: LINE_KEY,
    directionPath: "O→O→O",
    signalSelection: "U",
    mode: "reverse",
    initialSelectedOdds: 1.9,
    t30SelectedOdds: 1.8,
    signalT30Odds: 2.05,
    detectedAt: Date.now(),
    notifiedAt: null,
  };
}

describe("formatOuHitRateLine", () => {
  it("renders X.X% and sample size when >= 20 decided", () => {
    expect(formatOuHitRateLine({ hits: 15, sample: 30, hitRate: 0.5 })).toBe("命中率：50.0%（30 場歷史）");
  });

  it("renders 樣本不足 when sample below 20", () => {
    expect(formatOuHitRateLine({ hits: 3, sample: 5, hitRate: 0.6 })).toBe("命中率：樣本不足（5 場）");
  });

  it("renders 計算中 on null (compute failure)", () => {
    expect(formatOuHitRateLine(null)).toBe("命中率：計算中");
  });
});

describe("OU Telegram hit rate", () => {
  it("shows percentage when sample >= 20 and matches computeOuRuleHitRate", () => {
    clearHistory();
    seedHistory(25, 15); // 15 hits / 25 decided → 60.0%
    const rate = computeOuRuleHitRate(RULE_ID, LINE_KEY);
    expect(rate).toEqual({ hits: 15, sample: 25, hitRate: 0.6 });
    const msg = buildOuSignalMessage([observation()]);
    expect(msg).toContain("命中率：60.0%（25 場歷史）");
    expect(buildOuPrealertMessage(prealert())).toContain("命中率：60.0%（25 場歷史）");
  });

  it("shows 樣本不足 when fewer than 20 decided", () => {
    clearHistory();
    seedHistory(10, 3);
    const msg = buildOuSignalMessage([observation()]);
    expect(msg).toContain("命中率：樣本不足（10 場）");
    expect(buildOuPrealertMessage(prealert())).toContain("命中率：樣本不足（10 場）");
  });

  it("returns 樣本不足（0 場） when no history exists at all", () => {
    clearHistory();
    // No rows in matches / observations / results -> sample = 0.
    const rate = computeOuRuleHitRate(RULE_ID, LINE_KEY);
    expect(rate).toEqual({ hits: 0, sample: 0, hitRate: null });
    const msg = buildOuSignalMessage([observation()]);
    expect(msg).toContain("命中率：樣本不足（0 場）");
  });

  it("still emits a hit-rate line for Pinnacle-only observations", () => {
    clearHistory();
    // Insert a Pinnacle fixture in history + observation + result so the join
    // finds it exactly like it would in production.
    const matchId = "pinnacle:XYZ";
    insertMatch(matchId, Date.UTC(2025, 5, 1), "pinnacle");
    insertObservation(matchId, 0);
    insertResult(matchId, 0, 1); // Under hit
    const rate = computeOuRuleHitRate(RULE_ID, LINE_KEY);
    expect(rate.sample).toBe(1);
    const msg = buildOuSignalMessage([observation()]);
    expect(msg).toContain("命中率：樣本不足（1 場）");
  });
});
