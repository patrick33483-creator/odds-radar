import type { HkjcProvider } from "../providers/hkjc";
import { hkjcHktDate } from "../providers/hkjc";
import { parseSchedulePage } from "../providers/pinnacle";
import { fetchText } from "./http";
import {
  TipsmeOpeningProvider,
  type TipsmeOpeningResult,
  type TipsmeScheduleEvent,
} from "../providers/tipsme-opening";
import type { ProviderPrice } from "../providers/types";
import { lineKeyOf } from "./lines";
import { matchEvent, normalizeName, type AliasIndex, type CandidateEvent } from "./matching";
import { getState, rawDb, setState } from "./store";
import type {
  ResearchDatasetResponse,
  ResearchMarket,
  ResearchMatchRow,
  ResearchProvider,
  ResearchResultCollectorStatus,
  ResearchStage,
  ResearchStageSnapshot,
  ResearchTimelineQuote,
} from "@shared/types";

const RESULT_DELAY_MS = 105 * 60_000;
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 120;
const DEFAULT_HORIZON_DAYS = 14;
const MAX_HORIZON_DAYS = 60;
const DEFAULT_UPCOMING_LIMIT = 300;
const MAX_UPCOMING_LIMIT = 1000;
const DEFAULT_FINISHED_LIMIT = 300;
const MAX_FINISHED_LIMIT = 2000;
const FALLBACK_UPCOMING_HORIZON_MS = 7 * 24 * 60 * 60_000;
const MAX_RESULT_LOOKBACK_DAYS = 30;

export type ResearchWindow = "upcoming" | "finished" | "all";
const MAX_EXPORT_ROWS = 100_000;
const RESEARCH_MARKETS = ["AH", "OU", "COU"] as const;
const RESEARCH_PROVIDERS = ["hkjc", "pinnacle"] as const;
export const RESEARCH_STAGES: ResearchStage[] = ["initial", "T30", "T15", "T5"];

export interface ResearchFilters {
  window: ResearchWindow;
  days: number;
  horizonDays: number;
  limit: number;
  provider: ResearchProvider | "all";
  market: "AH" | "OU" | "COU" | "all";
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.floor(parsed)))
    : fallback;
}

function boundedDays(value: unknown, fallback = DEFAULT_LOOKBACK_DAYS): number {
  return boundedNumber(value, fallback, 1, MAX_LOOKBACK_DAYS);
}

function boundedHorizonDays(value: unknown, fallback = DEFAULT_HORIZON_DAYS): number {
  return boundedNumber(value, fallback, 1, MAX_HORIZON_DAYS);
}

function boundedLimit(value: unknown, fallback: number, max: number): number {
  return boundedNumber(value, fallback, 1, max);
}

function parseWindow(value: unknown): ResearchWindow {
  const raw = typeof value === "string" ? value.toLowerCase() : "";
  if (raw === "upcoming" || raw === "finished" || raw === "all") return raw;
  // Default preserves the legacy behaviour when no window is supplied.
  return "upcoming";
}

/**
 * Older callers (including a few tests) still pass the legacy
 * `{ days, provider, market }` shape.  Fill in the rolling-window fields
 * with backwards-compatible defaults so those call sites keep working.
 */
function normalizeFilters(filters: Partial<ResearchFilters> & Pick<ResearchFilters, "days" | "provider" | "market">): ResearchFilters {
  return {
    window: filters.window ?? "all",
    days: filters.days,
    horizonDays: filters.horizonDays ?? 7,
    limit: filters.limit ?? DEFAULT_UPCOMING_LIMIT,
    provider: filters.provider,
    market: filters.market,
  };
}

export function parseResearchFilters(query: Record<string, unknown>): ResearchFilters {
  const provider = RESEARCH_PROVIDERS.includes(String(query.provider) as (typeof RESEARCH_PROVIDERS)[number])
    ? (String(query.provider) as ResearchProvider)
    : "all";
  const market = RESEARCH_MARKETS.includes(String(query.market) as (typeof RESEARCH_MARKETS)[number])
    ? (String(query.market) as "AH" | "OU" | "COU")
    : "all";
  const window = parseWindow(query.window);
  const days = boundedDays(query.days);
  const horizonDays = boundedHorizonDays(query.horizonDays);
  const limit = window === "finished"
    ? boundedLimit(query.limit, DEFAULT_FINISHED_LIMIT, MAX_FINISHED_LIMIT)
    : boundedLimit(query.limit, DEFAULT_UPCOMING_LIMIT, MAX_UPCOMING_LIMIT);
  return { window, days, horizonDays, limit, provider, market };
}

export function researchStageFor(kickoffUtc: number, observedAt: number): Exclude<ResearchStage, "initial"> | null {
  const minutes = (kickoffUtc - observedAt) / 60_000;
  // Capture the first available quote after each target. INSERT OR IGNORE
  // freezes that stage, so a short provider delay cannot erase the milestone.
  if (minutes > 15 && minutes <= 30) return "T30";
  if (minutes > 5 && minutes <= 15) return "T15";
  if (minutes > 0 && minutes <= 5) return "T5";
  return null;
}

function stageTargetAt(stage: ResearchStage, kickoffUtc: number): number | null {
  if (stage === "initial") return null;
  const minutes = stage === "T30" ? 30 : stage === "T15" ? 15 : 5;
  return kickoffUtc - minutes * 60_000;
}

