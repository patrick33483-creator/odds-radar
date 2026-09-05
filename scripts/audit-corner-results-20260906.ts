/**
 * Read-only audit of corner-result coverage.
 *
 * COU can only settle from HKJC's confirmed ttlCornerResult, so a corner
 * dataset is only as usable as that field's coverage. This reports how many
 * fixtures carry corner odds, how many of those have a corner result, and
 * which of the gaps are actually recoverable (past kickoff, HKJC id known).
 *
 * Writes nothing. Opens the database read-only.
 */

import Database from "better-sqlite3";

const dbPath = process.env.RADAR_DB ?? "/app/data/data.db";
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const now = Date.now();

const hktDate = (ms: number): string =>
  new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

interface Row {
  match_id: string;
  hkjc_id: string | null;
  fixture_source: string;
  kickoff_utc: number;
  league: string;
  stages: number;
  cou_rows: number;
  has_result: number;
  corners: number | null;
}

const rows = db.prepare(
  `SELECT m.id AS match_id, m.hkjc_id, m.fixture_source, m.kickoff_utc, m.league,
          COUNT(DISTINCT s.stage) AS stages,
          COUNT(s.id) AS cou_rows,
          CASE WHEN r.match_id IS NULL THEN 0 ELSE 1 END AS has_result,
          r.corners_total AS corners
     FROM matches m
     JOIN research_timeline_snapshots s
       ON s.match_id = m.id AND s.market = 'COU'
     LEFT JOIN research_results r ON r.match_id = m.id
    WHERE m.kickoff_utc < ?
    GROUP BY m.id`,
).all(now) as Row[];

const bucket = {
  fixtures_with_corner_odds: rows.length,
  with_corner_result: 0,
  missing_corner_result: 0,
  missing_no_result_at_all: 0,
  missing_result_but_no_corners: 0,
  missing_and_no_hkjc_id: 0,
  missing_recoverable: 0,
};
const byDate = new Map<string, { total: number; withCorners: number; recoverable: number }>();
const byLeague = new Map<string, { total: number; withCorners: number }>();
const bySource = new Map<string, { total: number; withCorners: number }>();
const recoverableSample: Array<{ match_id: string; hkjc_id: string; date: string; league: string }> = [];

for (const row of rows) {
  const date = hktDate(row.kickoff_utc);
  const d = byDate.get(date) ?? { total: 0, withCorners: 0, recoverable: 0 };
  const l = byLeague.get(row.league) ?? { total: 0, withCorners: 0 };
  const s = bySource.get(row.fixture_source) ?? { total: 0, withCorners: 0 };
  d.total += 1; l.total += 1; s.total += 1;

  if (row.corners !== null && row.corners >= 0) {
    bucket.with_corner_result += 1;
    d.withCorners += 1; l.withCorners += 1; s.withCorners += 1;
  } else {
    bucket.missing_corner_result += 1;
    if (!row.has_result) bucket.missing_no_result_at_all += 1;
    else bucket.missing_result_but_no_corners += 1;
    if (!row.hkjc_id) {
      bucket.missing_and_no_hkjc_id += 1;
    } else {
      bucket.missing_recoverable += 1;
      d.recoverable += 1;
      if (recoverableSample.length < 20) {
        recoverableSample.push({ match_id: row.match_id, hkjc_id: row.hkjc_id, date, league: row.league });
      }
    }
  }
  byDate.set(date, d); byLeague.set(row.league, l); bySource.set(row.fixture_source, s);
}

// How much of the corner data would actually be analysable if results existed:
// the same three-checkpoint completeness the OU/AH mining requires.
const analysable = db.prepare(
  `SELECT COUNT(*) AS n FROM (
     SELECT s.match_id, s.provider
       FROM research_timeline_snapshots s
       JOIN matches m ON m.id = s.match_id
      WHERE s.market='COU' AND m.kickoff_utc < ?
        AND s.stage IN ('initial','T30','T5')
      GROUP BY s.match_id, s.provider
     HAVING COUNT(DISTINCT s.stage) = 3)`,
).get(now) as { n: number };

console.log(JSON.stringify({
  event: "corner_result_audit",
  generated_at: new Date().toISOString(),
  ...bucket,
  coverage_rate: rows.length ? Number((bucket.with_corner_result / rows.length).toFixed(4)) : 0,
  three_checkpoint_provider_series: analysable.n,
  by_fixture_source: Object.fromEntries(bySource),
  by_date: Object.fromEntries([...byDate.entries()].sort()),
  top_leagues_missing: [...byLeague.entries()]
    .map(([league, v]) => ({ league, ...v, missing: v.total - v.withCorners }))
    .sort((a, b) => b.missing - a.missing)
    .slice(0, 20),
  recoverable_sample: recoverableSample,
}, null, 2));

db.close();
