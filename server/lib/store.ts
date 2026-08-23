import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  appState,
  marketLines,
  matchMapping,
  matches,
  oddsLatest,
  oddsSnapshots,
  opportunities,
  pinnapiLiveScores,
  providerHealth,
  results,
  simulationBets,
  simulationLegs,
  teamAliases,
} from "@shared/schema";

const sqlite = new Database(process.env.RADAR_DB ?? "data.db");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("busy_timeout = 5000");

export const rawDb = sqlite;
export const db = drizzle(sqlite);

/** Snapshots older than this are pruned on each refresh. */
export const SNAPSHOT_RETENTION_MS = 120 * 24 * 60 * 60 * 1000;

/** Create tables + indexes if missing (keeps deploys self-contained). */
export function migrate(): void {
  sqlite.exec(`
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY, hkjc_id TEXT NOT NULL, pinnacle_match_id TEXT,
  league TEXT NOT NULL, league_en TEXT, home_team TEXT NOT NULL, away_team TEXT NOT NULL,
  home_team_en TEXT, away_team_en TEXT, kickoff_utc INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PREEVENT', inplay INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS matches_kickoff_idx ON matches(kickoff_utc);
CREATE INDEX IF NOT EXISTS matches_pinnacle_idx ON matches(pinnacle_match_id);

CREATE TABLE IF NOT EXISTS market_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL, market TEXT NOT NULL,
  line_key TEXT NOT NULL, line_value REAL, is_main INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS market_lines_uniq ON market_lines(match_id, market, line_key);

CREATE TABLE IF NOT EXISTS odds_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL, provider TEXT NOT NULL,
  market TEXT NOT NULL, line_key TEXT NOT NULL, selection TEXT NOT NULL,
  decimal_odds REAL NOT NULL, source_updated_at INTEGER, fetched_at INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'prematch');
CREATE INDEX IF NOT EXISTS odds_lookup_idx ON odds_snapshots(match_id, provider, market, line_key, selection);
CREATE INDEX IF NOT EXISTS odds_time_idx ON odds_snapshots(fetched_at);

CREATE TABLE IF NOT EXISTS odds_latest (
  key TEXT PRIMARY KEY, match_id TEXT NOT NULL, provider TEXT NOT NULL, market TEXT NOT NULL,
  line_key TEXT NOT NULL, selection TEXT NOT NULL, decimal_odds REAL NOT NULL,
  prev_decimal_odds REAL, source_updated_at INTEGER, fetched_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS odds_latest_match_idx ON odds_latest(match_id);

CREATE TABLE IF NOT EXISTS team_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, canonical TEXT NOT NULL, alias TEXT NOT NULL,
  provider TEXT NOT NULL, confirmed_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS team_aliases_uniq ON team_aliases(provider, alias);
CREATE INDEX IF NOT EXISTS team_aliases_canonical_idx ON team_aliases(canonical);

CREATE TABLE IF NOT EXISTS match_mapping (
  match_id TEXT PRIMARY KEY, pinnacle_match_id TEXT, confidence REAL NOT NULL DEFAULT 0,
  method TEXT NOT NULL, kickoff_delta_sec INTEGER, unmatched_reason TEXT,
  updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS match_mapping_pinnacle_idx ON match_mapping(pinnacle_match_id);

CREATE TABLE IF NOT EXISTS pinnacle_source_map (
  match_id TEXT PRIMARY KEY, pinnapi_id TEXT, pinnapi_reversed INTEGER NOT NULL DEFAULT 0,
  optic_id TEXT, optic_reversed INTEGER NOT NULL DEFAULT 0,
  titan_id TEXT, titan_reversed INTEGER NOT NULL DEFAULT 0,
  active_source TEXT, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS pinnacle_source_map_optic_idx ON pinnacle_source_map(optic_id);
CREATE INDEX IF NOT EXISTS pinnacle_source_map_titan_idx ON pinnacle_source_map(titan_id);

CREATE TABLE IF NOT EXISTS opportunities (
  key TEXT PRIMARY KEY, category TEXT NOT NULL, match_id TEXT NOT NULL, market TEXT NOT NULL,
  line_key TEXT NOT NULL, selection TEXT NOT NULL, payload TEXT NOT NULL, metric REAL NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, notified INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS opportunities_cat_idx ON opportunities(category, last_seen);

CREATE TABLE IF NOT EXISTS simulation_bets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, unique_key TEXT NOT NULL, category TEXT NOT NULL,
  match_id TEXT NOT NULL, market TEXT NOT NULL, line_key TEXT NOT NULL, selection TEXT NOT NULL,
  match_label TEXT NOT NULL, league TEXT NOT NULL, kickoff_utc INTEGER NOT NULL,
  total_stake REAL NOT NULL, expected_payout REAL NOT NULL, expected_profit REAL NOT NULL,
  roi REAL NOT NULL, ev_pct REAL, q_total REAL, placed_at INTEGER NOT NULL,
  settled_at INTEGER, result_status TEXT, realized_return REAL, realized_pnl REAL,
  final_score TEXT, settlement_source TEXT, notes TEXT,
  excluded_from_stats INTEGER NOT NULL DEFAULT 0, exclusion_reason TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS simulation_bets_uniq ON simulation_bets(unique_key);
CREATE INDEX IF NOT EXISTS simulation_bets_cat_idx ON simulation_bets(category, placed_at);

CREATE TABLE IF NOT EXISTS simulation_legs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bet_id INTEGER NOT NULL, provider TEXT NOT NULL,
  market TEXT NOT NULL, line_key TEXT NOT NULL, selection TEXT NOT NULL,
  decimal_odds REAL NOT NULL, stake REAL NOT NULL, synthetic INTEGER NOT NULL DEFAULT 0,
  synthetic_detail TEXT, leg_status TEXT, leg_return REAL);
CREATE INDEX IF NOT EXISTS simulation_legs_bet_idx ON simulation_legs(bet_id);

CREATE TABLE IF NOT EXISTS results (
  match_id TEXT PRIMARY KEY, pinnacle_match_id TEXT, home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL, corners_total INTEGER, half_home INTEGER, half_away INTEGER,
  source TEXT NOT NULL, fetched_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS research_results (
  match_id TEXT PRIMARY KEY, hkjc_id TEXT NOT NULL, home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL, corners_total INTEGER,
  source TEXT NOT NULL, fetched_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS research_results_fetched_idx ON research_results(fetched_at);

CREATE TABLE IF NOT EXISTS research_timeline_points (
  match_id TEXT NOT NULL, stage TEXT NOT NULL, target_at INTEGER,
  captured_at INTEGER, status TEXT NOT NULL DEFAULT 'pending', note TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(match_id,stage));
CREATE INDEX IF NOT EXISTS research_timeline_due_idx
  ON research_timeline_points(status,target_at);

CREATE TABLE IF NOT EXISTS research_timeline_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL,
  provider TEXT NOT NULL, market TEXT NOT NULL, stage TEXT NOT NULL,
  line_key TEXT NOT NULL, selection TEXT NOT NULL, decimal_odds REAL NOT NULL,
  is_main INTEGER NOT NULL DEFAULT 0, source_updated_at INTEGER,
  captured_at INTEGER NOT NULL, target_at INTEGER, status TEXT NOT NULL DEFAULT 'captured');
CREATE UNIQUE INDEX IF NOT EXISTS research_timeline_uniq
  ON research_timeline_snapshots(match_id,provider,market,stage,line_key,selection);
CREATE INDEX IF NOT EXISTS research_timeline_match_idx
  ON research_timeline_snapshots(match_id,stage,provider,market);
CREATE INDEX IF NOT EXISTS research_timeline_captured_idx
  ON research_timeline_snapshots(captured_at);

CREATE TABLE IF NOT EXISTS pinnapi_live_scores (
  event_id TEXT PRIMARY KEY, match_id TEXT NOT NULL, home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL, match_minutes INTEGER, match_state TEXT,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  seen_live INTEGER NOT NULL DEFAULT 1, no_longer_live INTEGER NOT NULL DEFAULT 0,
  ended_candidate_at INTEGER);
CREATE INDEX IF NOT EXISTS pinnapi_live_scores_match_idx ON pinnapi_live_scores(match_id);
CREATE INDEX IF NOT EXISTS pinnapi_live_scores_open_idx ON pinnapi_live_scores(seen_live, no_longer_live);

CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY, ok INTEGER NOT NULL DEFAULT 0, last_success_at INTEGER,
  last_attempt_at INTEGER, last_error_at INTEGER, last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0, last_latency_ms INTEGER,
  item_count INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'live');

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
`);
  // Existing installations predate PinnAPI. SQLite's CREATE TABLE IF NOT EXISTS
  // does not evolve the table, so add only the two additive mapping columns.
  const sourceColumns = sqlite
    .prepare("PRAGMA table_info(pinnacle_source_map)")
    .all() as Array<{ name: string }>;
  const sourceNames = new Set(sourceColumns.map((column) => column.name));
  if (!sourceNames.has("pinnapi_id")) sqlite.exec("ALTER TABLE pinnacle_source_map ADD COLUMN pinnapi_id TEXT");
  if (!sourceNames.has("pinnapi_reversed")) {
    sqlite.exec("ALTER TABLE pinnacle_source_map ADD COLUMN pinnapi_reversed INTEGER NOT NULL DEFAULT 0");
  }
  const simulationBetColumns = sqlite
    .prepare("PRAGMA table_info(simulation_bets)")
    .all() as Array<{ name: string }>;
  if (!simulationBetColumns.some((column) => column.name === "settlement_source")) {
    sqlite.exec("ALTER TABLE simulation_bets ADD COLUMN settlement_source TEXT");
  }
  if (!simulationBetColumns.some((column) => column.name === "excluded_from_stats")) {
    sqlite.exec("ALTER TABLE simulation_bets ADD COLUMN excluded_from_stats INTEGER NOT NULL DEFAULT 0");
  }
  if (!simulationBetColumns.some((column) => column.name === "exclusion_reason")) {
    sqlite.exec("ALTER TABLE simulation_bets ADD COLUMN exclusion_reason TEXT");
  }
  const resultColumns = sqlite.prepare("PRAGMA table_info(results)").all() as Array<{ name: string }>;
  if (!resultColumns.some((column) => column.name === "corners_total")) {
    sqlite.exec("ALTER TABLE results ADD COLUMN corners_total INTEGER");
  }
  // Preserve historical direct 1X2 rows for audit while removing them from
  // the active 30-bet validation cohort. An AH/OU target implemented through
  // an economically equivalent HKJC 1X2 combination remains eligible.
  sqlite.exec(`
    UPDATE simulation_bets
       SET excluded_from_stats=0, exclusion_reason=NULL
     WHERE exclusion_reason='SYNTHETIC_EV_DISABLED'
       AND market IN ('AH','OU');
    UPDATE simulation_bets
       SET excluded_from_stats=1, exclusion_reason='1X2_OBSERVATION_ONLY'
     WHERE category='case2_ev' AND market='1X2';
    CREATE INDEX IF NOT EXISTS simulation_bets_active_idx
      ON simulation_bets(excluded_from_stats, category, placed_at);
  `);
  sqlite.exec("CREATE INDEX IF NOT EXISTS pinnacle_source_map_pinnapi_idx ON pinnacle_source_map(pinnapi_id)");
}

