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
 * - Only fixtures whose kickoff is at least ENDED_AFTER_MIN minutes in the past
 *   are queried. A 30-minute guard is enough for a final score but not for
 *   corners: titan reports the running count, so a match still in play would
 *   store a partial total that later looks like a finished result.
 * - INSERT OR IGNORE: an existing row is never overwritten.
 * - Sequential fetches with a delay, so a backfill does not hammer titan007.
 * - backfill requires an explicit confirmation phrase and the production path.
 */
import { fetchTitanCorners, resolveTitanIdByNameDate } from "../server/providers/titan-corners";
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

// 0 = no lower bound (backfill every past fixture with corner odds). Kept as an
// env override in case an operator wants to bound a one-off pass.
const LOOKBACK_DAYS = Number(process.env.CORNER_TITAN_DAYS ?? 0);
const LIMIT = Number(process.env.CORNER_TITAN_LIMIT ?? 0);
const DELAY_MS = Number(process.env.CORNER_TITAN_DELAY_MS ?? 400);
const now = Date.now();
const windowStart = now - LOOKBACK_DAYS * 24 * 3600_000;
/**
 * Minutes after kickoff before a fixture's corner count is treated as final.
 * 90 minutes of play, plus half-time, stoppage and a margin for a late start.
 */
const ENDED_AFTER_MIN = Number(process.env.CORNER_TITAN_ENDED_AFTER_MIN ?? 150);
const endedBefore = now - ENDED_AFTER_MIN * 60_000;
const hktDate = (ms: number): string => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

interface Row {
  match_id: string;
  titan_id: string | null;
  home_team: string;
  away_team: string;
  kickoff_utc: number;
  league: string;
  already: number | null;
}

/**
 * Every past fixture that carries corner odds, with whatever corner result we
 * already recovered. `market='COU'` is the corner total market.
 *
 * `LOOKBACK_DAYS = 0` disables the lower bound so a first-time run recovers
 * the full corner history, not just the last 90 days.
 */
const rowsSql =
  `SELECT m.id AS match_id, m.titan_id, m.home_team, m.away_team, m.kickoff_utc, m.league,
          c.corners_total AS already
     FROM matches m
     JOIN research_timeline_snapshots s ON s.match_id = m.id AND s.market = 'COU'
     LEFT JOIN research_corner_results c ON c.match_id = m.id
    WHERE m.kickoff_utc < ?` +
  (LOOKBACK_DAYS > 0 ? ` AND m.kickoff_utc >= ?` : ``) +
  `
    GROUP BY m.id
    ORDER BY m.kickoff_utc DESC`;
const rows = (LOOKBACK_DAYS > 0
  ? rawDb.prepare(rowsSql).all(endedBefore, windowStart)
  : rawDb.prepare(rowsSql).all(endedBefore)) as Row[];

const pending = rows.filter((r) => r.already === null);
const withTitan = pending.filter((r) => r.titan_id);
const withoutTitan = pending.filter((r) => !r.titan_id);
const targets = LIMIT > 0 ? pending.slice(0, LIMIT) : pending;

const summary = {
  mode,
  lookback_days: LOOKBACK_DAYS,
  ended_after_min: ENDED_AFTER_MIN,
  fixtures_with_corner_odds: rows.length,
  already_recovered: rows.length - pending.length,
  recoverable_pending: pending.length,
  recoverable_via_titan_id: withTitan.length,
  recoverable_via_name_date: withoutTitan.length,
  attempted: 0,
  written: 0,
  no_statistic: 0,
  namedate_resolved: 0,
  namedate_unresolved: 0,
  failed: 0,
};
const failures: Array<{ match_id: string; titan_id: string; error: string }> = [];
const samples: Array<{ date: string; league: string; corners: string }> = [];

const insert = rawDb.prepare(
  `INSERT OR IGNORE INTO research_corner_results
     (match_id,titan_id,home_corners,away_corners,corners_total,source,fetched_at)
   VALUES (?,?,?,?,?,?,?)`,
);

/** Resolve a Titan sId for a row. Returns the stored titan_id when set, or
 *  looks it up by team name + kickoff. Null when neither route works. */
async function resolveTitanId(row: Row): Promise<{ id: string; source: string } | null> {
  if (row.titan_id) return { id: row.titan_id, source: "titan007" };
  const resolved = await resolveTitanIdByNameDate({
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    kickoffUtc: row.kickoff_utc,
  });
  if (!resolved) {
    summary.namedate_unresolved += 1;
    return null;
  }
  summary.namedate_resolved += 1;
  return { id: resolved.titanId, source: "titan007-namedate" };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function run(): Promise<void> {
  if (mode === "audit") {
    // Probe a small sample so the audit proves each recovery path still
    // parses, without touching the database.
    const probe = [...withTitan.slice(0, 3), ...withoutTitan.slice(0, 2)];
    for (const target of probe) {
      summary.attempted += 1;
      try {
        const id = await resolveTitanId(target);
        if (!id) continue;
        const corners = await fetchTitanCorners(id.id);
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
          titan_id: target.titan_id ?? "(namedate)",
          error: (err as Error).message,
        });
      }
      await sleep(DELAY_MS);
    }
    console.log(JSON.stringify({ summary, samples, failures }, null, 2));
    return;
  }

  let progressAt = Date.now();
  for (const [i, target] of targets.entries()) {
    summary.attempted += 1;
    // Emit a progress line every 60 s so a long backfill is observable in logs.
    if (Date.now() - progressAt > 60_000) {
      console.log(JSON.stringify({ event: "progress", i, total: targets.length, ...summary }));
      progressAt = Date.now();
    }
    try {
      const id = await resolveTitanId(target);
      if (!id) continue;
      const corners = await fetchTitanCorners(id.id);
      if (!corners) {
        summary.no_statistic += 1;
      } else {
        const res = insert.run(
          target.match_id,
          corners.titanId,
          corners.homeCorners,
          corners.awayCorners,
          corners.cornersTotal,
          id.source,
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
          titan_id: target.titan_id ?? "(namedate)",
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
