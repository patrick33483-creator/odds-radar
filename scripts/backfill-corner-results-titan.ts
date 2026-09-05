#!/usr/bin/env node
/**
 * Recover past corner results from titan007 for fixtures that carry corner odds.
 *
 * HKJC cannot supply these: its historic result rows always report
 * ttlCornerResult = -1 and an ended fixture disappears from the pre-match feed,
 * which is why the earlier HKJC backfill returned 700 results and zero corner
 * counts. titan007's per-match statistics page stays readable after kickoff, and
 * matches.titan_id already links our fixtures to it.
 *
 * Modes:
 *   audit    (default) reports titan_id coverage and how many gaps are
 *            recoverable. Writes nothing.
 *   backfill fetches missing corner counts and stores them.
 *
 * Safety properties:
 * - Writes only to research_corner_results, never to research_results, so
 *   canSettleCornerMarket keeps requiring HKJC's own confirmed figure and no
 *   simulated bet can settle on a third-party count.
 * - Only fixtures already past kickoff are queried.
 * - INSERT OR IGNORE: an existing row is never overwritten.
 * - Sequential fetches with a delay, so a backfill does not hammer titan007.
 * - backfill requires an explicit confirmation phrase and the production path.
 */
import { fetchTitanCorners } from "../server/providers/titan-corners";
import { rawDb } from "../server/lib/store";

const REQUIRED_CONFIRMATION = "BACKFILL_CONFIRMED_TITAN_CORNERS_20260906";
const mode = (process.env.CORNER_TITAN_MODE ?? "audit").trim();
if (mode !== "audit" && mode !== "backfill") {
  throw new Error(`未知模式: ${mode}`);
}
if (mode === "backfill") {
  if (process.env.CORNER_TITAN_CONFIRMATION !== REQUIRED_CONFIRMATION) {
    throw new Error(`Refusing backfill without ${REQUIRED_CONFIRMATION}`);
  }
  if (process.env.RADAR_DB !== "/app/data/data.db") {
    throw new Error(`Refusing unexpected database path: ${process.env.RADAR_DB ?? "(unset)"}`);
  }
}

const LOOKBACK_DAYS = Number(process.env.CORNER_TITAN_DAYS ?? 90);
const LIMIT = Number(process.env.CORNER_TITAN_LIMIT ?? 0);
const DELAY_MS = Number(process.env.CORNER_TITAN_DELAY_MS ?? 400);
const now = Date.now();
const windowStart = now - LOOKBACK_DAYS * 24 * 3600_000;
const hktDate = (ms: number): string => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

interface Row {
  match_id: string;
  titan_id: string | null;
  kickoff_utc: number;
  league: string;
  already: number | null;
}

/**
 * Every past fixture that carries corner odds, with whatever corner result we
 * already recovered. `market='COU'` is the corner total market.
 */
const rows = rawDb.prepare(
  `SELECT m.id AS match_id, m.titan_id, m.kickoff_utc, m.league,
          c.corners_total AS already
     FROM matches m
     JOIN research_timeline_snapshots s ON s.match_id = m.id AND s.market = 'COU'
     LEFT JOIN research_corner_results c ON c.match_id = m.id
    WHERE m.kickoff_utc < ?
      AND m.kickoff_utc >= ?
    GROUP BY m.id
    ORDER BY m.kickoff_utc DESC`,
).all(now - 30 * 60_000, windowStart) as Row[];

const withTitan = rows.filter((r) => r.titan_id);
const pending = withTitan.filter((r) => r.already === null);
const targets = LIMIT > 0 ? pending.slice(0, LIMIT) : pending;

const summary = {
  mode,
  lookback_days: LOOKBACK_DAYS,
  fixtures_with_corner_odds: rows.length,
  with_titan_id: withTitan.length,
  without_titan_id: rows.length - withTitan.length,
  already_recovered: withTitan.length - pending.length,
  recoverable_pending: pending.length,
  attempted: 0,
  written: 0,
  no_statistic: 0,
  failed: 0,
};
const failures: Array<{ match_id: string; titan_id: string; error: string }> = [];
const samples: Array<{ date: string; league: string; corners: string }> = [];

const insert = rawDb.prepare(
  `INSERT OR IGNORE INTO research_corner_results
     (match_id,titan_id,home_corners,away_corners,corners_total,source,fetched_at)
   VALUES (?,?,?,?,?,'titan007',?)`,
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function run(): Promise<void> {
  if (mode === "audit") {
    // Probe a small sample so the audit proves the source still parses without
    // touching the database.
    for (const target of targets.slice(0, 5)) {
      summary.attempted += 1;
      try {
        const corners = await fetchTitanCorners(target.titan_id!);
        if (!corners) summary.no_statistic += 1;
        else {
          samples.push({
            date: hktDate(target.kickoff_utc),
            league: target.league,
            corners: `${corners.homeCorners}-${corners.awayCorners}`,
          });
        }
      } catch (err) {
        summary.failed += 1;
        failures.push({
          match_id: target.match_id,
          titan_id: target.titan_id!,
          error: (err as Error).message,
        });
      }
      await sleep(DELAY_MS);
    }
    console.log(JSON.stringify({ summary, samples, failures }, null, 2));
    return;
  }

  for (const target of targets) {
    summary.attempted += 1;
    try {
      const corners = await fetchTitanCorners(target.titan_id!);
      if (!corners) {
        summary.no_statistic += 1;
      } else {
        const res = insert.run(
          target.match_id,
          corners.titanId,
          corners.homeCorners,
          corners.awayCorners,
          corners.cornersTotal,
          Date.now(),
        );
        if (res.changes > 0) summary.written += 1;
        if (samples.length < 10) {
          samples.push({
            date: hktDate(target.kickoff_utc),
            league: target.league,
            corners: `${corners.homeCorners}-${corners.awayCorners}`,
          });
        }
      }
    } catch (err) {
      summary.failed += 1;
      if (failures.length < 20) {
        failures.push({
          match_id: target.match_id,
          titan_id: target.titan_id!,
          error: (err as Error).message,
        });
      }
    }
    await sleep(DELAY_MS);
  }

  const coverage = rawDb.prepare(
    "SELECT COUNT(*) AS n, AVG(corners_total) AS avg_total FROM research_corner_results",
  ).get() as { n: number; avg_total: number | null };

  console.log(JSON.stringify({ summary, coverage, samples, failures }, null, 2));
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
