/**
 * Read-only export of per-fixture checkpoint features for OU and AH.
 *
 * Condition mining needs to try many feature cuts, and redeploying for each
 * one is not viable. This exports one row per (match, provider, market) with
 * each checkpoint's main line and both sides' prices plus the settled score,
 * so the search itself can run offline against a small CSV.
 *
 * Writes nothing. Opens the database read-only.
 */

import Database from "better-sqlite3";
import { gzipSync } from "node:zlib";

type Stage = "initial" | "T30" | "T15" | "T5";
type Market = "OU" | "AH";
const STAGES: Stage[] = ["initial", "T30", "T15", "T5"];

interface Row {
  match_id: string;
  provider: string;
  market: Market;
  stage: Stage;
  line_key: string;
  selection: string;
  decimal_odds: number;
  is_main: number;
}

interface StageMain {
  lineKey: string;
  a: number; // O for OU, H for AH
  b: number; // U for OU, A for AH
}

const dbPath = process.env.RADAR_DB ?? "/app/data/data.db";
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const sides = (market: Market): [string, string] => (market === "OU" ? ["O", "U"] : ["H", "A"]);

/**
 * One auditable complete main pair per checkpoint. Provider main flags win;
 * a sole complete line is unambiguous; an unflagged HKJC opening may borrow
 * the flag from the other checkpoints when they agree. Anything ambiguous
 * fails closed, matching the live evaluator.
 */
function selectStageMain(
  rows: Row[],
  market: Market,
  provider: string,
  stage: Stage,
  hint: string | null,
): StageMain | null {
  const [sa, sb] = sides(market);
  const byLine = new Map<string, Map<string, number>>();
  const flagged = new Set<string>();
  for (const row of rows) {
    const prices = byLine.get(row.line_key) ?? new Map<string, number>();
    prices.set(row.selection, row.decimal_odds);
    byLine.set(row.line_key, prices);
    if (row.is_main === 1) flagged.add(row.line_key);
  }
  const complete = [...byLine.entries()].filter(([, p]) => p.has(sa) && p.has(sb));
  const build = (lineKey: string): StageMain | null => {
    const prices = byLine.get(lineKey);
    if (!prices?.has(sa) || !prices.has(sb)) return null;
    return { lineKey, a: prices.get(sa)!, b: prices.get(sb)! };
  };
  if (flagged.size) return flagged.size === 1 ? build([...flagged][0]) : null;
  if (complete.length === 1) return build(complete[0][0]);
  if (provider === "hkjc" && stage === "initial" && hint) return build(hint);
  return null;
}

function flaggedHint(rows: Row[], market: Market, exclude: Stage): string | null {
  const [sa, sb] = sides(market);
  const keys = new Set<string>();
  const byStageLine = new Map<string, Map<string, { flags: number; sides: Set<string> }>>();
  for (const row of rows) {
    if (row.stage === exclude) continue;
    const perStage = byStageLine.get(row.stage) ?? new Map();
    const cell = perStage.get(row.line_key) ?? { flags: 0, sides: new Set<string>() };
    if (row.is_main === 1) cell.flags += 1;
    cell.sides.add(row.selection);
    perStage.set(row.line_key, cell);
    byStageLine.set(row.stage, perStage);
  }
  for (const perStage of byStageLine.values()) {
    for (const [lineKey, cell] of perStage) {
      if (cell.flags >= 2 && cell.sides.has(sa) && cell.sides.has(sb)) keys.add(lineKey);
    }
  }
  return keys.size === 1 ? [...keys][0] : null;
}

const snapshots = db.prepare(
  `SELECT s.match_id,s.provider,s.market,s.stage,s.line_key,s.selection,s.decimal_odds,s.is_main
     FROM research_timeline_snapshots s
     JOIN matches m ON m.id=s.match_id
     JOIN research_results r ON r.match_id=s.match_id
    WHERE s.market IN ('OU','AH')
      AND s.provider IN ('hkjc','pinnacle')
      AND s.stage IN ('initial','T30','T15','T5')
      AND r.home_score IS NOT NULL AND r.away_score IS NOT NULL
      AND m.kickoff_utc < ?
    ORDER BY s.match_id,s.provider,s.market,s.stage`,
).all(Date.now()) as Row[];

const meta = new Map(
  (db.prepare(
    `SELECT m.id,m.league,m.kickoff_utc,r.home_score,r.away_score
       FROM matches m JOIN research_results r ON r.match_id=m.id
      WHERE r.home_score IS NOT NULL AND r.away_score IS NOT NULL`,
  ).all() as Array<{
    id: string;
    league: string;
    kickoff_utc: number;
    home_score: number;
    away_score: number;
  }>).map((m) => [m.id, m]),
);

const groups = new Map<string, Row[]>();
for (const row of snapshots) {
  const key = `${row.match_id}|${row.provider}|${row.market}`;
  const list = groups.get(key) ?? [];
  list.push(row);
  groups.set(key, list);
}

const header = [
  "match_id", "provider", "market", "league", "kickoff_utc", "home_score", "away_score",
  ...STAGES.flatMap((s) => [`${s}_line`, `${s}_a`, `${s}_b`]),
].join(",");
const lines: string[] = [header];
let emitted = 0;
let skippedAmbiguous = 0;

for (const [key, rows] of groups) {
  const [matchId, provider, market] = key.split("|") as [string, string, Market];
  const info = meta.get(matchId);
  if (!info) continue;
  const hint = flaggedHint(rows, market, "initial");
  const cells: string[] = [];
  let usable = 0;
  for (const stage of STAGES) {
    const stageRows = rows.filter((row) => row.stage === stage);
    const main = stageRows.length
      ? selectStageMain(stageRows, market, provider, stage, hint)
      : null;
    if (main) {
      usable += 1;
      cells.push(main.lineKey, String(main.a), String(main.b));
    } else {
      cells.push("", "", "");
    }
  }
  // initial, T30 and T5 are what every current rule needs.
  if (usable < 3) {
    skippedAmbiguous += 1;
    continue;
  }
  lines.push([
    matchId,
    provider,
    market,
    JSON.stringify(info.league ?? "").replace(/,/g, " "),
    String(info.kickoff_utc),
    String(info.home_score),
    String(info.away_score),
    ...cells,
  ].join(","));
  emitted += 1;
}

const csv = lines.join("\n");
const packed = gzipSync(Buffer.from(csv, "utf-8")).toString("base64");
console.log(JSON.stringify({
  event: "feature_export",
  groups: groups.size,
  emitted,
  skippedAmbiguous,
  csvBytes: csv.length,
  packedBytes: packed.length,
}));
console.log("BEGIN_FEATURES_B64");
// Chunked so the log stays line-oriented and copy-safe.
for (let i = 0; i < packed.length; i += 4000) console.log(packed.slice(i, i + 4000));
console.log("END_FEATURES_B64");
db.close();
