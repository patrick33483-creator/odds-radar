/**
 * Read-only listing of past fixtures that carry corner odds but still have
 * no research_corner_results row. Used to review what the name+date
 * fallback couldn't resolve so we can extend team_aliases.
 *
 * Output: CSV to stdout with match_id, kickoff_utc (ISO), league, home, away,
 * titan_id_present. Writes nothing to the database.
 */
import { rawDb } from "../server/lib/store.js";

interface Row {
  match_id: string;
  titan_id: string | null;
  home_team: string;
  away_team: string;
  kickoff_utc: number;
  league: string | null;
}

const nowSec = Math.floor(Date.now() / 1000);
// Match backfill script: only fixtures ended > 150 minutes ago count as past.
const endedBefore = nowSec - 150 * 60;

const sql = `
  SELECT m.id AS match_id, m.titan_id, m.home_team, m.away_team,
         m.kickoff_utc, m.league
    FROM matches m
    JOIN research_timeline_snapshots s ON s.match_id = m.id AND s.market = 'COU'
    LEFT JOIN research_corner_results c ON c.match_id = m.id
   WHERE m.kickoff_utc < ?
     AND c.match_id IS NULL
   GROUP BY m.id
   ORDER BY m.kickoff_utc DESC
`;
const rows = rawDb.prepare(sql).all(endedBefore) as Row[];

// CSV header + rows, RFC 4180 quoting.
function q(v: string | null | undefined): string {
  const s = v ?? "";
  return `"${s.replace(/"/g, '""')}"`;
}
process.stdout.write(
  "match_id,kickoff_utc_iso,league,home_team,away_team,titan_id_present\n",
);
for (const r of rows) {
  const iso = new Date(r.kickoff_utc * 1000).toISOString();
  process.stdout.write(
    [
      q(r.match_id),
      q(iso),
      q(r.league),
      q(r.home_team),
      q(r.away_team),
      r.titan_id ? "yes" : "no",
    ].join(",") + "\n",
  );
}
process.stderr.write(`# total: ${rows.length}\n`);
