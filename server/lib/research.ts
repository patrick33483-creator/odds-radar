import type { HkjcProvider } from "../providers/hkjc";
import { hkjcHktDate } from "../providers/hkjc";
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
  ResearchMatchRow,
  ResearchResultCollectorStatus,
  ResearchStage,
  ResearchTimelineQuote,
} from "@shared/types";

const RESULT_DELAY_MS = 105 * 60_000;
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 120;
const MAX_RESULT_LOOKBACK_DAYS = 30;
const MAX_EXPORT_ROWS = 100_000;
const RESEARCH_MARKETS = ["AH", "OU", "COU"] as const;
const RESEARCH_PROVIDERS = ["hkjc", "pinnacle"] as const;
export const RESEARCH_STAGES: ResearchStage[] = ["initial", "T30", "T15", "T5"];

export interface ResearchFilters {
  days: number;
  provider: "hkjc" | "pinnacle" | "all";
  market: "AH" | "OU" | "COU" | "all";
}

function boundedDays(value: unknown, fallback = DEFAULT_LOOKBACK_DAYS): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(MAX_LOOKBACK_DAYS, Math.floor(parsed)))
    : fallback;
}

export function parseResearchFilters(query: Record<string, unknown>): ResearchFilters {
  const provider = RESEARCH_PROVIDERS.includes(String(query.provider) as (typeof RESEARCH_PROVIDERS)[number])
    ? (String(query.provider) as "hkjc" | "pinnacle")
    : "all";
  const market = RESEARCH_MARKETS.includes(String(query.market) as (typeof RESEARCH_MARKETS)[number])
    ? (String(query.market) as "AH" | "OU" | "COU")
    : "all";
  return { days: boundedDays(query.days), provider, market };
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
  if (provider === "crown") return 0;
  const accepted = prices.filter((price) =>
    RESEARCH_MARKETS.includes(price.market as (typeof RESEARCH_MARKETS)[number]),
  );
  if (!accepted.length) return 0;

  const milestone = researchStageFor(kickoffUtc, observedAt);
  // Opening is a distinct external historical source.  A first observation
  // from the live timeline must never be relabelled as an opening price.
  const stages: ResearchStage[] = milestone ? [milestone] : [];
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
      const status = complete >= RESEARCH_MARKETS.length * RESEARCH_PROVIDERS.length ? "captured" : "partial";
      const note = status === "captured" ? null : `${complete}/6 provider-market pairs complete`;
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
    for (const quote of opening.quotes) {
      inserted += insert.run(
        matchId,
        quote.provider,
        quote.market,
        "initial",
        lineKeyOf(quote.market, quote.lineValue),
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
    const note = opening.missing.find((item) => item.provider === "pinnacle" && item.market === "COU")?.note
      ?? PINNACLE_COU_NOTE;
    updatePoint.run(
      firstCapturedAt,
      retryAt,
      firstCapturedAt,
      complete >= INITIAL_AVAILABLE_PAIRS ? "captured" : opening.quotes.length ? "partial" : "pending",
      note,
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
  const candidates = rawDb
    .prepare(
      `SELECT m.id, m.hkjc_id, m.kickoff_utc
         FROM matches m
         LEFT JOIN research_results rr ON rr.match_id=m.id
        WHERE rr.match_id IS NULL
          AND m.kickoff_utc<=?
          AND m.kickoff_utc>=?
        ORDER BY m.kickoff_utc DESC
        LIMIT 500`,
    )
    .all(now - RESULT_DELAY_MS, now - lookbackDays * 24 * 60 * 60_000) as Array<{
    id: string;
    hkjc_id: string;
    kickoff_utc: number;
  }>;

  setState("researchResultsLastRunAt", String(now));
  if (!candidates.length) {
    setState("researchResultsLastSuccessAt", String(now));
    setState("researchResultsLastCollected", "0");
    setState("researchResultsLastError", "");
    return { candidates: 0, collected: 0 };
  }

  const byDate = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const date = hkjcHktDate(candidate.kickoff_utc);
    if (!date) continue;
    const rows = byDate.get(date) ?? [];
    rows.push(candidate);
    byDate.set(date, rows);
  }

  let collected = 0;
  try {
    for (const rows of byDate.values()) {
      const official = await hkjc.fetchHistoricResults(
        rows.map((row) => ({ matchId: row.hkjc_id, kickoffUtc: row.kickoff_utc })),
      );
      const canonicalByHkjc = new Map(rows.map((row) => [row.hkjc_id, row.id]));
      const upsert = rawDb.prepare(
        `INSERT INTO research_results(match_id,hkjc_id,home_score,away_score,corners_total,source,fetched_at)
         VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(match_id) DO UPDATE SET home_score=excluded.home_score,
           away_score=excluded.away_score,corners_total=excluded.corners_total,
           source=excluded.source,fetched_at=excluded.fetched_at`,
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
            now,
          );
          collected++;
        }
      });
      tx();
    }
    setState("researchResultsLastSuccessAt", String(now));
    setState("researchResultsLastCollected", String(collected));
    setState("researchResultsLastError", "");
    return { candidates: candidates.length, collected };
  } catch (error) {
    setState("researchResultsLastError", (error as Error).message);
    throw error;
  }
}

