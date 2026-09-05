#!/usr/bin/env node
/**
 * One-time historical recompute after the HKJC opening main-line inference
 * changed to trust the source's own flagged main at a later checkpoint.
 *
 * Fixtures whose opening snapshot carried no main flag were previously
 * discarded, so their observations were never recorded. This replays the
 * stored snapshots for already-kicked-off fixtures and records the rows that
 * the fixed evaluator produces.
 *
 * Safety properties:
 * - Only fixtures whose kickoff is already in the past are replayed, so live
 *   alerting for upcoming fixtures is left entirely to the normal sync.
 * - Every newly inserted row is written with backfilled_at set inside the same
 *   INSERT, which permanently excludes it from the Telegram pending queue
 *   (unsentOuSignals filters `backfilled_at IS NULL`).
 * - Existing rows are untouched: the sync uses INSERT OR IGNORE, so anything
 *   already notified keeps its notified_at and stays a genuine live send.
 */
import { syncOuSignalObservations } from "../server/lib/ou-signals";
import { rawDb } from "../server/lib/store";

const REQUIRED_CONFIRMATION = "RECOMPUTE_CONFIRMED_OU_MAINLINE_20260906";
if (process.env.OU_RECOMPUTE_CONFIRMATION !== REQUIRED_CONFIRMATION) {
  throw new Error(`Refusing recompute without ${REQUIRED_CONFIRMATION}`);
}
if (process.env.RADAR_DB !== "/app/data/data.db") {
  throw new Error(`Refusing unexpected database path: ${process.env.RADAR_DB ?? "(unset)"}`);
}

const now = Date.now();
const windowStart = now - 120 * 24 * 60 * 60_000;
const CHUNK = 200;

const countsSql = `
  SELECT COUNT(*) rows,
         SUM(CASE WHEN notified_at IS NOT NULL THEN 1 ELSE 0 END) notified,
         SUM(CASE WHEN backfilled_at IS NOT NULL THEN 1 ELSE 0 END) backfilled,
         SUM(CASE WHEN notified_at IS NULL AND backfilled_at IS NULL THEN 1 ELSE 0 END) pending
    FROM ou_signal_observations`;
type Counts = { rows: number; notified: number; backfilled: number; pending: number };
const before = rawDb.prepare(countsSql).get() as Counts;

const matchIds = (rawDb.prepare(
  `SELECT DISTINCT s.match_id
     FROM research_timeline_snapshots s
     JOIN matches m ON m.id=s.match_id
    WHERE s.market='OU'
      AND s.stage IN ('initial','T30','T5')
      AND m.fixture_source IN ('hkjc','pinnacle')
      AND m.kickoff_utc>=?
      AND m.kickoff_utc<?
    ORDER BY s.match_id`,
).all(windowStart, now) as Array<{ match_id: string }>).map((row) => row.match_id);

console.log(JSON.stringify({
  event: "ou_recompute_start",
  windowStart,
  now,
  fixtures: matchIds.length,
  before,
}));

let inserted = 0;
for (let index = 0; index < matchIds.length; index += CHUNK) {
  const chunk = matchIds.slice(index, index + CHUNK);
  inserted += syncOuSignalObservations(chunk, { backfilledAt: now });
}

const after = rawDb.prepare(countsSql).get() as Counts;
if (after.pending !== before.pending) {
  throw new Error(
    `Recompute changed the Telegram pending queue: ${before.pending} -> ${after.pending}`,
  );
}
if (after.notified !== before.notified) {
  throw new Error(`Recompute altered notified rows: ${before.notified} -> ${after.notified}`);
}

const byRule = rawDb.prepare(
  `SELECT rule_id, COUNT(*) rows
     FROM ou_signal_observations
    WHERE backfilled_at=?
    GROUP BY rule_id
    ORDER BY rows DESC`,
).all(now) as Array<{ rule_id: string; rows: number }>;

console.log(JSON.stringify({
  event: "ou_recompute_done",
  inserted,
  after,
  recoveredByRule: byRule,
}));
