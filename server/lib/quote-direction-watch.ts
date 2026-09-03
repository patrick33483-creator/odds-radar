/**
 * Isolated, silent prospective ledger for two fixed quote-direction watches.
 *
 * This module reads only research_timeline_snapshots/matches and writes only
 * quote_direction_watch_observations plus its activation state.  It must
 * never be wired to execution, simulation, opportunities, or Telegram.
 */
import { rawDb } from "./store";

export const WATCH_LEAGUE_WATER = "WATCH-LEAGUE-WATER-P70-P90";
export const WATCH_T30_HKJC_LAG = "WATCH-T30-HKJC-LAG-003";
export const QUOTE_DIRECTION_WATCH_ACTIVATED_AT = "quote_direction_watch_activated_at";
// The audited P70--P90 candidate was AH; the separately approved HKJC-lag watch is OU.
export const WATER_BASELINE_VERSION = "pinnacle_ah_same_line_water_league_v1_nearest_rank";
export const WATER_BASELINE_MINIMUM = 30;
const EPSILON = 1e-9;
const MAX_T30_CANDIDATES_PER_RUN = 250;

type WatchMarket = "AH" | "OU";
type Selection = "H" | "A" | "O" | "U";
type MainPair = {
  lineKey: string;
  capturedAt: number;
  odds: Record<Selection, number>;
};
type Candidate = {
  matchId: string;
  league: string;
  kickoffUtc: number;
  market: WatchMarket;
  hkjc: MainPair;
  pinnacle: MainPair;
  initial: MainPair | null;
};

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export interface QuoteDirectionWatchOutcome {
  candidates: number;
  inserted: number;
  insufficientBaseline: number;
  t5Confirmed: number;
}

function activationAt(): number {
  const row = rawDb.prepare(
    "SELECT value FROM app_state WHERE key=?",
  ).get(QUOTE_DIRECTION_WATCH_ACTIVATED_AT) as { value: string } | undefined;
  const value = Number(row?.value);
  return Number.isFinite(value) && value > 0 ? value : Date.now();
}

function selectionsFor(market: WatchMarket): Selection[] {
  return market === "AH" ? ["H", "A"] : ["O", "U"];
}

function mainPair(
  matchId: string,
  provider: "hkjc" | "pinnacle",
  stage: "initial" | "T30" | "T5",
  market: WatchMarket,
): MainPair | null {
  const rows = rawDb.prepare(
    `SELECT line_key,selection,decimal_odds,captured_at
       FROM research_timeline_snapshots
      WHERE match_id=? AND provider=? AND market=? AND stage=? AND is_main=1
      ORDER BY line_key,selection`,
  ).all(matchId, provider, market, stage) as Array<{
    line_key: string; selection: string; decimal_odds: number; captured_at: number;
  }>;
  const byLine = new Map<string, MainPair>();
  for (const row of rows) {
    if (!selectionsFor(market).includes(row.selection as Selection)) continue;
    const pair = byLine.get(row.line_key) ?? {
      lineKey: row.line_key,
      capturedAt: row.captured_at,
      odds: {} as Record<Selection, number>,
    };
    pair.capturedAt = Math.max(pair.capturedAt, row.captured_at);
    pair.odds[row.selection as Selection] = row.decimal_odds;
    byLine.set(row.line_key, pair);
  }
  const complete = [...byLine.values()].filter((pair) =>
    selectionsFor(market).every((selection) => Number.isFinite(pair.odds[selection])),
  );
  return complete.length === 1 ? complete[0] : null;
}

function latestCandidates(activeAt: number, market: WatchMarket, ruleId: string): Candidate[] {
  const matches = rawDb.prepare(
    `SELECT DISTINCT m.id,m.league,m.kickoff_utc
       FROM matches m
       JOIN research_timeline_snapshots h
         ON h.match_id=m.id AND h.provider='hkjc' AND h.market=? AND h.stage='T30' AND h.is_main=1
      WHERE m.fixture_source='hkjc'
        AND m.kickoff_utc>?
        AND h.captured_at>=?
        AND NOT EXISTS (
          SELECT 1
            FROM quote_direction_watch_observations observed
           WHERE observed.rule_id=?
             AND observed.match_id=m.id
             AND observed.market=?
        )
      ORDER BY h.captured_at,m.id
      LIMIT ?`,
  ).all(market, activeAt, activeAt, ruleId, market, MAX_T30_CANDIDATES_PER_RUN) as Array<{
    id: string; league: string; kickoff_utc: number;
  }>;
  return matches.flatMap((match) => {
    const hkjc = mainPair(match.id, "hkjc", "T30", market);
    const pinnacle = mainPair(match.id, "pinnacle", "T30", market);
    if (!hkjc || !pinnacle || pinnacle.capturedAt < activeAt || hkjc.lineKey !== pinnacle.lineKey) return [];
    const initial = mainPair(match.id, "pinnacle", "initial", market);
    return [{
      matchId: match.id,
      league: match.league,
      kickoffUtc: match.kickoff_utc,
      market,
      hkjc,
      pinnacle,
      initial,
    }];
  });
}

