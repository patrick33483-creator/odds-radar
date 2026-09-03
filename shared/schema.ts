import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import type * as z from "zod/mini";

/* ------------------------------------------------------------------ *
 * 盤路雷達 — schema
 * Designed for long-term snapshot accumulation (the previous DB held
 * ~306k odds snapshots before the sandbox loss; indexes + retention
 * below are sized for that order of magnitude).
 * ------------------------------------------------------------------ */

export type FixtureSource = "hkjc" | "crown";

/** Canonical pre-match event. One row per actual fixture across research sources. */
export const matches = sqliteTable(
  "matches",
  {
    id: text("id").primaryKey(), // hkjc:<id>, or crown:<titan sid> until reconciled
    hkjcId: text("hkjc_id"),
    fixtureSource: text("fixture_source").notNull().default("hkjc"),
    titanId: text("titan_id"),
    pinnacleMatchId: text("pinnacle_match_id"), // active source id, normally pinnapi:<event_id>
    league: text("league").notNull(),
    leagueEn: text("league_en"),
    homeTeam: text("home_team").notNull(),
    awayTeam: text("away_team").notNull(),
    homeTeamEn: text("home_team_en"),
    awayTeamEn: text("away_team_en"),
    kickoffUtc: integer("kickoff_utc").notNull(), // epoch ms
    status: text("status").notNull().default("PREEVENT"),
    inplay: integer("inplay").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    koIdx: index("matches_kickoff_idx").on(t.kickoffUtc),
    pinnacleIdx: index("matches_pinnacle_idx").on(t.pinnacleMatchId),
    titanUniq: uniqueIndex("matches_titan_uniq").on(t.titanId).where(sql`${t.titanId} IS NOT NULL`),
  }),
);

/** A normalized market line (market + normalized line value). */
export const marketLines = sqliteTable(
  "market_lines",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    matchId: text("match_id").notNull(),
    market: text("market").notNull(), // '1X2' | 'AH' | 'OU' | 'COU'
    lineKey: text("line_key").notNull(), // '' for 1X2, '-0.25', '2.75', '9.75' ...
    lineValue: real("line_value"), // numeric normalized line (quarter steps)
    isMain: integer("is_main").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("market_lines_uniq").on(t.matchId, t.market, t.lineKey),
  }),
);

/** Raw tradeable decimal price snapshot. Append-only, retention-pruned. */
export const oddsSnapshots = sqliteTable(
  "odds_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    matchId: text("match_id").notNull(),
    provider: text("provider").notNull(), // 'hkjc' | 'pinnacle'
    market: text("market").notNull(),
    lineKey: text("line_key").notNull(),
    selection: text("selection").notNull(), // H/D/A | O/U
    decimalOdds: real("decimal_odds").notNull(),
    sourceUpdatedAt: integer("source_updated_at"),
    fetchedAt: integer("fetched_at").notNull(),
    phase: text("phase").notNull().default("prematch"), // never 'inplay' in this app
  },
  (t) => ({
    lookup: index("odds_lookup_idx").on(t.matchId, t.provider, t.market, t.lineKey, t.selection),
    time: index("odds_time_idx").on(t.fetchedAt),
  }),
);

/** Latest price per (match, provider, market, line, selection) — fast dashboard reads. */
export const oddsLatest = sqliteTable(
  "odds_latest",
  {
    key: text("key").primaryKey(), // matchId|provider|market|lineKey|selection
    matchId: text("match_id").notNull(),
    provider: text("provider").notNull(),
    market: text("market").notNull(),
    lineKey: text("line_key").notNull(),
    selection: text("selection").notNull(),
    decimalOdds: real("decimal_odds").notNull(),
    prevDecimalOdds: real("prev_decimal_odds"),
    sourceUpdatedAt: integer("source_updated_at"),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (t) => ({
    m: index("odds_latest_match_idx").on(t.matchId),
  }),
);

/** Immutable research checkpoints and their copied pre-match price rows. */
export const researchTimelinePoints = sqliteTable(
  "research_timeline_points",
  {
    matchId: text("match_id").notNull(),
    stage: text("stage").notNull(), // initial | T30 | T15 | T5
    targetAt: integer("target_at"),
    /** Immutable timestamp of the first quote row captured for this checkpoint. */
    firstCapturedAt: integer("first_captured_at"),
    /** Most recent later attempt to complete a still-partial checkpoint. */
    lastRetryAt: integer("last_retry_at"),
    /** Legacy compatibility alias. Frozen to the same value as firstCapturedAt. */
    capturedAt: integer("captured_at"),
    status: text("status").notNull().default("pending"), // pending | partial | captured
    note: text("note"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("research_timeline_points_uniq").on(t.matchId, t.stage),
    due: index("research_timeline_due_idx").on(t.status, t.targetAt),
  }),
);

export const researchTimelineSnapshots = sqliteTable(
  "research_timeline_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    matchId: text("match_id").notNull(),
    provider: text("provider").notNull(), // hkjc | pinnacle
    market: text("market").notNull(), // AH | OU | COU
    stage: text("stage").notNull(),
    lineKey: text("line_key").notNull(),
    selection: text("selection").notNull(),
    decimalOdds: real("decimal_odds").notNull(),
    isMain: integer("is_main").notNull().default(0),
    sourceUpdatedAt: integer("source_updated_at"),
    capturedAt: integer("captured_at").notNull(),
    targetAt: integer("target_at"),
    status: text("status").notNull().default("captured"),
    /** Collection method, e.g. external_opening or live_observation. */
    origin: text("origin").notNull().default("live_observation"),
    sourceName: text("source_name"),
    sourceMatchId: text("source_match_id"),
    sourceUrl: text("source_url"),
  },
  (t) => ({
    uniq: uniqueIndex("research_timeline_uniq").on(
      t.matchId,
      t.provider,
      t.market,
      t.stage,
      t.lineKey,
      t.selection,
    ),
    match: index("research_timeline_match_idx").on(t.matchId, t.stage, t.provider, t.market),
    captured: index("research_timeline_captured_idx").on(t.capturedAt),
  }),
);