export function captureResearchTimelinePrices(
  matchId: string,
  provider: "hkjc" | "pinnacle" | "crown",
  prices: ProviderPrice[],
  kickoffUtc: number,
  observedAt: number,
): number {
  const accepted = prices.filter((price) =>
    RESEARCH_MARKETS.includes(price.market as (typeof RESEARCH_MARKETS)[number])
    && (provider !== "crown" || price.market === "AH" || price.market === "OU"),
  );
  if (!accepted.length) return 0;

  const milestone = researchStageFor(kickoffUtc, observedAt);
  // Opening is a distinct external historical source.  A first observation
  // from the live timeline must never be relabelled as an opening price for
  // HKJC-linked fixtures.  Pinnacle-only fixtures have no external Tipsme
  // opening, so their earliest live snapshot (>30 minutes before kickoff) is
  // frozen as the initial checkpoint just once via INSERT OR IGNORE.
  const stages: ResearchStage[] = milestone ? [milestone] : [];
  if (!milestone && provider === "pinnacle") {
    const identity = fixtureIdentity(matchId);
    if (identity.fixture_source === "pinnacle" && observedAt < kickoffUtc - 30 * 60_000) {
      stages.push("initial");
    }
  }
  if (!stages.length) return 0;
  const insert = rawDb.prepare(
    `INSERT OR IGNORE INTO research_timeline_snapshots(
      match_id,provider,market,stage,line_key,selection,decimal_odds,is_main,
      source_updated_at,captured_at,target_at,status,origin,source_name,
      source_match_id,source_url
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'captured','live_observation',?,?,?)`,
  );
  const ensurePoint = rawDb.prepare(
    `INSERT INTO research_timeline_points(
      match_id,stage,target_at,first_captured_at,last_retry_at,captured_at,status,note,created_at,updated_at
    ) VALUES(?,?,?,NULL,NULL,NULL,'pending',NULL,?,?)
    ON CONFLICT(match_id,stage) DO NOTHING`,
  );
  const pointStatus = rawDb.prepare(
    "SELECT status,first_captured_at FROM research_timeline_points WHERE match_id=? AND stage=?",
  );
  const completeGroups = rawDb.prepare(
    `SELECT COUNT(*) count FROM (
       SELECT provider,market
         FROM research_timeline_snapshots
        WHERE match_id=? AND stage=?
        GROUP BY provider,market
       HAVING COUNT(DISTINCT selection)>=2
     )`,
  );
  const updatePoint = rawDb.prepare(
    `UPDATE research_timeline_points
        SET first_captured_at=COALESCE(first_captured_at,?),
            last_retry_at=COALESCE(?,last_retry_at),
            captured_at=COALESCE(captured_at,?),
            status=?,note=?,updated_at=?
      WHERE match_id=? AND stage=?`,
  );
  let inserted = 0;
  const tx = rawDb.transaction(() => {
    for (const stage of stages) {
      ensurePoint.run(matchId, stage, stageTargetAt(stage, kickoffUtc), observedAt, observedAt);
      const current = pointStatus.get(matchId, stage) as {
        status: string;
        first_captured_at: number | null;
      } | undefined;
      if (current?.status === "captured") continue;
      for (const price of accepted) {
        const lineKey = lineKeyOf(price.market, price.lineValue);
        inserted += insert.run(
          matchId,
          provider,
          price.market,
          stage,
          lineKey,
          price.selection,
          price.decimalOdds,
          price.isMain ? 1 : 0,
          price.sourceUpdatedAt ?? null,
          observedAt,
          stageTargetAt(stage, kickoffUtc),
          provider,
          null,
          null,
        ).changes;
      }
      const complete = (completeGroups.get(matchId, stage) as { count: number }).count;
      const expected = expectedPairCount(matchId, stage);
      const status = complete >= expected ? "captured" : "partial";
      const note = status === "captured" ? null : `${complete}/${expected} provider-market pairs complete`;
      const retryAt = current?.first_captured_at === null || current?.first_captured_at === undefined
        ? null
        : observedAt;
      updatePoint.run(observedAt, retryAt, observedAt, status, note, observedAt, matchId, stage);
    }
  });
  tx();
  return inserted;
}

export interface ResearchOpeningProvider {
  fetchSchedule(date: string): Promise<TipsmeScheduleEvent[]>;
  fetchOpening(sourceMatchId: string): Promise<TipsmeOpeningResult>;
}

export interface ResearchOpeningCollectionOutcome {
  candidates: number;
  matched: number;
  fetched: number;
  inserted: number;
}

const INITIAL_AVAILABLE_PAIRS = 5;
const PINNACLE_COU_NOTE = "Pinnacle COU opening unavailable: Tipsme public v2 has no Pinnacle corner-opening source.";

function sourceDay(epochMs: number): string | null {
  return hkjcHktDate(epochMs);
}

function researchAliasIndex(): AliasIndex {
  const aliases = new Map<string, string>();
  const rows = rawDb.prepare("SELECT provider,alias,canonical FROM team_aliases").all() as Array<{
    provider: "hkjc" | "pinnacle";
    alias: string;
    canonical: string;
  }>;
  for (const row of rows) aliases.set(`${row.provider}|${normalizeName(row.alias)}`, row.canonical);
  return {
    get(provider, alias) {
      return aliases.get(`${provider}|${normalizeName(alias)}`);
    },
  };
}

function initialPairCount(matchId: string): number {
  return (rawDb.prepare(
    `SELECT COUNT(*) count FROM (
       SELECT provider,market
         FROM research_timeline_snapshots
        WHERE match_id=? AND stage='initial'
          AND NOT (provider='pinnacle' AND market='COU')
        GROUP BY provider,market
       HAVING COUNT(DISTINCT selection)>=2
     )`,
  ).get(matchId) as { count: number }).count;
}

function existingCompleteInitialLines(matchId: string, provider: string, market: string): string[] {
  return (rawDb.prepare(
    `SELECT line_key
       FROM research_timeline_snapshots
      WHERE match_id=? AND provider=? AND market=? AND stage='initial'
      GROUP BY line_key
     HAVING COUNT(DISTINCT selection)>=2
      ORDER BY line_key`,
  ).all(matchId, provider, market) as Array<{ line_key: string }>).map((row) => row.line_key);
}

function initialLineAmbiguities(matchId: string): string[] {
  return (rawDb.prepare(
    `SELECT provider,market,COUNT(DISTINCT line_key) AS line_count
       FROM research_timeline_snapshots
      WHERE match_id=? AND stage='initial'
      GROUP BY provider,market
     HAVING COUNT(DISTINCT selection)>=2
        AND COUNT(DISTINCT line_key)>1
      ORDER BY provider,market`,
  ).all(matchId) as Array<{ provider: string; market: string; line_count: number }>)
    .map((row) => `${row.provider}/${row.market}=${row.line_count} lines`);
}

function fixtureIdentity(matchId: string): {
  fixture_source: "hkjc" | "pinnacle" | "crown";
  titan_id: string | null;
} {
  return (rawDb.prepare(
    "SELECT fixture_source,titan_id FROM matches WHERE id=?",
  ).get(matchId) as { fixture_source: "hkjc" | "pinnacle" | "crown"; titan_id: string | null } | undefined)
    ?? { fixture_source: "hkjc", titan_id: null };
}

/** Number of genuinely supported provider/market pairs for this fixture. */
export function expectedPairCount(matchId: string, stage: ResearchStage): number {
  const fixture = fixtureIdentity(matchId);
  if (fixture.fixture_source === "crown") return 2; // Crown AH + OU only.
  if (fixture.fixture_source === "pinnacle") {
    // Titan-driven Pinnacle-only fixtures collect Pinnacle AH + OU. Corners
    // are not exposed by Titan's standard Pinnacle detail rows.
    return 2;
  }
  const base = stage === "initial" ? INITIAL_AVAILABLE_PAIRS : 6;
  return base + (fixture.titan_id ? 2 : 0);
}