function nearestRank(values: number[], percentile: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.min(ordered.length - 1, Math.ceil(percentile * ordered.length) - 1))];
}

/**
 * The frozen baseline is strictly earlier observations from activated fixtures;
 * results, T5, and subsequently observed values never alter an existing row.
 */
function waterBaseline(league: string, market: WatchMarket, beforeCapturedAt: number, activeAt: number): number[] {
  const rows = rawDb.prepare(
    `SELECT i.match_id,i.line_key,i.selection,i.decimal_odds AS initial_odds,t.decimal_odds AS t30_odds
       FROM matches m
       JOIN research_timeline_snapshots i
         ON i.match_id=m.id AND i.provider='pinnacle' AND i.market=?
        AND i.stage='initial' AND i.is_main=1
       JOIN research_timeline_snapshots t
         ON t.match_id=i.match_id AND t.provider='pinnacle' AND t.market=?
        AND t.stage='T30' AND t.is_main=1
        AND t.line_key=i.line_key AND t.selection=i.selection
      WHERE m.fixture_source='hkjc'
        AND m.league=?
        AND m.kickoff_utc>?
        AND i.captured_at>=?
        AND t.captured_at>=?
        AND t.captured_at<?
        AND i.selection IN ('H','A','O','U')
      ORDER BY t.captured_at,i.match_id
      LIMIT 2000`,
  ).all(market, market, league, activeAt, activeAt, activeAt, beforeCapturedAt) as Array<{
    match_id: string; line_key: string; selection: Selection; initial_odds: number; t30_odds: number;
  }>;
  const grouped = new Map<string, Map<Selection, { initial: number; t30: number }>>();
  for (const row of rows) {
    const key = `${row.match_id}|${row.line_key}`;
    const pair = grouped.get(key) ?? new Map();
    pair.set(row.selection, { initial: row.initial_odds, t30: row.t30_odds });
    grouped.set(key, pair);
  }
  const water: number[] = [];
  for (const pair of grouped.values()) {
    if (!selectionsFor(market).every((selection) => pair.has(selection))) continue;
    for (const value of pair.values()) water.push(rounded(value.initial - value.t30));
  }
  return water;
}

function key(ruleId: string, candidate: Candidate, selection: Selection): string {
  return `${ruleId}|${candidate.matchId}|${candidate.market}|${candidate.hkjc.lineKey}|${selection}`;
}

const insert = rawDb.prepare(
  `INSERT OR IGNORE INTO quote_direction_watch_observations(
    unique_key,rule_id,match_id,league,market,line_key,selection,decision_stage,
    decision_odds,reference_odds,odds_gap,percentile_low,percentile_high,
    baseline_count,baseline_version,status,detected_at,notified_at
  ) VALUES(
    ?,?,?,?,
    ?,?,?,?,
    ?,?,?,?,?,
    ?,?,?,?,
    NULL
  )`,
);

