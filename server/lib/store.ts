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
  id TEXT PRIMARY KEY, hkjc_id TEXT NOT NULL, crown_match_id TEXT,
  league TEXT NOT NULL, league_en TEXT, home_team TEXT NOT NULL, away_team TEXT NOT NULL,
  home_team_en TEXT, away_team_en TEXT, kickoff_utc INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PREEVENT', inplay INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS matches_kickoff_idx ON matches(kickoff_utc);
CREATE INDEX IF NOT EXISTS matches_crown_idx ON matches(crown_match_id);

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
  match_id TEXT PRIMARY KEY, crown_match_id TEXT, confidence REAL NOT NULL DEFAULT 0,
  method TEXT NOT NULL, kickoff_delta_sec INTEGER, unmatched_reason TEXT,
  updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS match_mapping_crown_idx ON match_mapping(crown_match_id);

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
  final_score TEXT, notes TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS simulation_bets_uniq ON simulation_bets(unique_key);
CREATE INDEX IF NOT EXISTS simulation_bets_cat_idx ON simulation_bets(category, placed_at);

CREATE TABLE IF NOT EXISTS simulation_legs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bet_id INTEGER NOT NULL, provider TEXT NOT NULL,
  market TEXT NOT NULL, line_key TEXT NOT NULL, selection TEXT NOT NULL,
  decimal_odds REAL NOT NULL, stake REAL NOT NULL, synthetic INTEGER NOT NULL DEFAULT 0,
  synthetic_detail TEXT, leg_status TEXT, leg_return REAL);
CREATE INDEX IF NOT EXISTS simulation_legs_bet_idx ON simulation_legs(bet_id);

CREATE TABLE IF NOT EXISTS results (
  match_id TEXT PRIMARY KEY, crown_match_id TEXT, home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL, half_home INTEGER, half_away INTEGER,
  source TEXT NOT NULL, fetched_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY, ok INTEGER NOT NULL DEFAULT 0, last_success_at INTEGER,
  last_attempt_at INTEGER, last_error_at INTEGER, last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0, last_latency_ms INTEGER,
  item_count INTEGER NOT NULL DEFAULT 0, mode TEXT NOT NULL DEFAULT 'live');

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
`);
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
  const res = db
    .delete(oddsSnapshots)
    .where(lt(oddsSnapshots.fetchedAt, now - SNAPSHOT_RETENTION_MS))
    .run();
  return res.changes;
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