/**
 * Persistent Crown detail-attempt ledger. It supplies both restart-safe
 * backoff and an oldest-attempt-first queue for the research-only collector.
 */
export const crownResearchAttempts = sqliteTable(
  "crown_research_attempts",
  {
    titanId: text("titan_id").primaryKey(),
    lastAttemptAt: integer("last_attempt_at").notNull(),
  },
  (t) => ({
    due: index("crown_research_attempts_due_idx").on(t.lastAttemptAt),
  }),
);

/** Team name aliases across providers (learned + seeded). */
export const teamAliases = sqliteTable(
  "team_aliases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    canonical: text("canonical").notNull(), // normalized simplified-Chinese key
    alias: text("alias").notNull(),
    provider: text("provider").notNull(), // 'hkjc' | 'pinnacle'
    confirmedAt: integer("confirmed_at").notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("team_aliases_uniq").on(t.provider, t.alias),
    canon: index("team_aliases_canonical_idx").on(t.canonical),
  }),
);

/** Persistent HKJC <-> Pinnacle event mapping with confidence + reason. */
export const matchMapping = sqliteTable(
  "match_mapping",
  {
    matchId: text("match_id").primaryKey(),
    pinnacleMatchId: text("pinnacle_match_id"),
    confidence: real("confidence").notNull().default(0),
    method: text("method").notNull(), // 'time+league+alias' | 'manual' | 'cached'
    kickoffDeltaSec: integer("kickoff_delta_sec"),
    unmatchedReason: text("unmatched_reason"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    pinnacle: index("match_mapping_pinnacle_idx").on(t.pinnacleMatchId),
  }),
);

/** Detected opportunities (arb / EV / synthetic-arb) with dedupe state. */
export const opportunities = sqliteTable(
  "opportunities",
  {
    key: text("key").primaryKey(), // category|matchId|lineKey|selection
    category: text("category").notNull(), // 'arb' | 'ev' | 'synth_arb'
    matchId: text("match_id").notNull(),
    market: text("market").notNull(),
    lineKey: text("line_key").notNull(),
    selection: text("selection").notNull(),
    payload: text("payload").notNull(), // JSON detail
    metric: real("metric").notNull(), // arb: q ; ev: edge
    firstSeen: integer("first_seen").notNull(),
    lastSeen: integer("last_seen").notNull(),
    notified: integer("notified").notNull().default(0),
  },
  (t) => ({
    cat: index("opportunities_cat_idx").on(t.category, t.lastSeen),
  }),
);

/**
 * Simulated bets. EV is limited to one bet per match; direct and synthetic
 * locks may coexist when their unique keys differ and each Crown selection's
 * aggregate exposure remains at or below HK$5,000.
 */
export const simulationBets = sqliteTable(
  "simulation_bets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    uniqueKey: text("unique_key").notNull(), // category|matchId|lineKey|selection
    category: text("category").notNull(), // 'case1_arb' | 'case2_ev' | 'synth_arb'
    matchId: text("match_id").notNull(),
    market: text("market").notNull(),
    lineKey: text("line_key").notNull(),
    selection: text("selection").notNull(),
    matchLabel: text("match_label").notNull(),
    league: text("league").notNull(),
    kickoffUtc: integer("kickoff_utc").notNull(),
    totalStake: real("total_stake").notNull(),
    expectedPayout: real("expected_payout").notNull(),
    expectedProfit: real("expected_profit").notNull(),
    roi: real("roi").notNull(),
    evPct: real("ev_pct"),
    qTotal: real("q_total"),
    placedAt: integer("placed_at").notNull(),
    settledAt: integer("settled_at"),
    resultStatus: text("result_status"), // 'win'|'half_win'|'push'|'half_loss'|'loss'|'mixed'
    realizedReturn: real("realized_return"),
    realizedPnl: real("realized_pnl"),
    finalScore: text("final_score"),
    /** Final-score provenance, e.g. pinnapi_live or titan_over_YYYYMMDD. */
    settlementSource: text("settlement_source"),
    notes: text("notes"),
    /** Preserves legacy rows for audit while excluding them from the live test. */
    excludedFromStats: integer("excluded_from_stats").notNull().default(0),
    exclusionReason: text("exclusion_reason"),
  },
  (t) => ({
    uniq: uniqueIndex("simulation_bets_uniq").on(t.uniqueKey),
    cat: index("simulation_bets_cat_idx").on(t.category, t.placedAt),
  }),
);