/** Insert genuine opening rows only; each opening key remains immutable. */
export function saveResearchInitialSnapshots(
  matchId: string,
  opening: TipsmeOpeningResult,
  capturedAt = Date.now(),
): number {
  const insert = rawDb.prepare(
    `INSERT OR IGNORE INTO research_timeline_snapshots(
      match_id,provider,market,stage,line_key,selection,decimal_odds,is_main,
      source_updated_at,captured_at,target_at,status,origin,source_name,
      source_match_id,source_url
    ) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,'captured',?,?,?,?)`,
  );
  const ensurePoint = rawDb.prepare(
    `INSERT INTO research_timeline_points(
      match_id,stage,target_at,first_captured_at,last_retry_at,captured_at,status,note,created_at,updated_at
    ) VALUES(?,'initial',NULL,NULL,NULL,NULL,'pending',NULL,?,?)
    ON CONFLICT(match_id,stage) DO NOTHING`,
  );
  const updatePoint = rawDb.prepare(
    `UPDATE research_timeline_points
        SET first_captured_at=COALESCE(first_captured_at,?),
            last_retry_at=COALESCE(?,last_retry_at),
            captured_at=COALESCE(captured_at,?),
            status=?,note=?,updated_at=?
      WHERE match_id=? AND stage='initial'`,
  );
  const pointStatus = rawDb.prepare(
    "SELECT status,first_captured_at FROM research_timeline_points WHERE match_id=? AND stage='initial'",
  );
  let inserted = 0;
  rawDb.transaction(() => {
    ensurePoint.run(matchId, capturedAt, capturedAt);
    // Never choose an alternative opening line after a complete pair is
    // already present. Legacy/multi-line source responses are retained and
    // labelled as ambiguous rather than silently selecting a "main" line.
    const frozenLines = new Map<string, Set<string>>();
    for (const quote of opening.quotes) {
      const key = `${quote.provider}|${quote.market}`;
      if (frozenLines.has(key)) continue;
      const complete = existingCompleteInitialLines(matchId, quote.provider, quote.market);
      if (complete.length) frozenLines.set(key, new Set(complete));
    }
    for (const quote of opening.quotes) {
      const lineKey = lineKeyOf(quote.market, quote.lineValue);
      const allowedLines = frozenLines.get(`${quote.provider}|${quote.market}`);
      if (allowedLines && !allowedLines.has(lineKey)) continue;
      inserted += insert.run(
        matchId,
        quote.provider,
        quote.market,
        "initial",
        lineKey,
        quote.selection,
        quote.decimalOdds,
        quote.isMain ? 1 : 0,
        quote.sourceUpdatedAt,
        capturedAt,
        quote.origin,
        quote.sourceName,
        quote.sourceMatchId,
        quote.sourceUrl,
      ).changes;
    }
    // A completed external opening checkpoint, including its capture time and
    // missing-source note, is frozen with the immutable source rows.
    const current = pointStatus.get(matchId) as {
      status: string;
      first_captured_at: number | null;
    } | undefined;
    if (current?.status === "captured") return;
    const complete = initialPairCount(matchId);
    const hasCapturedQuotes = opening.quotes.length > 0;
    const firstCapturedAt = hasCapturedQuotes ? capturedAt : null;
    const retryAt = hasCapturedQuotes && current?.first_captured_at !== null && current?.first_captured_at !== undefined
      ? capturedAt
      : null;
    const baseNote = opening.missing.find((item) => item.provider === "pinnacle" && item.market === "COU")?.note
      ?? PINNACLE_COU_NOTE;
    const ambiguities = initialLineAmbiguities(matchId);
    const note = ambiguities.length
      ? `${baseNote} Ambiguous initial lines retained; no main inferred: ${ambiguities.join(", ")}.`
      : baseNote;
    const expected = expectedPairCount(matchId, "initial");
    updatePoint.run(
      firstCapturedAt,
      retryAt,
      firstCapturedAt,
      complete >= expected ? "captured" : opening.quotes.length ? "partial" : "pending",
      note,
      capturedAt,
      matchId,
    );
  })();
  return inserted;
}

/** Immutable explicit Crown opening; current observations are never accepted here. */
export function saveCrownResearchInitialSnapshots(
  matchId: string,
  titanId: string,
  prices: ProviderPrice[],
  sourceUrls: { AH: string; OU: string },
  capturedAt = Date.now(),
): number {
  const accepted = prices.filter((price) => price.market === "AH" || price.market === "OU");
  if (!accepted.length) return 0;
  const insert = rawDb.prepare(
    `INSERT OR IGNORE INTO research_timeline_snapshots(
      match_id,provider,market,stage,line_key,selection,decimal_odds,is_main,
      source_updated_at,captured_at,target_at,status,origin,source_name,source_match_id,source_url
    ) VALUES(?,'crown',?,'initial',?,?,?,?,?, ?,NULL,'captured','external_opening','titan007-crown',?,?)`,
  );
  const ensurePoint = rawDb.prepare(
    `INSERT INTO research_timeline_points(
      match_id,stage,target_at,first_captured_at,last_retry_at,captured_at,status,note,created_at,updated_at
    ) VALUES(?,'initial',NULL,NULL,NULL,NULL,'pending',NULL,?,?)
    ON CONFLICT(match_id,stage) DO NOTHING`,
  );
  let inserted = 0;
  rawDb.transaction(() => {
    ensurePoint.run(matchId, capturedAt, capturedAt);
    for (const price of accepted) {
      inserted += insert.run(
        matchId,
        price.market,
        lineKeyOf(price.market, price.lineValue),
        price.selection,
        price.decimalOdds,
        price.isMain ? 1 : 0,
        price.sourceUpdatedAt ?? null,
        capturedAt,
        titanId,
        sourceUrls[price.market as "AH" | "OU"],
      ).changes;
    }
    const complete = initialPairCount(matchId);
    const expected = expectedPairCount(matchId, "initial");
    const point = rawDb.prepare(
      "SELECT first_captured_at FROM research_timeline_points WHERE match_id=? AND stage='initial'",
    ).get(matchId) as { first_captured_at: number | null };
    rawDb.prepare(
      `UPDATE research_timeline_points
          SET first_captured_at=COALESCE(first_captured_at,?),
              captured_at=COALESCE(captured_at,?),
              last_retry_at=CASE WHEN first_captured_at IS NULL THEN last_retry_at ELSE ? END,
              status=?,note=?,updated_at=?
        WHERE match_id=? AND stage='initial'`,
    ).run(
      capturedAt,
      capturedAt,
      point.first_captured_at === null ? null : capturedAt,
      complete >= expected ? "captured" : "partial",
      complete >= expected ? null : `${complete}/${expected} provider-market pairs complete`,
      capturedAt,
      matchId,
    );
  })();
  return inserted;
}

/**
 * Isolated opening collection.  It only reads matches and writes research
 * tables; it cannot refresh execution prices, generate opportunities, or place
 * simulations.  Tipsme candidates are matched with the normal ±10-minute,
 * league and team matching rules before any detail request is made.
 */