function insertWater(candidate: Candidate, selection: Selection, activeAt: number): "inserted" | "insufficient" | "none" {
  if (!candidate.initial || candidate.initial.lineKey !== candidate.pinnacle.lineKey) return "none";
  if (candidate.initial.capturedAt < activeAt || candidate.pinnacle.capturedAt < activeAt) return "none";
  const baseline = waterBaseline(candidate.league, candidate.market, candidate.pinnacle.capturedAt, activeAt);
  const water = rounded(candidate.initial.odds[selection] - candidate.pinnacle.odds[selection]);
  const base = [
    key(WATCH_LEAGUE_WATER, candidate, selection),
    WATCH_LEAGUE_WATER,
    candidate.matchId,
    candidate.league,
    candidate.market,
    candidate.hkjc.lineKey,
    selection,
    "T30",
    candidate.hkjc.odds[selection],
    candidate.pinnacle.odds[selection],
    water,
  ];
  if (baseline.length < WATER_BASELINE_MINIMUM) {
    return insert.run(
      ...base, null, null, baseline.length, WATER_BASELINE_VERSION, "insufficient_baseline", candidate.pinnacle.capturedAt,
    ).changes ? "insufficient" : "none";
  }
  const low = nearestRank(baseline, 0.70);
  const high = nearestRank(baseline, 0.90);
  if (water + EPSILON < low || water >= high - EPSILON) {
    // Freeze the negative decision too, so old T30 rows cannot monopolize the bounded collector.
    return insert.run(
      ...base, low, high, baseline.length, WATER_BASELINE_VERSION, "outside_percentile", candidate.pinnacle.capturedAt,
    ).changes ? "inserted" : "none";
  }
  return insert.run(
    ...base, low, high, baseline.length, WATER_BASELINE_VERSION, "pending", candidate.pinnacle.capturedAt,
  ).changes ? "inserted" : "none";
}

function insertLag(candidate: Candidate, selection: Selection): boolean {
  const gap = rounded(candidate.hkjc.odds[selection] - candidate.pinnacle.odds[selection]);
  if (gap + EPSILON < 0.03) return false;
  return insert.run(
    key(WATCH_T30_HKJC_LAG, candidate, selection),
    WATCH_T30_HKJC_LAG,
    candidate.matchId,
    candidate.league,
    candidate.market,
    candidate.hkjc.lineKey,
    selection,
    "T30",
    candidate.hkjc.odds[selection],
    candidate.pinnacle.odds[selection],
    gap,
    null,
    null,
    null,
    null,
    "pending",
    candidate.hkjc.capturedAt,
  ).changes > 0;
}

function saveT5Confirmation(activeAt: number): number {
  const rows = rawDb.prepare(
    `SELECT DISTINCT match_id,market,line_key,selection,decision_odds,reference_odds
       FROM quote_direction_watch_observations
      WHERE detected_at>=? AND t5_checked_at IS NULL`,
  ).all(activeAt) as Array<{
    match_id: string; market: WatchMarket; line_key: string; selection: Selection; decision_odds: number; reference_odds: number;
  }>;
  const update = rawDb.prepare(
    `UPDATE quote_direction_watch_observations
        SET t5_checked_at=?,t5_provider='pinnacle',t5_odds=?,t5_change=?,t5_confirmation=?
      WHERE match_id=? AND market=? AND line_key=? AND selection=? AND t5_checked_at IS NULL`,
  );
  let changed = 0;
  for (const row of rows) {
    const t5 = mainPair(row.match_id, "pinnacle", "T5", row.market);
    if (!t5) continue;
    const sameLine = t5.lineKey === row.line_key;
    const change = sameLine ? rounded(row.reference_odds - t5.odds[row.selection]) : null;
    const confirmation = !sameLine ? "line_changed"
      : change! >= 0.01 ? "continue_water"
        : change! <= -0.01 ? "reverse"
          : "flat";
    changed += update.run(
      t5.capturedAt, sameLine ? t5.odds[row.selection] : null, change, confirmation,
      row.match_id, row.market, row.line_key, row.selection,
    ).changes;
  }
  return changed;
}

/** Bounded and idempotent; no result settlement or notification path exists. */
export function syncQuoteDirectionWatchObservations(): QuoteDirectionWatchOutcome {
  const activeAt = activationAt();
  let inserted = 0;
  let insufficientBaseline = 0;
  const waterCandidates = latestCandidates(activeAt, "AH", WATCH_LEAGUE_WATER);
  const lagCandidates = latestCandidates(activeAt, "OU", WATCH_T30_HKJC_LAG);
  rawDb.transaction(() => {
    for (const candidate of waterCandidates) {
      for (const selection of ["H", "A"] as const) {
        const water = insertWater(candidate, selection, activeAt);
        if (water === "inserted") inserted++;
        if (water === "insufficient") insufficientBaseline++;
      }
    }
    for (const candidate of lagCandidates) {
      for (const selection of ["O", "U"] as const) {
        if (insertLag(candidate, selection)) inserted++;
      }
    }
  })();
  return {
    candidates: waterCandidates.length + lagCandidates.length,
    inserted,
    insufficientBaseline,
    t5Confirmed: saveT5Confirmation(activeAt),
  };
}
