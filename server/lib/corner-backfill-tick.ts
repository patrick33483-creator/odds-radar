/**
 * In-process corner-result backfill tick.
 *
 * Runs the same logic as scripts/backfill-corner-results-titan.ts but
 * bounded per invocation so it can be scheduled from
 * runResearchLowerCycleOnce without stalling the tick. Writes only to
 * research_corner_results (isolated from research_results); corner
 * settlement continues to require HKJC's own confirmed figure.
 *
 * Configuration (env):
 *   RADAR_CORNER_BACKFILL         "0" to disable entirely (default: enabled)
 *   RADAR_CORNER_BACKFILL_LIMIT   fixtures processed per tick (default: 30)
 *   RADAR_CORNER_BACKFILL_DELAY_MS  spacing between fetches (default: 400)
 *   RADAR_CORNER_BACKFILL_ENDED_MIN  minutes after kickoff before we treat
 *                                    corner count as final (default: 150)
 */

import { rawDb } from "./store";
import { fetchTitanCorners, resolveTitanIdByNameDate } from "../providers/titan-corners";

interface Row {
  match_id: string;
  titan_id: string | null;
  home_team: string;
  away_team: string;
  kickoff_utc: number;
}

export interface CornerBackfillOutcome {
  disabled?: true;
  scanned: number;
  attempted: number;
  written: number;
  no_statistic: number;
  namedate_resolved: number;
  namedate_unresolved: number;
  failed: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Backfill up to `limit` pending fixtures. Sequential, with a small
 * inter-request delay so titan007 is never hammered. Returns a summary
 * safe to log at info level.
 */
export async function runCornerBackfillTick(): Promise<CornerBackfillOutcome> {
  if (process.env.RADAR_CORNER_BACKFILL === "0") {
    return {
      disabled: true,
      scanned: 0,
      attempted: 0,
      written: 0,
      no_statistic: 0,
      namedate_resolved: 0,
      namedate_unresolved: 0,
      failed: 0,
    };
  }
  const LIMIT = Math.max(
    1,
    Number(process.env.RADAR_CORNER_BACKFILL_LIMIT ?? 30),
  );
  const DELAY_MS = Math.max(
    50,
    Number(process.env.RADAR_CORNER_BACKFILL_DELAY_MS ?? 400),
  );
  const ENDED_MIN = Math.max(
    30,
    Number(process.env.RADAR_CORNER_BACKFILL_ENDED_MIN ?? 150),
  );
  const endedBefore = Date.now() - ENDED_MIN * 60_000;

  const rows = rawDb.prepare(
    `SELECT m.id AS match_id, m.titan_id, m.home_team, m.away_team, m.kickoff_utc
       FROM matches m
       JOIN research_timeline_snapshots s
         ON s.match_id = m.id AND s.market = 'COU'
       LEFT JOIN research_corner_results c ON c.match_id = m.id
      WHERE m.kickoff_utc < ?
        AND c.match_id IS NULL
      GROUP BY m.id
      ORDER BY m.kickoff_utc DESC
      LIMIT ?`,
  ).all(endedBefore, LIMIT) as Row[];

  const insert = rawDb.prepare(
    `INSERT OR IGNORE INTO research_corner_results
       (match_id,titan_id,home_corners,away_corners,corners_total,source,fetched_at)
     VALUES (?,?,?,?,?,?,?)`,
  );

  const summary: CornerBackfillOutcome = {
    scanned: rows.length,
    attempted: 0,
    written: 0,
    no_statistic: 0,
    namedate_resolved: 0,
    namedate_unresolved: 0,
    failed: 0,
  };

  for (const row of rows) {
    summary.attempted += 1;
    try {
      let titanId: string | null = row.titan_id;
      let source = "titan007";
      if (!titanId) {
        const resolved = await resolveTitanIdByNameDate({
          homeTeam: row.home_team,
          awayTeam: row.away_team,
          kickoffUtc: row.kickoff_utc,
        });
        if (!resolved) {
          summary.namedate_unresolved += 1;
          await sleep(DELAY_MS);
          continue;
        }
        summary.namedate_resolved += 1;
        titanId = resolved.titanId;
        source = "titan007-namedate";
      }
      const corners = await fetchTitanCorners(titanId!);
      if (!corners) {
        summary.no_statistic += 1;
      } else {
        const res = insert.run(
          row.match_id,
          corners.titanId,
          corners.homeCorners,
          corners.awayCorners,
          corners.cornersTotal,
          source,
          Date.now(),
        );
        if (res.changes > 0) summary.written += 1;
      }
    } catch {
      summary.failed += 1;
    }
    await sleep(DELAY_MS);
  }

  return summary;
}