export async function collectResearchInitialSnapshots(
  provider: ResearchOpeningProvider = new TipsmeOpeningProvider(),
  now = Date.now(),
): Promise<ResearchOpeningCollectionOutcome> {
  const lookbackDays = Math.max(0, Math.min(30, Number(process.env.RADAR_RESEARCH_OPENING_LOOKBACK_DAYS ?? 2) || 2));
  const aheadDays = Math.max(1, Math.min(30, Number(process.env.RADAR_RESEARCH_OPENING_AHEAD_DAYS ?? 7) || 7));
  const candidates = rawDb.prepare(
    `SELECT m.id,m.league,m.home_team,m.away_team,m.kickoff_utc
       FROM matches m
       LEFT JOIN research_timeline_points p
         ON p.match_id=m.id AND p.stage='initial'
      WHERE m.kickoff_utc BETWEEN ? AND ?
        AND m.fixture_source='hkjc'
        AND COALESCE(p.status,'pending')<>'captured'
      ORDER BY m.kickoff_utc
      LIMIT 500`,
  ).all(now - lookbackDays * 24 * 60 * 60_000, now + aheadDays * 24 * 60 * 60_000) as Array<{
    id: string;
    league: string;
    home_team: string;
    away_team: string;
    kickoff_utc: number;
  }>;
  const byDay = new Map<string, typeof candidates>();
  for (const match of candidates) {
    const day = sourceDay(match.kickoff_utc);
    if (!day) continue;
    const rows = byDay.get(day) ?? [];
    rows.push(match);
    byDay.set(day, rows);
  }
  const schedules = new Map<string, TipsmeScheduleEvent[]>();
  for (const day of byDay.keys()) schedules.set(day, await provider.fetchSchedule(day));

  const aliases = researchAliasIndex();
  let matched = 0;
  let fetched = 0;
  let inserted = 0;
  for (const [day, matches] of byDay) {
    const schedule = schedules.get(day) ?? [];
    const scheduleCandidates: CandidateEvent[] = schedule.map((event) => ({
      id: event.sourceMatchId,
      league: event.league,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      kickoffUtc: event.kickoffUtc,
    }));
    for (const match of matches) {
      const decision = matchEvent({
        id: match.id,
        league: match.league,
        homeTeam: match.home_team,
        awayTeam: match.away_team,
        kickoffUtc: match.kickoff_utc,
      }, scheduleCandidates, aliases);
      if (!decision.pinnacleMatchId) continue;
      matched++;
      const opening = await provider.fetchOpening(decision.pinnacleMatchId);
      fetched++;
      inserted += saveResearchInitialSnapshots(match.id, opening, now);
    }
  }
  return { candidates: candidates.length, matched, fetched, inserted };
}

function collectorStatus(): ResearchResultCollectorStatus {
  const lastRunAt = Number(getState("researchResultsLastRunAt"));
  const lastSuccessAt = Number(getState("researchResultsLastSuccessAt"));
  const lastError = getState("researchResultsLastError");
  const lastCollected = Number(getState("researchResultsLastCollected"));
  return {
    enabled: process.env.RADAR_RESEARCH_RESULTS !== "0",
    lastRunAt: Number.isFinite(lastRunAt) && lastRunAt > 0 ? lastRunAt : null,
    lastSuccessAt: Number.isFinite(lastSuccessAt) && lastSuccessAt > 0 ? lastSuccessAt : null,
    lastError: lastError || null,
    lastCollected: Number.isFinite(lastCollected) && lastCollected >= 0 ? lastCollected : 0,
  };
}

export async function collectResearchResults(
  hkjc: HkjcProvider,
  now = Date.now(),
): Promise<{ candidates: number; collected: number }> {
  const configuredLookback = Number(process.env.RADAR_RESEARCH_RESULT_LOOKBACK_DAYS ?? 7);
  const lookbackDays = Number.isFinite(configuredLookback)
    ? Math.max(1, Math.min(MAX_RESULT_LOOKBACK_DAYS, Math.floor(configuredLookback)))
    : 7;
  const hkjcCandidates = rawDb
    .prepare(
      `SELECT m.id, m.hkjc_id, m.kickoff_utc
         FROM matches m
         LEFT JOIN research_results rr ON rr.match_id=m.id
        WHERE rr.match_id IS NULL
          AND m.kickoff_utc<=?
          AND m.kickoff_utc>=?
          AND m.fixture_source='hkjc'
          AND m.hkjc_id IS NOT NULL
        ORDER BY m.kickoff_utc DESC
        LIMIT 500`,
    )
    .all(now - RESULT_DELAY_MS, now - lookbackDays * 24 * 60 * 60_000) as Array<{
    id: string;
    hkjc_id: string;
    kickoff_utc: number;
  }>;

  const candidateCount = hkjcCandidates.length;

  setState("researchResultsLastRunAt", String(now));

  const byDate = new Map<string, typeof hkjcCandidates>();
  for (const candidate of hkjcCandidates) {
    const date = hkjcHktDate(candidate.kickoff_utc);
    if (!date) continue;
    const rows = byDate.get(date) ?? [];
    rows.push(candidate);
    byDate.set(date, rows);
  }

  let collected = 0;
  try {
    if (candidateCount > 0) {
    for (const rows of byDate.values()) {
      const official = await hkjc.fetchHistoricResults(
        rows.map((row) => ({ matchId: row.hkjc_id, kickoffUtc: row.kickoff_utc })),
      );
      const canonicalByHkjc = new Map(rows.map((row) => [row.hkjc_id, row.id]));
      const upsert = rawDb.prepare(
        `INSERT INTO research_results(match_id,hkjc_id,home_score,away_score,corners_total,source,result_source,source_match_id,fetched_at)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(match_id) DO UPDATE SET home_score=excluded.home_score,
           away_score=excluded.away_score,corners_total=excluded.corners_total,
           source=excluded.source,result_source=excluded.result_source,
           source_match_id=excluded.source_match_id,fetched_at=excluded.fetched_at`,
      );
      const tx = rawDb.transaction(() => {
        for (const result of official) {
          const matchId = canonicalByHkjc.get(result.matchId);
          if (!matchId) continue;
          upsert.run(
            matchId,
            result.matchId,
            result.homeScore,
            result.awayScore,
            result.cornersTotal,
            result.source,
            "hkjc",
            result.matchId,
            now,
          );
          collected++;
        }
      });
      tx();
    }
    }
    // titan007 fallback：非 HKJC 場（fixture_source != 'hkjc'）用 matches.titan_id
    // 對 http://bf.titan007.com/football/Over_YYYYMMDD.htm 每日一頁攞比分。
    let titanCandidateCount = 0;
    let titanCollected = 0;
    try {
      const titanCandidates = rawDb
        .prepare(
          `SELECT m.id, m.titan_id, m.kickoff_utc
             FROM matches m
             LEFT JOIN research_results rr ON rr.match_id=m.id
            WHERE rr.match_id IS NULL
              AND m.kickoff_utc<=?
              AND m.kickoff_utc>=?
              AND m.fixture_source!='hkjc'
              AND m.titan_id IS NOT NULL
            ORDER BY m.kickoff_utc DESC
            LIMIT 1000`,
        )
        .all(now - RESULT_DELAY_MS, now - lookbackDays * 24 * 60 * 60_000) as Array<{
        id: string;
        titan_id: string;
        kickoff_utc: number;
      }>;
      titanCandidateCount = titanCandidates.length;

      if (titanCandidateCount > 0) {
        // 用開賽日期（HKT）去分頁
        const titanByDate = new Map<string, typeof titanCandidates>();
        for (const candidate of titanCandidates) {
          const key = titanHktYyyymmdd(candidate.kickoff_utc);
          const rows = titanByDate.get(key) ?? [];
          rows.push(candidate);
          titanByDate.set(key, rows);
        }

        const titanBase = process.env.TITAN_BF_BASE ?? "http://bf.titan007.com/football";
        const titanUpsert = rawDb.prepare(
          `INSERT INTO research_results(match_id,hkjc_id,home_score,away_score,corners_total,source,result_source,source_match_id,fetched_at)
           VALUES(?,?,?,?,?,?,?,?,?)
           ON CONFLICT(match_id) DO UPDATE SET home_score=excluded.home_score,
             away_score=excluded.away_score,corners_total=excluded.corners_total,
             source=excluded.source,result_source=excluded.result_source,
             source_match_id=excluded.source_match_id,fetched_at=excluded.fetched_at`,
        );

        for (const [yyyymmdd, rows] of titanByDate.entries()) {
          try {
            // titan007：已完場包在 Over_ 及 Next_ 兩頁。當日/前一日場常在 Next_ 頁
            //           （Over_ 只有已命名雷場時已採集完成）。兩頁先 Over_ 後 Next_ 都試。
            const byTitanId = new Map<string, ReturnType<typeof parseSchedulePage>[number]>();
            for (const kind of ["Over", "Next"] as const) {
              try {
                const html = await fetchText(`${titanBase}/${kind}_${yyyymmdd}.htm`, {
                  charset: "gb18030",
                  timeoutMs: 25_000,
                  retries: 1,
                });
                const fixtures = parseSchedulePage(html, yyyymmdd);
                for (const f of fixtures) {
                  const existing = byTitanId.get(f.providerMatchId);
                  // 只保留有分數那份；Over_ 優先，但如果 Over_ 沒分而 Next_ 有分就換。
                  const fHasScore = f.homeScore !== null && f.awayScore !== null;
                  const existingHasScore = existing !== undefined
                    && existing.homeScore !== null
                    && existing.awayScore !== null;
                  if (!existing || (!existingHasScore && fHasScore)) {
                    byTitanId.set(f.providerMatchId, f);
                  }
                }
              } catch {
                // 喺一頁 404 不影響另一頁
              }
            }
            const tx = rawDb.transaction(() => {
              for (const row of rows) {
                const fixture = byTitanId.get(row.titan_id);
                if (!fixture) continue;
                if (fixture.homeScore === null || fixture.awayScore === null) continue;
                titanUpsert.run(
                  row.id,
                  null,
                  fixture.homeScore,
                  fixture.awayScore,
                  null,
                  "titan007",
                  "titan007",
                  row.titan_id,
                  now,
                );
                titanCollected++;
              }
            });
            tx();
          } catch (err) {
            console.error(JSON.stringify({
              ts: new Date().toISOString(),
              scope: "radar",
              event: "research_results_titan_error",
              yyyymmdd,
              rows: rows.length,
              error: (err as Error).message,
            }));
          }
        }
      }
    } catch (err) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "research_results_titan_fatal",
        error: (err as Error).message,
      }));
    }

    const totalCollected = collected + titanCollected;
    setState("researchResultsLastSuccessAt", String(now));
    setState("researchResultsLastCollected", String(totalCollected));
    setState("researchResultsLastError", "");
    return { candidates: candidateCount + titanCandidateCount, collected: totalCollected };
  } catch (error) {
    setState("researchResultsLastError", (error as Error).message);
    throw error;
  }
}