function filterSql(filters: ResearchFilters, now: number): { clause: string; params: unknown[] } {
  const clauses = ["m.kickoff_utc>=?", "m.kickoff_utc<=?"];
  const params: unknown[] = [now - filters.days * 24 * 60 * 60_000, now + 7 * 24 * 60 * 60_000];
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
  const clauses = ["m.kickoff_utc>=?", "m.kickoff_utc<=?"];
  const params: unknown[] = [now - filters.days * 24 * 60 * 60_000, now + 7 * 24 * 60 * 60_000];
  if (filters.provider !== "all") {
    clauses.push("q.provider=?");
    params.push(filters.provider);
  }
  if (filters.market !== "all") {
    clauses.push("q.market=?");
    params.push(filters.market);
  }
  clauses.push("(q.id IS NOT NULL OR rr.match_id IS NOT NULL OR r.match_id IS NOT NULL)");
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
  if (stage === "initial") return kickoffUtc > now ? "pending" : "missing";
  return targetAt !== null && now < targetAt ? "pending" : "missing";
}

export function researchDataset(filters: ResearchFilters, now = Date.now()): ResearchDatasetResponse {
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
  const providerCounts = rawDb
    .prepare(
      `SELECT q.provider name,COUNT(*) count
         FROM research_timeline_snapshots q JOIN matches m ON m.id=q.match_id
        WHERE ${clause} GROUP BY q.provider`,
    )
    .all(...params) as Array<{ name: "hkjc" | "pinnacle"; count: number }>;
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
      `SELECT m.id match_id,m.league,m.home_team,m.away_team,m.kickoff_utc,
              COUNT(q.id) snapshot_count,MIN(q.captured_at) first_snapshot_at,
              MAX(q.captured_at) last_snapshot_at,
              COALESCE(rr.home_score,r.home_score) home_score,
              COALESCE(rr.away_score,r.away_score) away_score,
              COALESCE(rr.corners_total,r.corners_total) corners_total,
              COALESCE(rr.source,r.source) result_source,
              COALESCE(rr.fetched_at,r.fetched_at) result_fetched_at
         FROM matches m
         LEFT JOIN research_timeline_snapshots q ON q.match_id=m.id
         LEFT JOIN research_results rr ON rr.match_id=m.id
         LEFT JOIN results r ON r.match_id=m.id
        WHERE ${matchClause}
        GROUP BY m.id
        ORDER BY m.kickoff_utc DESC
        LIMIT 300`,
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
      provider: String(row.provider) as "hkjc" | "pinnacle",
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
      providerCounts,
      marketCounts,
      stageCoverage,
    },
    collector: collectorStatus(),
    matches: matchRows.map((row): ResearchMatchRow => {
      const matchId = String(row.match_id);
      const kickoffUtc = Number(row.kickoff_utc);
      const quotes = quotesByMatch.get(matchId) ?? [];
      return {
        matchId,
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
            return [
              stage,
              {
                stage,
                status: timelineStatus(stage, kickoffUtc, now, stageQuotes, String(point?.status ?? "")),
                targetAt: point?.target_at === null || point?.target_at === undefined
                  ? stageTargetAt(stage, kickoffUtc)
                  : Number(point.target_at),
                firstCapturedAt,
                lastRetryAt,
                capturedAt: firstCapturedAt,
                note: point?.note === null || point?.note === undefined ? null : String(point.note),
                quotes: stageQuotes,
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

export function researchCsv(kind: "timeline" | "results", filters: ResearchFilters, now = Date.now()): string {
  const { clause, params } = filterSql(filters, now);
  if (kind === "results") {
    const { clause: matchClause, params: matchParams } = matchFilterSql(filters, now);
    const rows = rawDb
      .prepare(
        `SELECT DISTINCT m.id,m.hkjc_id,m.league,m.home_team,m.away_team,m.kickoff_utc,
                COALESCE(rr.home_score,r.home_score) home_score,
                COALESCE(rr.away_score,r.away_score) away_score,
                COALESCE(rr.corners_total,r.corners_total) corners_total,
                COALESCE(rr.source,r.source) source,
                COALESCE(rr.fetched_at,r.fetched_at) fetched_at
           FROM matches m
           LEFT JOIN research_timeline_snapshots q ON q.match_id=m.id
           LEFT JOIN research_results rr ON rr.match_id=m.id
           LEFT JOIN results r ON r.match_id=m.id
          WHERE ${matchClause}
            AND (rr.match_id IS NOT NULL OR r.match_id IS NOT NULL)
          ORDER BY m.kickoff_utc DESC LIMIT ?`,
      )
      .all(...matchParams, MAX_EXPORT_ROWS) as Array<Record<string, unknown>>;
    return toCsv(
      ["match_id", "hkjc_id", "league", "home_team", "away_team", "kickoff_utc", "home_score", "away_score", "corners_total", "source", "fetched_at"],
      rows.map((row) => [
        row.id,
        row.hkjc_id,
        row.league,
        row.home_team,
        row.away_team,
        row.kickoff_utc,
        row.home_score,
        row.away_score,
        row.corners_total,
        row.source,
        row.fetched_at,
      ]),
    );
  }

  const rows = rawDb
    .prepare(
      `SELECT q.id,q.match_id,m.hkjc_id,m.league,m.home_team,m.away_team,m.kickoff_utc,
              q.provider,q.market,q.stage,q.target_at,q.line_key,q.selection,q.decimal_odds,
              q.is_main,q.source_updated_at,q.captured_at,p.first_captured_at,p.last_retry_at,
              q.status,q.origin,q.source_name,
              q.source_match_id,q.source_url
         FROM research_timeline_snapshots q
         JOIN matches m ON m.id=q.match_id
         LEFT JOIN research_timeline_points p ON p.match_id=q.match_id AND p.stage=q.stage
        WHERE ${clause}
        ORDER BY m.kickoff_utc DESC,q.stage,q.provider,q.market,q.line_key,q.selection
        LIMIT ?`,
    )
    .all(...params, MAX_EXPORT_ROWS) as Array<Record<string, unknown>>;
  return toCsv(
    ["id", "match_id", "hkjc_id", "league", "home_team", "away_team", "kickoff_utc", "provider", "market", "stage", "target_at", "line_key", "selection", "decimal_odds", "is_main", "source_updated_at", "captured_at", "first_captured_at", "last_retry_at", "status", "origin", "source_name", "source_match_id", "source_url"],
    rows.map((row) => [
      row.id,
      row.match_id,
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