/** Individual legs of a simulated bet. */
export const simulationLegs = sqliteTable(
  "simulation_legs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    betId: integer("bet_id").notNull(),
    provider: text("provider").notNull(), // 'hkjc' | 'pinnacle'
    market: text("market").notNull(),
    lineKey: text("line_key").notNull(),
    selection: text("selection").notNull(),
    decimalOdds: real("decimal_odds").notNull(),
    stake: real("stake").notNull(),
    synthetic: integer("synthetic").notNull().default(0),
    syntheticDetail: text("synthetic_detail"),
    legStatus: text("leg_status"),
    legReturn: real("leg_return"),
  },
  (t) => ({
    bet: index("simulation_legs_bet_idx").on(t.betId),
  }),
);

/** Final results, including HKJC's confirmed total-corners result when present. */
export const results = sqliteTable(
  "results",
  {
    matchId: text("match_id").primaryKey(),
    pinnacleMatchId: text("pinnacle_match_id"),
    homeScore: integer("home_score").notNull(),
    awayScore: integer("away_score").notNull(),
    cornersTotal: integer("corners_total"),
    halfHome: integer("half_home"),
    halfAway: integer("half_away"),
    source: text("source").notNull(), // 'titan_today' | 'titan_over'
    fetchedAt: integer("fetched_at").notNull(),
  },
);

/**
 * Last score observed for an open simulated bet in PinnAPI's single live
 * markets response. A record becomes an end candidate only after it was seen
 * live and later disappears from that live response.
 */
export const pinnapiLiveScores = sqliteTable(
  "pinnapi_live_scores",
  {
    eventId: text("event_id").primaryKey(),
    matchId: text("match_id").notNull(),
    homeScore: integer("home_score").notNull(),
    awayScore: integer("away_score").notNull(),
    matchMinutes: integer("match_minutes"),
    matchState: text("match_state"),
    firstSeen: integer("first_seen").notNull(),
    lastSeen: integer("last_seen").notNull(),
    seenLive: integer("seen_live").notNull().default(1),
    noLongerLive: integer("no_longer_live").notNull().default(0),
    endedCandidateAt: integer("ended_candidate_at"),
  },
  (t) => ({
    match: index("pinnapi_live_scores_match_idx").on(t.matchId),
    open: index("pinnapi_live_scores_open_idx").on(t.seenLive, t.noLongerLive),
  }),
);

/** Provider health / structured status. */
export const providerHealth = sqliteTable("provider_health", {
  provider: text("provider").primaryKey(),
  ok: integer("ok").notNull().default(0),
  lastSuccessAt: integer("last_success_at"),
  lastAttemptAt: integer("last_attempt_at"),
  lastErrorAt: integer("last_error_at"),
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastLatencyMs: integer("last_latency_ms"),
  itemCount: integer("item_count").notNull().default(0),
  mode: text("mode").notNull().default("live"), // 'live' | 'degraded' | 'demo'
});

/** Key/value app state (cold-start flags, last refresh, cursors). */
export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const insertSimulationBetSchema = createInsertSchema(simulationBets).omit({ id: true });
export const insertSimulationLegSchema = createInsertSchema(simulationLegs).omit({ id: true });

export type Match = typeof matches.$inferSelect;
export type MarketLine = typeof marketLines.$inferSelect;
export type OddsSnapshot = typeof oddsSnapshots.$inferSelect;
export type OddsLatest = typeof oddsLatest.$inferSelect;
export type TeamAlias = typeof teamAliases.$inferSelect;
export type MatchMapping = typeof matchMapping.$inferSelect;
export type Opportunity = typeof opportunities.$inferSelect;
export type SimulationBet = typeof simulationBets.$inferSelect;
export type SimulationLeg = typeof simulationLegs.$inferSelect;
export type MatchResult = typeof results.$inferSelect;
export type PinnapiLiveScoreCache = typeof pinnapiLiveScores.$inferSelect;
export type ProviderHealth = typeof providerHealth.$inferSelect;
export type InsertSimulationBet = z.infer<typeof insertSimulationBetSchema>;
export type InsertSimulationLeg = z.infer<typeof insertSimulationLegSchema>;
