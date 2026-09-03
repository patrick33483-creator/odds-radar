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
  id TEXT PRIMARY KEY, hkjc_id TEXT, fixture_source TEXT NOT NULL DEFAULT 'hkjc'
    CHECK(fixture_source IN ('hkjc','crown')), titan_id TEXT, pinnacle_match_id TEXT,
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
  match_id TEXT PRIMARY KEY, hkjc_id TEXT, home_score INTEGER NOT NULL,
  away_score INTEGER NOT NULL, corners_total INTEGER,
  source TEXT NOT NULL, result_source TEXT NOT NULL DEFAULT 'hkjc',
  source_match_id TEXT, fetched_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS research_results_fetched_idx ON research_results(fetched_at);

CREATE TABLE IF NOT EXISTS research_timeline_points (
  match_id TEXT NOT NULL, stage TEXT NOT NULL, target_at INTEGER,
  first_captured_at INTEGER, last_retry_at INTEGER, captured_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', note TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(match_id,stage));
CREATE INDEX IF NOT EXISTS research_timeline_due_idx
  ON research_timeline_points(status,target_at);

CREATE TABLE IF NOT EXISTS research_timeline_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT NOT NULL,
  provider TEXT NOT NULL, market TEXT NOT NULL, stage TEXT NOT NULL,
  line_key TEXT NOT NULL, selection TEXT NOT NULL, decimal_odds REAL NOT NULL,
  is_main INTEGER NOT NULL DEFAULT 0, source_updated_at INTEGER,
  captured_at INTEGER NOT NULL, target_at INTEGER, status TEXT NOT NULL DEFAULT 'captured',
  origin TEXT NOT NULL DEFAULT 'live_observation', source_name TEXT,
  source_match_id TEXT, source_url TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS research_timeline_uniq
  ON research_timeline_snapshots(match_id,provider,market,stage,line_key,selection);
CREATE INDEX IF NOT EXISTS research_timeline_match_idx
  ON research_timeline_snapshots(match_id,stage,provider,market);
CREATE INDEX IF NOT EXISTS research_timeline_captured_idx
  ON research_timeline_snapshots(captured_at);

CREATE TABLE IF NOT EXISTS crown_research_attempts (
  titan_id TEXT PRIMARY KEY, last_attempt_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS crown_research_attempts_due_idx
  ON crown_research_attempts(last_attempt_at);

CREATE TABLE IF NOT EXISTS ou_signal_observations (
  unique_key TEXT PRIMARY KEY, match_id TEXT NOT NULL, provider TEXT NOT NULL,
  rule_id TEXT NOT NULL, line_key TEXT NOT NULL, direction_path TEXT NOT NULL,
  drift_bucket TEXT NOT NULL, original_selection TEXT NOT NULL,
  signal_selection TEXT NOT NULL, initial_signal_odds REAL NOT NULL,
  t5_signal_odds REAL NOT NULL, signal_t5_odds REAL NOT NULL, odds_gap REAL NOT NULL,
  detected_at INTEGER NOT NULL, notified_at INTEGER);
CREATE INDEX IF NOT EXISTS ou_signal_match_idx
  ON ou_signal_observations(match_id,detected_at);
CREATE INDEX IF NOT EXISTS ou_signal_rule_idx
  ON ou_signal_observations(rule_id,detected_at);

CREATE TABLE IF NOT EXISTS ou_signal_prealerts (
  unique_key TEXT PRIMARY KEY, match_id TEXT NOT NULL, provider TEXT NOT NULL,
  rule_id TEXT NOT NULL, line_key TEXT NOT NULL, direction_path TEXT NOT NULL,
  initial_selected_odds REAL NOT NULL, t30_selected_odds REAL NOT NULL,
  signal_t30_odds REAL NOT NULL, detected_at INTEGER NOT NULL, notified_at INTEGER);
CREATE INDEX IF NOT EXISTS ou_signal_prealert_match_idx
  ON ou_signal_prealerts(match_id,detected_at);
CREATE INDEX IF NOT EXISTS ou_signal_prealert_rule_idx
  ON ou_signal_prealerts(rule_id,detected_at);

CREATE TABLE IF NOT EXISTS quote_direction_watch_observations (
  unique_key TEXT PRIMARY KEY, rule_id TEXT NOT NULL, match_id TEXT NOT NULL,
  league TEXT NOT NULL, market TEXT NOT NULL CHECK(market IN ('AH','OU')),
  line_key TEXT NOT NULL, selection TEXT NOT NULL CHECK(selection IN ('H','A','O','U')),
  decision_stage TEXT NOT NULL CHECK(decision_stage='T30'),
  decision_odds REAL NOT NULL, reference_odds REAL, odds_gap REAL,
  percentile_low REAL, percentile_high REAL, baseline_count INTEGER,
  baseline_version TEXT, status TEXT NOT NULL, detected_at INTEGER NOT NULL,
  t5_checked_at INTEGER, t5_provider TEXT, t5_odds REAL, t5_change REAL,
  t5_confirmation TEXT, result_status TEXT, realized_return REAL,
  realized_pnl REAL, final_score TEXT, settled_at INTEGER,
  settlement_source TEXT, notified_at INTEGER CHECK(notified_at IS NULL)
);
CREATE INDEX IF NOT EXISTS quote_direction_watch_match_idx
  ON quote_direction_watch_observations(match_id,detected_at);
CREATE INDEX IF NOT EXISTS quote_direction_watch_rule_idx
  ON quote_direction_watch_observations(rule_id,status,detected_at);

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
  migrateCrownResearchFixtures();
  // The activation watermark prevents a new deployment from sending Telegram
  // alerts for historical rows that are backfilled into the signal page.
  const activatedAt = Date.now();
  sqlite
    .prepare("INSERT OR IGNORE INTO app_state(key,value,updated_at) VALUES('ou_signal_monitor_activated_at',?,?)")
    .run(String(activatedAt), activatedAt);
  sqlite
    .prepare("INSERT OR IGNORE INTO app_state(key,value,updated_at) VALUES('ou_signal_prealert_activated_at',?,?)")
    .run(String(activatedAt), activatedAt);
  sqlite
    .prepare("INSERT OR IGNORE INTO app_state(key,value,updated_at) VALUES('quote_direction_watch_activated_at',?,?)")
    .run(String(activatedAt), activatedAt);
  const ouSignalColumns = sqlite
    .prepare("PRAGMA table_info(ou_signal_observations)")
    .all() as Array<{ name: string }>;
  if (!ouSignalColumns.some((column) => column.name === "signal_t5_odds")) {
    sqlite.exec("ALTER TABLE ou_signal_observations ADD COLUMN signal_t5_odds REAL");
    sqlite.exec("UPDATE ou_signal_observations SET signal_t5_odds=t5_signal_odds WHERE signal_t5_odds IS NULL");
  }
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
  // Genuine opening prices carry their source trail.  These checks are
  // intentionally additive: SQLite does not support ADD COLUMN IF NOT EXISTS.
  const timelineColumns = sqlite
    .prepare("PRAGMA table_info(research_timeline_snapshots)")
    .all() as Array<{ name: string }>;
  const timelineNames = new Set(timelineColumns.map((column) => column.name));
  if (!timelineNames.has("origin")) {
    sqlite.exec("ALTER TABLE research_timeline_snapshots ADD COLUMN origin TEXT");
  }
  if (!timelineNames.has("source_name")) {
    sqlite.exec("ALTER TABLE research_timeline_snapshots ADD COLUMN source_name TEXT");
  }
  if (!timelineNames.has("source_match_id")) {
    sqlite.exec("ALTER TABLE research_timeline_snapshots ADD COLUMN source_match_id TEXT");
  }
  if (!timelineNames.has("source_url")) {
    sqlite.exec("ALTER TABLE research_timeline_snapshots ADD COLUMN source_url TEXT");
  }
  const timelinePointColumns = sqlite
    .prepare("PRAGMA table_info(research_timeline_points)")
    .all() as Array<{ name: string }>;
  const timelinePointNames = new Set(timelinePointColumns.map((column) => column.name));
  if (!timelinePointNames.has("first_captured_at")) {
    sqlite.exec("ALTER TABLE research_timeline_points ADD COLUMN first_captured_at INTEGER");
  }
  if (!timelinePointNames.has("last_retry_at")) {
    sqlite.exec("ALTER TABLE research_timeline_points ADD COLUMN last_retry_at INTEGER");
  }
  // Recover the immutable first capture from quote rows rather than the legacy
  // point timestamp, which older partial retries could overwrite.  updated_at
  // is the best available historical retry timestamp when it is later.
  sqlite.exec(`
    UPDATE research_timeline_points
       SET first_captured_at=COALESCE(
         first_captured_at,
         (
           SELECT MIN(s.captured_at)
             FROM research_timeline_snapshots s
            WHERE s.match_id=research_timeline_points.match_id
              AND s.stage=research_timeline_points.stage
         ),
         captured_at
       )
     WHERE first_captured_at IS NULL;
    UPDATE research_timeline_points
       SET last_retry_at=updated_at
     WHERE last_retry_at IS NULL
       AND first_captured_at IS NOT NULL
       AND updated_at>first_captured_at;
    UPDATE research_timeline_points
       SET captured_at=first_captured_at
     WHERE first_captured_at IS NOT NULL
       AND (captured_at IS NULL OR captured_at<>first_captured_at);
  `);
  // Initial rows created by the retired first-seen backfill were not true
  // openings.  Drop only those legacy rows, then remove their empty points;
  // future initial rows can only be inserted by the external opening source.
  sqlite.exec(`
    DELETE FROM research_timeline_snapshots
     WHERE stage='initial' AND origin IS NULL;
    DELETE FROM research_timeline_points
     WHERE stage='initial'
       AND match_id NOT IN (
         SELECT DISTINCT match_id
           FROM research_timeline_snapshots
          WHERE stage='initial'
       );
    UPDATE research_timeline_snapshots
       SET origin=COALESCE(origin, 'legacy_live_observation'),
           source_name=COALESCE(source_name, provider)
     WHERE stage<>'initial';
  `);
  // Keep pre-existing multi-line openings for audit, but make their ambiguity
  // explicit. They are never silently promoted to a main line by migration.
  sqlite.exec(`
    UPDATE research_timeline_points
       SET note=CASE
         WHEN note IS NULL OR note='' THEN 'Ambiguous initial lines retained; no main inferred.'
         ELSE note || ' Ambiguous initial lines retained; no main inferred.'
       END
     WHERE stage='initial'
       AND INSTR(COALESCE(note,''), 'Ambiguous initial lines retained')=0
       AND EXISTS (
         SELECT 1
           FROM (
             SELECT provider,market,COUNT(DISTINCT line_key) AS line_count
               FROM research_timeline_snapshots s
              WHERE s.match_id=research_timeline_points.match_id
                AND s.stage='initial'
              GROUP BY provider,market
             HAVING COUNT(DISTINCT selection)>=2
                AND COUNT(DISTINCT line_key)>1
           )
       );
  `);
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

/**
 * SQLite cannot relax NOT NULL in place. Rebuild the two small identity/result
 * tables once, then backfill Titan identity before enforcing its DB invariant.
 */
function migrateCrownResearchFixtures(): void {
  const matchInfo = sqlite.prepare("PRAGMA table_info(matches)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const matchNames = new Set(matchInfo.map((column) => column.name));
  const hkjcColumn = matchInfo.find((column) => column.name === "hkjc_id");
  if (!matchNames.has("fixture_source") || !matchNames.has("titan_id") || hkjcColumn?.notnull === 1) {
    sqlite.transaction(() => {
      sqlite.exec(`
        DROP INDEX IF EXISTS matches_kickoff_idx;
        DROP INDEX IF EXISTS matches_pinnacle_idx;
        ALTER TABLE matches RENAME TO matches_pre_crown;
        CREATE TABLE matches (
          id TEXT PRIMARY KEY, hkjc_id TEXT,
          fixture_source TEXT NOT NULL DEFAULT 'hkjc'
            CHECK(fixture_source IN ('hkjc','crown')),
          titan_id TEXT, pinnacle_match_id TEXT,
          league TEXT NOT NULL, league_en TEXT, home_team TEXT NOT NULL, away_team TEXT NOT NULL,
          home_team_en TEXT, away_team_en TEXT, kickoff_utc INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'PREEVENT', inplay INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL);
        INSERT INTO matches(
          id,hkjc_id,fixture_source,titan_id,pinnacle_match_id,league,league_en,
          home_team,away_team,home_team_en,away_team_en,kickoff_utc,status,inplay,updated_at
        )
        SELECT id,hkjc_id,'hkjc',NULL,pinnacle_match_id,league,league_en,
               home_team,away_team,home_team_en,away_team_en,kickoff_utc,status,inplay,updated_at
          FROM matches_pre_crown;
        DROP TABLE matches_pre_crown;
        CREATE INDEX matches_kickoff_idx ON matches(kickoff_utc);
        CREATE INDEX matches_pinnacle_idx ON matches(pinnacle_match_id);
      `);
    })();
  }

  const resultInfo = sqlite.prepare("PRAGMA table_info(research_results)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  const resultNames = new Set(resultInfo.map((column) => column.name));
  const resultHkjc = resultInfo.find((column) => column.name === "hkjc_id");
  if (!resultNames.has("result_source") || !resultNames.has("source_match_id") || resultHkjc?.notnull === 1) {
    sqlite.transaction(() => {
      sqlite.exec(`
        DROP INDEX IF EXISTS research_results_fetched_idx;
        ALTER TABLE research_results RENAME TO research_results_pre_crown;
        CREATE TABLE research_results (
          match_id TEXT PRIMARY KEY, hkjc_id TEXT, home_score INTEGER NOT NULL,
          away_score INTEGER NOT NULL, corners_total INTEGER, source TEXT NOT NULL,
          result_source TEXT NOT NULL DEFAULT 'hkjc', source_match_id TEXT,
          fetched_at INTEGER NOT NULL);
        INSERT INTO research_results(
          match_id,hkjc_id,home_score,away_score,corners_total,source,result_source,source_match_id,fetched_at
        )
        SELECT match_id,hkjc_id,home_score,away_score,corners_total,source,'hkjc',hkjc_id,fetched_at
          FROM research_results_pre_crown;
        DROP TABLE research_results_pre_crown;
        CREATE INDEX research_results_fetched_idx ON research_results(fetched_at);
      `);
    })();
  }

  sqlite.exec(`
    UPDATE matches
       SET titan_id=(
         SELECT p.titan_id FROM pinnacle_source_map p
          WHERE p.match_id=matches.id AND p.titan_id IS NOT NULL
       )
     WHERE titan_id IS NULL
       AND EXISTS (
         SELECT 1 FROM pinnacle_source_map p
          WHERE p.match_id=matches.id AND p.titan_id IS NOT NULL
       );
  `);
  dedupeTitanFixtureIdentity();
  const duplicate = sqlite.prepare(
    `SELECT titan_id,COUNT(*) count FROM matches
      WHERE titan_id IS NOT NULL GROUP BY titan_id HAVING COUNT(*)>1 LIMIT 1`,
  ).get() as { titan_id: string; count: number } | undefined;
  if (duplicate) {
    throw new Error(`Duplicate Titan fixture identity ${duplicate.titan_id} (${duplicate.count} rows)`);
  }
  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS matches_titan_uniq ON matches(titan_id) WHERE titan_id IS NOT NULL");
}

function normalizedFixtureTeam(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Repair legacy Titan mappings before the unique index is installed.
 *
 * A duplicated sid can mean either a duplicate HKJC listing of the same match
 * (occasionally with home/away reversed), or a genuinely unrelated HKJC match
 * that was matched to the wrong Titan fixture. Duplicate research rows are
 * removed only for the former; unrelated HKJC history is retained.
 */
export function dedupeTitanFixtureIdentity(): number {
  return sqlite.transaction(() => {
    const groups = sqlite.prepare(
      `SELECT titan_id FROM matches
        WHERE titan_id IS NOT NULL
        GROUP BY titan_id HAVING COUNT(*)>1
        ORDER BY titan_id`,
    ).all() as Array<{ titan_id: string }>;
    let detached = 0;
    for (const group of groups) {
      const candidates = sqlite.prepare(
        `SELECT m.id,m.home_team,m.away_team,m.kickoff_utc,m.updated_at,
                COALESCE((SELECT COUNT(*) FROM research_results r WHERE r.match_id=m.id),0) result_count,
                COALESCE((SELECT COUNT(*) FROM research_timeline_snapshots s WHERE s.match_id=m.id),0) snapshot_count
           FROM matches m WHERE m.titan_id=?`,
      ).all(group.titan_id) as Array<{
        id: string;
        home_team: string;
        away_team: string;
        kickoff_utc: number;
        updated_at: number;
        result_count: number;
        snapshot_count: number;
      }>;
      candidates.sort((a, b) =>
        b.result_count - a.result_count
        || b.updated_at - a.updated_at
        || b.snapshot_count - a.snapshot_count
        || b.id.localeCompare(a.id),
      );
      const winner = candidates[0];
      if (!winner) continue;
      const winnerTeams = [
        normalizedFixtureTeam(winner.home_team),
        normalizedFixtureTeam(winner.away_team),
      ].sort().join("|");
      for (const loser of candidates.slice(1)) {
        const loserTeams = [
          normalizedFixtureTeam(loser.home_team),
          normalizedFixtureTeam(loser.away_team),
        ].sort().join("|");
        const sameFixture = winnerTeams === loserTeams
          && Math.abs(winner.kickoff_utc - loser.kickoff_utc) <= 15 * 60_000;
        if (sameFixture) {
          sqlite.prepare("DELETE FROM research_timeline_snapshots WHERE match_id=?").run(loser.id);
          sqlite.prepare("DELETE FROM research_timeline_points WHERE match_id=?").run(loser.id);
          sqlite.prepare("DELETE FROM research_results WHERE match_id=?").run(loser.id);
        }
        sqlite.prepare("UPDATE matches SET titan_id=NULL WHERE id=?").run(loser.id);
        sqlite.prepare(
          `UPDATE pinnacle_source_map
              SET titan_id=NULL,titan_reversed=0,
                  active_source=CASE WHEN active_source='titan' THEN NULL ELSE active_source END
            WHERE match_id=?`,
        ).run(loser.id);
        detached++;
      }
    }
    return detached;
  })();
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