migrate();

export function getState(key: string): string | null {
  const row = db.select().from(appState).where(eq(appState.key, key)).get();
  return row?.value ?? null;
}

export function setState(key: string, value: string): void {
  const now = Date.now();
  rawDb
    .prepare(
      "INSERT INTO app_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    )
    .run(key, value, now);
}

export function pruneSnapshots(now = Date.now()): number {
  const cutoff = now - SNAPSHOT_RETENTION_MS;
  const res = db
    .delete(oddsSnapshots)
    .where(lt(oddsSnapshots.fetchedAt, cutoff))
    .run();
  const timeline = rawDb
    .prepare("DELETE FROM research_timeline_snapshots WHERE captured_at<?")
    .run(cutoff);
  rawDb
    .prepare("DELETE FROM research_timeline_points WHERE match_id NOT IN (SELECT DISTINCT match_id FROM research_timeline_snapshots)")
    .run();
  return res.changes + timeline.changes;
}

export function countSnapshots(): number {
  const r = rawDb.prepare("SELECT COUNT(*) AS n FROM odds_snapshots").get() as { n: number };
  return r?.n ?? 0;
}

export {
  appState,
  marketLines,
  matchMapping,
  matches,
  oddsLatest,
  oddsSnapshots,
  opportunities,
  pinnapiLiveScores,
  providerHealth,
  results,
  simulationBets,
  simulationLegs,
  teamAliases,
  and,
  desc,
  eq,
  inArray,
  lt,
  sql,
};
