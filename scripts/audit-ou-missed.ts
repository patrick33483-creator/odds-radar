#!/usr/bin/env tsx
/**
 * Replay the OU signal engine against a read-only SQLite snapshot and list any
 * activated Watch signals or T-30 candidates that were never sent. This runs
 * exclusively against the snapshot passed in via RADAR_DB — never against the
 * live production database — and never sends a Telegram message.
 */
import path from "node:path";

if (!process.env.RADAR_DB) {
  console.error("RADAR_DB is required and must point at a snapshot copy");
  process.exit(2);
}
const absolute = path.resolve(process.env.RADAR_DB);
if (!/audit-ou[-/]/.test(absolute)) {
  console.error(`refusing to replay against ${absolute} (expected an audit snapshot path)`);
  process.exit(2);
}
process.env.RADAR_DB = absolute;

// Import lazily so the side-effect that opens the SQLite handle uses the audit path above.
const { syncOuSignalPrealerts, syncOuSignalObservations, OU_HIDDEN_RULE_IDS } = await import(
  "../server/lib/ou-signals.ts"
);
const { rawDb, migrate } = await import("../server/lib/store.ts");
migrate();

const beforePrealerts = new Set(
  (rawDb.prepare("SELECT unique_key FROM ou_signal_prealerts").all() as Array<{ unique_key: string }>)
    .map((row) => row.unique_key),
);
const beforeObservations = new Set(
  (rawDb.prepare("SELECT unique_key FROM ou_signal_observations").all() as Array<{ unique_key: string }>)
    .map((row) => row.unique_key),
);

const recomputed = {
  prealerts: syncOuSignalPrealerts(),
  observations: syncOuSignalObservations(),
};
console.log(JSON.stringify({ recomputed }, null, 2));

const ACTIVATED_AT = 1_788_350_822_000; // 2026-09-02 12:07:02 UTC
const lookbackDays = Math.max(1, Math.min(120, Number(process.env.LOOKBACK_DAYS ?? "30") || 30));
const nowMs = Date.now();
const since = Math.max(ACTIVATED_AT, nowMs - lookbackDays * 86_400_000);
console.log(JSON.stringify({ window: { since_ms: since, now_ms: nowMs, lookback_days: lookbackDays } }, null, 2));

const unsentT30 = rawDb
  .prepare(
    `SELECT p.unique_key, p.match_id, p.rule_id, p.direction_path,
            p.line_key, p.initial_line_key, p.t30_line_key, p.line_path,
            p.signal_selection, p.initial_signal_odds,
            p.signal_t30_odds, p.detected_at, p.notified_at,
            m.league, m.home_team, m.away_team, m.kickoff_utc, m.status
       FROM ou_signal_prealerts p
       JOIN matches m ON m.id = p.match_id
      WHERE m.fixture_source IN ('hkjc','pinnacle')
        AND p.notified_at IS NULL
        AND p.detected_at >= ?
        AND m.kickoff_utc <= ?
      ORDER BY m.kickoff_utc ASC`,
  )
  .all(since, nowMs) as Array<{
    unique_key: string;
    rule_id: string;
    kickoff_utc: number;
    [k: string]: unknown;
  }>;

const unsentT5 = rawDb
  .prepare(
    `SELECT o.match_id, o.rule_id, o.direction_path, o.drift_bucket,
            o.line_key, o.signal_selection, o.initial_signal_odds,
            o.signal_t5_odds, o.odds_gap, o.detected_at, o.notified_at,
            m.league, m.home_team, m.away_team, m.kickoff_utc, m.status
       FROM ou_signal_observations o
       JOIN matches m ON m.id = o.match_id
      WHERE m.fixture_source IN ('hkjc','pinnacle')
        AND o.notified_at IS NULL
        AND o.detected_at >= ?
        AND m.kickoff_utc <= ?
      ORDER BY m.kickoff_utc ASC`,
  )
  .all(since, nowMs) as Array<{
    unique_key: string;
    rule_id: string;
    kickoff_utc: number;
    [k: string]: unknown;
  }>;

const visibleT30 = unsentT30.filter((r) => !OU_HIDDEN_RULE_IDS.has(r.rule_id));
const visibleT5 = unsentT5.filter((r) => !OU_HIDDEN_RULE_IDS.has(r.rule_id));
const missedNewT30 = visibleT30.filter((r) => !beforePrealerts.has(r.unique_key));
const missedExistingT30 = visibleT30.filter((r) => beforePrealerts.has(r.unique_key));
const missedNewT5 = visibleT5.filter((r) => !beforeObservations.has(r.unique_key));
const missedExistingT5 = visibleT5.filter((r) => beforeObservations.has(r.unique_key));

function emit(title: string, rows: Array<Record<string, unknown>>): void {
  console.log(`\n=== ${title} ===`);
  for (const row of rows) console.log(JSON.stringify(row));
}

emit("T-30 engine-record misses (new on replay)", missedNewT30);
emit("T-30 delivery misses (existed but notified_at null)", missedExistingT30);
emit("T-5 engine-record misses (new on replay)", missedNewT5);
emit("T-5 delivery misses (existed but notified_at null)", missedExistingT5);

console.log(
  "\n=== summary ===\n" +
    JSON.stringify(
      {
        activated_since_ms: since,
        prealerts_total: rawDb.prepare("SELECT COUNT(*) c FROM ou_signal_prealerts WHERE detected_at >= ?").get(since),
        prealerts_unsent: rawDb
          .prepare("SELECT COUNT(*) c FROM ou_signal_prealerts WHERE detected_at >= ? AND notified_at IS NULL")
          .get(since),
        prealerts_unsent_visible: visibleT30.length,
        prealerts_new_on_replay: missedNewT30.length,
        prealerts_existing_unsent: missedExistingT30.length,
        observations_total: rawDb
          .prepare("SELECT COUNT(*) c FROM ou_signal_observations WHERE detected_at >= ?")
          .get(since),
        observations_unsent: rawDb
          .prepare("SELECT COUNT(*) c FROM ou_signal_observations WHERE detected_at >= ? AND notified_at IS NULL")
          .get(since),
        observations_unsent_visible: visibleT5.length,
        observations_new_on_replay: missedNewT5.length,
        observations_existing_unsent: missedExistingT5.length,
      },
      null,
      2,
    ),
);