/** HKT YYYYMMDD (kickoff 當日) for titan007 Over_ page keys. */
function titanHktYyyymmdd(utcMs: number): string {
  const hkt = new Date(utcMs + 8 * 3600 * 1000);
  const y = hkt.getUTCFullYear();
  const m = String(hkt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(hkt.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function windowBounds(filters: ResearchFilters, now: number): { lo: number; hi: number } {
  if (filters.window === "upcoming") {
    // Rolling window: anchor at "now" and reach forward by horizonDays.  Any
    // fixture that has already kicked off is excluded from the view but stays
    // in the database for later research.
    return { lo: now, hi: now + filters.horizonDays * 24 * 60 * 60_000 };
  }
  if (filters.window === "finished") {
    // Look back by `days` and stop at "now" so the finished view only surfaces
    // fixtures that have already kicked off.
    return { lo: now - filters.days * 24 * 60 * 60_000, hi: now };
  }
  // Legacy "all" window preserves the pre-rolling behaviour used by callers
  // that still pass only a `days` parameter.
  return {
    lo: now - filters.days * 24 * 60 * 60_000,
    hi: now + FALLBACK_UPCOMING_HORIZON_MS,
  };
}

function filterSql(filters: ResearchFilters, now: number): { clause: string; params: unknown[] } {
  const bounds = windowBounds(filters, now);
  const clauses = [
    "m.fixture_source IN ('hkjc','pinnacle')",
    "q.provider IN ('hkjc','pinnacle')",
    "m.kickoff_utc>=?",
    "m.kickoff_utc<=?",
    "(m.fixture_source='hkjc' OR m.titan_id IS NOT NULL OR m.kickoff_utc<?)",
  ];
  const params: unknown[] = [bounds.lo, bounds.hi, now];
  if (filters.provider !== "all") {
    clauses.push("q.provider=?");
    params.push(filters.provider);
  }
  if (filters.market !== "all") {
    clauses.push("q.market=?");
    params.push(filters.market);
  }
  return { clause: clauses.join(" AND "), params };
}

/**
 * Dataset rows may exist because a timeline was captured or because an
 * official result was collected.  Provider/market filters still require a
 * matching quote, but the unfiltered view must not hide result-only matches.
 */
function matchFilterSql(filters: ResearchFilters, now: number): { clause: string; params: unknown[] } {
  const bounds = windowBounds(filters, now);
  const clauses = [
    "m.fixture_source IN ('hkjc','pinnacle')",
    "m.kickoff_utc>=?",
    "m.kickoff_utc<=?",
    "(m.fixture_source='hkjc' OR m.titan_id IS NOT NULL OR m.kickoff_utc<?)",
  ];
  const params: unknown[] = [bounds.lo, bounds.hi, now];
  if (filters.provider !== "all") {
    // A directly discovered Titan/Pinnacle fixture must remain visible while
    // its first quote is pending; filtering on the LEFT JOIN alone used to
    // hide the whole fixture until collection had already succeeded.
    clauses.push(filters.provider === "pinnacle"
      ? "(q.provider=? OR m.fixture_source='pinnacle')"
      : "q.provider=?");
    params.push(filters.provider);
  }
  if (filters.market !== "all") {
    clauses.push("(q.market=? OR m.fixture_source='pinnacle')");
    params.push(filters.market);
  }
  // Both HKJC and direct Titan fixtures remain visible before capture. The
  // timeline cells tell the truth as pending/missing/source-unavailable; the
  // UI must not silently remove discovered fixtures merely because a provider
  // request is still queued, slow or temporarily unavailable.
  clauses.push(
    "(q.id IS NOT NULL OR rr.match_id IS NOT NULL OR r.match_id IS NOT NULL OR m.fixture_source IN ('hkjc','pinnacle'))",
  );
  return { clause: clauses.join(" AND "), params };
}

function timelineStatus(
  stage: ResearchStage,
  kickoffUtc: number,
  now: number,
  quotes: ResearchTimelineQuote[],
  recordedStatus?: string,
): "captured" | "partial" | "pending" | "missing" {
  if (recordedStatus === "captured") return "captured";
  if (recordedStatus === "partial" || quotes.length) return "partial";
  const targetAt = stageTargetAt(stage, kickoffUtc);
  // The opening checkpoint has no fixed deadline: it is backfilled from an
  // external source and may arrive after kickoff, so an empty opening stays
  // "pending" (awaiting collection) instead of being reported as missing.
  if (stage === "initial") return "pending";
  return targetAt !== null && now < targetAt ? "pending" : "missing";
}

function researchCellStatus(
  stage: ResearchStage,
  provider: ResearchProvider,
  market: ResearchMarket,
  snapshotStatus: ResearchStageSnapshot["status"],
  stageQuotes: ResearchTimelineQuote[],
  targetAt: number | null,
  firstCapturedAt: number | null,
  collectionStartedAt: number | null,
  fixtureSource: "hkjc" | "pinnacle" | "crown",
  titanId: string | null,
): ResearchStageSnapshot["cells"][ResearchProvider][ResearchMarket] {
  const pairQuotes = stageQuotes.filter((quote) => quote.provider === provider && quote.market === market);
  if (pairQuotes.length >= 2) return "captured";
  if (pairQuotes.length > 0) return "partial";
  if (fixtureSource === "crown" && provider !== "crown") return "source_unavailable";
  // Pinnacle-only fixtures have no HKJC or Crown counterpart, and their
  // initial checkpoint has no external Tipsme opening.
  if (fixtureSource === "pinnacle" && provider !== "pinnacle") return "source_unavailable";
  if (provider === "crown" && (market === "COU" || titanId === null)) return "source_unavailable";
  if (stage === "initial" && provider === "pinnacle" && market === "COU") return "source_unavailable";
  if (snapshotStatus === "pending") return "pending";
  if (stage === "initial") return firstCapturedAt ? "market_unavailable" : "match_unmatched";
  if (targetAt !== null && collectionStartedAt !== null && targetAt < collectionStartedAt) {
    return "historical_unavailable";
  }
  return firstCapturedAt ? "market_unavailable" : "checkpoint_missed";
}

export function researchDataset(
  rawFilters: Partial<ResearchFilters> & Pick<ResearchFilters, "days" | "provider" | "market">,
  now = Date.now(),
): ResearchDatasetResponse {
  const filters = normalizeFilters(rawFilters);
  const { clause, params } = filterSql(filters, now);
  const { clause: matchClause, params: matchParams } = matchFilterSql(filters, now);
  const summary = rawDb
    .prepare(
      `SELECT COUNT(*) snapshots,COUNT(DISTINCT q.match_id) matches,
              MIN(q.captured_at) first_snapshot_at,MAX(q.captured_at) last_snapshot_at
         FROM research_timeline_snapshots q
         JOIN matches m ON m.id=q.match_id
        WHERE ${clause}`,
    )
    .get(...params) as {
    snapshots: number;
    matches: number;
    first_snapshot_at: number | null;
    last_snapshot_at: number | null;
  };
  const collection = rawDb
    .prepare(
      `SELECT MIN(COALESCE(first_captured_at,created_at)) collection_started_at
         FROM research_timeline_points`,
    )
    .get() as { collection_started_at: number | null };
  const collectionStartedAt = collection.collection_started_at === null
    ? null
    : Number(collection.collection_started_at);
  const providerCounts = rawDb
    .prepare(
      `SELECT q.provider name,COUNT(*) count
         FROM research_timeline_snapshots q JOIN matches m ON m.id=q.match_id
        WHERE ${clause} GROUP BY q.provider`,
    )
    .all(...params) as Array<{ name: ResearchProvider; count: number }>;
  const marketCounts = rawDb
    .prepare(
      `SELECT q.market name,COUNT(*) count
         FROM research_timeline_snapshots q JOIN matches m ON m.id=q.match_id
        WHERE ${clause} GROUP BY q.market`,
    )
    .all(...params) as Array<{ name: "AH" | "OU" | "COU"; count: number }>;
  const trackedMatches = rawDb
    .prepare(
      `SELECT COUNT(DISTINCT m.id) count
         FROM matches m
         LEFT JOIN research_timeline_snapshots q ON q.match_id=m.id
         LEFT JOIN research_results rr ON rr.match_id=m.id
         LEFT JOIN results r ON r.match_id=m.id
        WHERE ${matchClause}`,
    )
    .get(...matchParams) as { count: number };
  const stageCoverage = RESEARCH_STAGES.map((stage) => {
    const row = rawDb
      .prepare(
        `SELECT COUNT(DISTINCT q.match_id) count
           FROM research_timeline_snapshots q
           JOIN matches m ON m.id=q.match_id
           JOIN research_timeline_points p ON p.match_id=q.match_id AND p.stage=q.stage
          WHERE ${clause} AND q.stage=? AND p.status='captured'`,
      )
      .get(...params, stage) as { count: number };
    return { stage, capturedMatches: row.count ?? 0, totalMatches: trackedMatches.count ?? 0 };
  });
  const coverage = rawDb
    .prepare(
      `SELECT COUNT(DISTINCT CASE WHEN m.kickoff_utc<=? THEN m.id END) eligible,
              COUNT(DISTINCT CASE WHEN m.kickoff_utc<=? AND
                (rr.match_id IS NOT NULL OR r.match_id IS NOT NULL) THEN m.id END) completed
         FROM matches m
         LEFT JOIN research_timeline_snapshots q ON q.match_id=m.id
         LEFT JOIN research_results rr ON rr.match_id=m.id
         LEFT JOIN results r ON r.match_id=m.id
        WHERE ${matchClause}`,
    )
    .get(now - RESULT_DELAY_MS, now - RESULT_DELAY_MS, ...matchParams) as {
    eligible: number;
    completed: number;
  };
  const matchRows = rawDb
    .prepare(
      `SELECT m.id match_id,m.hkjc_id,m.fixture_source,m.titan_id,
              CASE WHEN m.fixture_source='pinnacle' AND m.titan_id IS NULL AND pt.zh_league IS NOT NULL THEN pt.zh_league ELSE m.league END league,
              CASE WHEN m.fixture_source='pinnacle' AND m.titan_id IS NULL AND pt.zh_home IS NOT NULL THEN pt.zh_home ELSE m.home_team END home_team,
              CASE WHEN m.fixture_source='pinnacle' AND m.titan_id IS NULL AND pt.zh_away IS NOT NULL THEN pt.zh_away ELSE m.away_team END away_team,
              m.kickoff_utc,
              COUNT(q.id) snapshot_count,MIN(q.captured_at) first_snapshot_at,
              MAX(q.captured_at) last_snapshot_at,
              COALESCE(rr.home_score,r.home_score) home_score,
              COALESCE(rr.away_score,r.away_score) away_score,
              COALESCE(rr.corners_total,r.corners_total) corners_total,
              COALESCE(rr.source,r.source) result_source,
              COALESCE(rr.fetched_at,r.fetched_at) result_fetched_at
         FROM matches m
         LEFT JOIN pinnacle_translations pt
           ON m.fixture_source='pinnacle' AND pt.pinnapi_id=SUBSTR(m.id,10)
         LEFT JOIN research_timeline_snapshots q ON q.match_id=m.id
         LEFT JOIN research_results rr ON rr.match_id=m.id
         LEFT JOIN results r ON r.match_id=m.id
        WHERE ${matchClause}
        GROUP BY m.id
        ORDER BY m.kickoff_utc ${filters.window === "upcoming" ? "ASC" : "DESC"}
        LIMIT ${filters.limit}`,
    )
    .all(...matchParams) as Array<Record<string, unknown>>;

  const matchIds = matchRows.map((row) => String(row.match_id));
  const quoteRows = matchIds.length
    ? (rawDb
        .prepare(
          `SELECT q.match_id,q.provider,q.market,q.stage,q.line_key,q.selection,
                  q.decimal_odds,q.is_main,q.source_updated_at,q.captured_at,q.target_at,
                  q.origin,q.source_name,q.source_match_id,q.source_url
             FROM research_timeline_snapshots q
            WHERE q.match_id IN (${matchIds.map(() => "?").join(",")})
              AND q.provider IN ('hkjc','pinnacle')
              ${filters.provider === "all" ? "" : "AND q.provider=?"}
              ${filters.market === "all" ? "" : "AND q.market=?"}
            ORDER BY q.match_id,q.stage,q.provider,q.market,q.is_main DESC,q.line_key,q.selection`,
        )
        .all(
          ...matchIds,
          ...(filters.provider === "all" ? [] : [filters.provider]),
          ...(filters.market === "all" ? [] : [filters.market]),
        ) as Array<Record<string, unknown>>)
    : [];
  const quotesByMatch = new Map<string, ResearchTimelineQuote[]>();
  for (const row of quoteRows) {
    const matchId = String(row.match_id);
    const quotes = quotesByMatch.get(matchId) ?? [];
    quotes.push({
      provider: String(row.provider) as ResearchProvider,
      market: String(row.market) as "AH" | "OU" | "COU",
      stage: String(row.stage) as ResearchStage,
      lineKey: String(row.line_key),
      selection: String(row.selection),
      decimalOdds: Number(row.decimal_odds),
      isMain: Boolean(row.is_main),
      sourceUpdatedAt: row.source_updated_at === null ? null : Number(row.source_updated_at),
      capturedAt: Number(row.captured_at),
      targetAt: row.target_at === null ? null : Number(row.target_at),
      origin: String(row.origin ?? "legacy_live_observation"),
      sourceName: row.source_name === null || row.source_name === undefined ? null : String(row.source_name),
      sourceMatchId: row.source_match_id === null || row.source_match_id === undefined ? null : String(row.source_match_id),
      sourceUrl: row.source_url === null || row.source_url === undefined ? null : String(row.source_url),
    });
    quotesByMatch.set(matchId, quotes);
  }
  const pointRows = matchIds.length
    ? rawDb.prepare(
        `SELECT match_id,stage,status,first_captured_at,last_retry_at,captured_at,target_at,note
           FROM research_timeline_points
          WHERE match_id IN (${matchIds.map(() => "?").join(",")})`,
      ).all(...matchIds) as Array<Record<string, unknown>>
    : [];
  const pointsByMatch = new Map<string, Map<ResearchStage, Record<string, unknown>>>();
  for (const point of pointRows) {
    const matchId = String(point.match_id);
    const points = pointsByMatch.get(matchId) ?? new Map();
    points.set(String(point.stage) as ResearchStage, point);
    pointsByMatch.set(matchId, points);
  }

  return {
    generatedAt: now,
    filters,
    summary: {
      snapshots: summary.snapshots ?? 0,
      matches: trackedMatches.count ?? 0,
      completedResults: coverage.completed ?? 0,
      resultEligibleMatches: coverage.eligible ?? 0,
      firstSnapshotAt: summary.first_snapshot_at,
      lastSnapshotAt: summary.last_snapshot_at,
      collectionStartedAt,
      providerCounts,
      marketCounts,
      stageCoverage,
    },
    collector: collectorStatus(),
    matches: matchRows.map((row): ResearchMatchRow => {
      const matchId = String(row.match_id);
      const kickoffUtc = Number(row.kickoff_utc);
      const quotes = quotesByMatch.get(matchId) ?? [];
      const fixtureSource = String(row.fixture_source) as "hkjc" | "pinnacle" | "crown";
      const hkjcId = row.hkjc_id === null || row.hkjc_id === undefined ? null : String(row.hkjc_id);
      const titanId = row.titan_id === null || row.titan_id === undefined ? null : String(row.titan_id);
      return {
        matchId,
        fixtureKey: titanId
          ? `titan:${titanId}`
          : fixtureSource === "pinnacle"
            ? `pinnacle:${matchId.replace(/^pinnacle:/, "")}`
            : `hkjc:${hkjcId ?? matchId}`,
        fixtureSource,
        hkjcId,
        titanId,
        league: String(row.league),
        homeTeam: String(row.home_team),
        awayTeam: String(row.away_team),
        kickoffUtc,
        snapshotCount: Number(row.snapshot_count),
        firstSnapshotAt: row.first_snapshot_at === null ? null : Number(row.first_snapshot_at),
        lastSnapshotAt: row.last_snapshot_at === null ? null : Number(row.last_snapshot_at),
        timeline: Object.fromEntries(
          RESEARCH_STAGES.map((stage) => {
            const stageQuotes = quotes.filter((quote) => quote.stage === stage);
            const point = pointsByMatch.get(matchId)?.get(stage);
            const firstCapturedAt = point?.first_captured_at === null || point?.first_captured_at === undefined
              ? (stageQuotes.length
                  ? Math.min(...stageQuotes.map((quote) => quote.capturedAt))
                  : point?.captured_at === null || point?.captured_at === undefined
                    ? null
                    : Number(point.captured_at))
              : Number(point.first_captured_at);
            const lastRetryAt = point?.last_retry_at === null || point?.last_retry_at === undefined
              ? null
              : Number(point.last_retry_at);
            const targetAt = point?.target_at === null || point?.target_at === undefined
              ? stageTargetAt(stage, kickoffUtc)
              : Number(point.target_at);
            const status = timelineStatus(stage, kickoffUtc, now, stageQuotes, String(point?.status ?? ""));
            const cells = Object.fromEntries(
              RESEARCH_PROVIDERS.map((provider) => [
                provider,
                Object.fromEntries(
                  RESEARCH_MARKETS.map((market) => [
                    market,
                    researchCellStatus(
                      stage,
                      provider,
                      market,
                      status,
                      stageQuotes,
                      targetAt,
                      firstCapturedAt,
                      collectionStartedAt,
                      fixtureSource,
                      titanId,
                    ),
                  ]),
                ),
              ]),
            ) as ResearchStageSnapshot["cells"];
            return [
              stage,
              {
                stage,
                status,
                targetAt,
                firstCapturedAt,
                lastRetryAt,
                capturedAt: firstCapturedAt,
                note: point?.note === null || point?.note === undefined ? null : String(point.note),
                quotes: stageQuotes,
                cells,
              },
            ];
          }),
        ) as ResearchMatchRow["timeline"],
        result:
          row.home_score === null || row.home_score === undefined
            ? null
            : {
                homeScore: Number(row.home_score),
                awayScore: Number(row.away_score),
                cornersTotal: row.corners_total === null ? null : Number(row.corners_total),
                source: String(row.result_source),
                fetchedAt: Number(row.result_fetched_at),
              },
      };
    }),
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return `\ufeff${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function researchCsv(
  kind: "timeline" | "results",
  rawFilters: Partial<ResearchFilters> & Pick<ResearchFilters, "days" | "provider" | "market">,
  now = Date.now(),
): string {
  const filters = normalizeFilters(rawFilters);
  const { clause, params } = filterSql(filters, now);
  if (kind === "results") {
    const { clause: matchClause, params: matchParams } = matchFilterSql(filters, now);
    const rows = rawDb
      .prepare(
        `SELECT DISTINCT m.id,m.hkjc_id,m.fixture_source,m.titan_id,
                CASE WHEN m.titan_id IS NOT NULL THEN 'titan:'||m.titan_id ELSE 'hkjc:'||m.hkjc_id END fixture_key,
                CASE WHEN m.fixture_source='pinnacle' AND m.titan_id IS NULL AND pt.zh_league IS NOT NULL THEN pt.zh_league ELSE m.league END league,
                CASE WHEN m.fixture_source='pinnacle' AND m.titan_id IS NULL AND pt.zh_home IS NOT NULL THEN pt.zh_home ELSE m.home_team END home_team,
                CASE WHEN m.fixture_source='pinnacle' AND m.titan_id IS NULL AND pt.zh_away IS NOT NULL THEN pt.zh_away ELSE m.away_team END away_team,
                m.kickoff_utc,
                COALESCE(rr.home_score,r.home_score) home_score,
                COALESCE(rr.away_score,r.away_score) away_score,
                COALESCE(rr.corners_total,r.corners_total) corners_total,
                COALESCE(rr.source,r.source) source,
                COALESCE(rr.result_source,rr.source,r.source) result_source,
                rr.source_match_id,
                COALESCE(rr.fetched_at,r.fetched_at) fetched_at
           FROM matches m
           LEFT JOIN pinnacle_translations pt
             ON m.fixture_source='pinnacle' AND pt.pinnapi_id=SUBSTR(m.id,10)
           LEFT JOIN research_timeline_snapshots q ON q.match_id=m.id
           LEFT JOIN research_results rr ON rr.match_id=m.id
           LEFT JOIN results r ON r.match_id=m.id
          WHERE ${matchClause}
            AND (rr.match_id IS NOT NULL OR r.match_id IS NOT NULL)
          ORDER BY m.kickoff_utc DESC LIMIT ?`,
      )
      .all(...matchParams, MAX_EXPORT_ROWS) as Array<Record<string, unknown>>;
    return toCsv(
      ["fixture_key", "match_id", "fixture_source", "titan_id", "hkjc_id", "league", "home_team", "away_team", "kickoff_utc", "home_score", "away_score", "corners_total", "source", "result_source", "source_match_id", "fetched_at"],
      rows.map((row) => [
        row.fixture_key,
        row.id,
        row.fixture_source,
        row.titan_id,
        row.hkjc_id,
        row.league,
        row.home_team,
        row.away_team,
        row.kickoff_utc,
        row.home_score,
        row.away_score,
        row.corners_total,
        row.source,
        row.result_source,
        row.source_match_id,
        row.fetched_at,
      ]),
    );
  }

  const rows = rawDb
    .prepare(
      `SELECT q.id,q.match_id,m.hkjc_id,m.fixture_source,m.titan_id,
              CASE WHEN m.titan_id IS NOT NULL THEN 'titan:'||m.titan_id ELSE 'hkjc:'||m.hkjc_id END fixture_key,
              CASE WHEN m.fixture_source='pinnacle' AND m.titan_id IS NULL AND pt.zh_league IS NOT NULL THEN pt.zh_league ELSE m.league END league,
              CASE WHEN m.fixture_source='pinnacle' AND m.titan_id IS NULL AND pt.zh_home IS NOT NULL THEN pt.zh_home ELSE m.home_team END home_team,
              CASE WHEN m.fixture_source='pinnacle' AND m.titan_id IS NULL AND pt.zh_away IS NOT NULL THEN pt.zh_away ELSE m.away_team END away_team,
              m.kickoff_utc,
              q.provider,q.market,q.stage,q.target_at,q.line_key,q.selection,q.decimal_odds,
              q.is_main,q.source_updated_at,q.captured_at,p.first_captured_at,p.last_retry_at,
              q.status,q.origin,q.source_name,
              q.source_match_id,q.source_url
         FROM research_timeline_snapshots q
         JOIN matches m ON m.id=q.match_id
         LEFT JOIN pinnacle_translations pt
           ON m.fixture_source='pinnacle' AND pt.pinnapi_id=SUBSTR(m.id,10)
         LEFT JOIN research_timeline_points p ON p.match_id=q.match_id AND p.stage=q.stage
        WHERE ${clause}
        ORDER BY m.kickoff_utc DESC,q.stage,q.provider,q.market,q.line_key,q.selection
        LIMIT ?`,
    )
    .all(...params, MAX_EXPORT_ROWS) as Array<Record<string, unknown>>;
  return toCsv(
    ["id", "fixture_key", "match_id", "fixture_source", "titan_id", "hkjc_id", "league", "home_team", "away_team", "kickoff_utc", "provider", "market", "stage", "target_at", "line_key", "selection", "decimal_odds", "is_main", "source_updated_at", "captured_at", "first_captured_at", "last_retry_at", "status", "origin", "source_name", "source_match_id", "source_url"],
    rows.map((row) => [
      row.id,
      row.fixture_key,
      row.match_id,
      row.fixture_source,
      row.titan_id,
      row.hkjc_id,
      row.league,
      row.home_team,
      row.away_team,
      row.kickoff_utc,
      row.provider,
      row.market,
      row.stage,
      row.target_at,
      row.line_key,
      row.selection,
      row.decimal_odds,
      row.is_main,
      row.source_updated_at,
      row.captured_at,
      row.first_captured_at,
      row.last_retry_at,
      row.status,
      row.origin,
      row.source_name,
      row.source_match_id,
      row.source_url,
    ]),
  );
}
