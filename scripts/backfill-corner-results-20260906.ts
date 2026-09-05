#!/usr/bin/env node
/**
 * Backfill HKJC confirmed total corners for fixtures that already carry corner
 * odds but no corner result.
 *
 * The live settlement path only asks HKJC for results it needs to settle a
 * simulated bet, so research fixtures that were never bet on keep
 * corners_total NULL even though HKJC published the figure. This replays the
 * historic-results query one HKT match date at a time and fills the gaps.
 *
 * Safety properties:
 * - Only fixtures whose kickoff is already in the past are queried.
 * - corners_total is only written where it is currently NULL; a stored value is
 *   never overwritten, so nothing already settled can change.
 * - Scores are never overwritten either; a missing research_results row is
 *   inserted only from HKJC's own confirmed row.
 * - Requires an explicit confirmation phrase and the production database path.
 */
import { HkjcProvider, hkjcHktDate } from "../server/providers/hkjc";
import { rawDb } from "../server/lib/store";

const REQUIRED_CONFIRMATION = "BACKFILL_CONFIRMED_CORNERS_20260906";
if (process.env.CORNER_BACKFILL_CONFIRMATION !== REQUIRED_CONFIRMATION) {
  throw new Error(`Refusing backfill without ${REQUIRED_CONFIRMATION}`);
}
if (process.env.RADAR_DB !== "/app/data/data.db") {
  throw new Error(`Refusing unexpected database path: ${process.env.RADAR_DB ?? "(unset)"}`);
}

const LOOKBACK_DAYS = Number(process.env.CORNER_BACKFILL_DAYS ?? 90);
const now = Date.now();
const windowStart = now - LOOKBACK_DAYS * 24 * 3600_000;

interface Target {
  match_id: string;
  hkjc_id: string;
  kickoff_utc: number;
  has_result: number;
}

const targets = rawDb.prepare(
  `SELECT m.id AS match_id, m.hkjc_id, m.kickoff_utc,
          CASE WHEN r.match_id IS NULL THEN 0 ELSE 1 END AS has_result
     FROM matches m
     JOIN research_timeline_snapshots s ON s.match_id = m.id AND s.market = 'COU'
     LEFT JOIN research_results r ON r.match_id = m.id
    WHERE m.hkjc_id IS NOT NULL
      AND m.kickoff_utc < ?
      AND m.kickoff_utc >= ?
      AND (r.match_id IS NULL OR r.corners_total IS NULL)
    GROUP BY m.id
    ORDER BY m.kickoff_utc`,
).all(now - 30 * 60_000, windowStart) as Target[];

const byDate = new Map<string, Target[]>();
for (const target of targets) {
  const date = hkjcHktDate(target.kickoff_utc);
  if (!date) continue;
  const list = byDate.get(date) ?? [];
  list.push(target);
  byDate.set(date, list);
}

const hkjc = new HkjcProvider();
const updateCorners = rawDb.prepare(
  `UPDATE research_results SET corners_total = ?, fetched_at = ?
    WHERE match_id = ? AND corners_total IS NULL`,
);
const insertResult = rawDb.prepare(
  `INSERT OR IGNORE INTO research_results
     (match_id, hkjc_id, home_score, away_score, corners_total, source, result_source, source_match_id, fetched_at)
   VALUES (?,?,?,?,?,?,?,?,?)`,
);
const updateSettlementCorners = rawDb.prepare(
  `UPDATE results SET corners_total = ?
    WHERE match_id = ? AND corners_total IS NULL`,
);

let queriedDates = 0;
let fetched = 0;
let filled = 0;
let insertedRows = 0;
let stillMissing = 0;
const perDate: Array<{ date: string; asked: number; returned: number; withCorners: number; filled: number }> = [];

const main = async (): Promise<void> => {
  for (const [date, list] of [...byDate.entries()].sort()) {
    queriedDates += 1;
    let results: Awaited<ReturnType<HkjcProvider["fetchHistoricResults"]>> = [];
    try {
      results = await hkjc.fetchHistoricResults(
        list.map((t) => ({ matchId: t.hkjc_id, kickoffUtc: t.kickoff_utc })),
      );
    } catch (err) {
      console.log(JSON.stringify({ event: "corner_backfill_date_error", date, error: (err as Error).message }));
      continue;
    }
    fetched += results.length;
    const byHkjcId = new Map(results.map((r) => [r.matchId, r]));
    let dayFilled = 0;
    let withCorners = 0;
    for (const target of list) {
      const result = byHkjcId.get(target.hkjc_id);
      if (!result) { stillMissing += 1; continue; }
      if (result.cornersTotal === null) { stillMissing += 1; continue; }
      withCorners += 1;
      if (target.has_result) {
        const info = updateCorners.run(result.cornersTotal, Date.now(), target.match_id);
        if (info.changes) { filled += 1; dayFilled += 1; }
      } else {
        const info = insertResult.run(
          target.match_id, target.hkjc_id, result.homeScore, result.awayScore,
          result.cornersTotal, result.source, "hkjc", target.hkjc_id, Date.now(),
        );
        if (info.changes) { insertedRows += 1; filled += 1; dayFilled += 1; }
      }
      updateSettlementCorners.run(result.cornersTotal, target.match_id);
    }
    perDate.push({ date, asked: list.length, returned: results.length, withCorners, filled: dayFilled });
    // Keep well clear of HKJC's rate limits: this is a catch-up job, not a
    // latency-sensitive one.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  console.log(JSON.stringify({
    event: "corner_backfill_done",
    lookback_days: LOOKBACK_DAYS,
    targets: targets.length,
    dates: queriedDates,
    hkjc_rows_returned: fetched,
    corner_values_written: filled,
    result_rows_inserted: insertedRows,
    still_missing: stillMissing,
    per_date: perDate,
  }, null, 2));
};

void main();
