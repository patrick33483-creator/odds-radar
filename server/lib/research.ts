import type { HkjcProvider } from "../providers/hkjc";
import { hkjcHktDate } from "../providers/hkjc";
import { getState, rawDb, setState } from "./store";
import type {
  Market,
  Provider,
  ResearchDatasetResponse,
  ResearchMatchRow,
  ResearchResultCollectorStatus,
} from "@shared/types";

const RESULT_DELAY_MS = 105 * 60_000;
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 120;
const MAX_RESULT_LOOKBACK_DAYS = 30;
const MAX_EXPORT_ROWS = 100_000;

export interface ResearchFilters {
  days: number;
  provider: Provider | "all";
  market: Market | "all";
}

function boundedDays(value: unknown, fallback = DEFAULT_LOOKBACK_DAYS): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(MAX_LOOKBACK_DAYS, Math.floor(parsed)))
    : fallback;
}

export function parseResearchFilters(query: Record<string, unknown>): ResearchFilters {
  const provider = ["hkjc", "pinnacle", "crown"].includes(String(query.provider))
    ? (String(query.provider) as Provider)
    : "all";
  const market = ["1X2", "AH", "OU", "COU"].includes(String(query.market))
    ? (String(query.market) as Market)
    : "all";
  return { days: boundedDays(query.days), provider, market };
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

function filterSql(filters: ResearchFilters, alias = "s"): { clause: string; params: unknown[] } {
  const clauses = [`${alias}.fetched_at>=?`];
  const params: unknown[] = [Date.now() - filters.days * 24 * 60 * 60_000];
  if (filters.provider !== "all") {
    clauses.push(`${alias}.provider=?`);
    params.push(filters.provider);
  }
  if (filters.market !== "all") {
    clauses.push(`${alias}.market=?`);
    params.push(filters.market);
  }
  return { clause: clauses.join(" AND "), params };
}

export function researchDataset(filters: ResearchFilters): ResearchDatasetResponse {
  const { clause, params } = filterSql(filters);
  const summary = rawDb
    .prepare(
      `SELECT COUNT(*) snapshots, COUNT(DISTINCT s.match_id) matches,
              MIN(s.fetched_at) first_snapshot_at, MAX(s.fetched_at) last_snapshot_at
         FROM odds_snapshots s WHERE ${clause}`,
    )
    .get(...params) as {
    snapshots: number;
    matches: number;
    first_snapshot_at: number | null;
    last_snapshot_at: number | null;
  };
  const providerCounts = rawDb
    .prepare(`SELECT s.provider name, COUNT(*) count FROM odds_snapshots s WHERE ${clause} GROUP BY s.provider`)
    .all(...params) as Array<{ name: Provider; count: number }>;
  const marketCounts = rawDb
    .prepare(`SELECT s.market name, COUNT(*) count FROM odds_snapshots s WHERE ${clause} GROUP BY s.market`)
    .all(...params) as Array<{ name: Market; count: number }>;
  const coverage = rawDb
    .prepare(
      `SELECT COUNT(DISTINCT CASE WHEN m.kickoff_utc<=? THEN m.id END) eligible,
              COUNT(DISTINCT CASE WHEN m.kickoff_utc<=? AND
                (rr.match_id IS NOT NULL OR r.match_id IS NOT NULL) THEN m.id END) completed
         FROM odds_snapshots s
         JOIN matches m ON m.id=s.match_id
         LEFT JOIN research_results rr ON rr.match_id=m.id
         LEFT JOIN results r ON r.match_id=m.id
        WHERE ${clause}`,
    )
    .get(Date.now() - RESULT_DELAY_MS, Date.now() - RESULT_DELAY_MS, ...params) as {
    eligible: number;
    completed: number;
  };
  const rows = rawDb
    .prepare(
      `SELECT m.id match_id,m.league,m.home_team,m.away_team,m.kickoff_utc,
              COUNT(*) snapshot_count,COUNT(DISTINCT s.provider) provider_count,
              COUNT(DISTINCT s.market) market_count,MIN(s.fetched_at) first_snapshot_at,
              MAX(s.fetched_at) last_snapshot_at,
              GROUP_CONCAT(DISTINCT s.provider) providers,
              GROUP_CONCAT(DISTINCT s.market) markets,
              MAX(CASE WHEN s.provider='hkjc' THEN s.fetched_at END) hkjc_last_at,
              MAX(CASE WHEN s.provider='pinnacle' THEN s.fetched_at END) pinnacle_last_at,
              MAX(CASE WHEN s.provider='crown' THEN s.fetched_at END) crown_last_at,
              COALESCE(rr.home_score,r.home_score) home_score,
              COALESCE(rr.away_score,r.away_score) away_score,
              COALESCE(rr.corners_total,r.corners_total) corners_total,
              COALESCE(rr.source,r.source) result_source,
              COALESCE(rr.fetched_at,r.fetched_at) result_fetched_at
         FROM odds_snapshots s
         JOIN matches m ON m.id=s.match_id
         LEFT JOIN research_results rr ON rr.match_id=m.id
         LEFT JOIN results r ON r.match_id=m.id
        WHERE ${clause}
        GROUP BY m.id
        ORDER BY m.kickoff_utc DESC
        LIMIT 300`,
    )
    .all(...params) as Array<Record<string, unknown>>;

  return {
    generatedAt: Date.now(),
    filters,
    summary: {
      snapshots: summary.snapshots ?? 0,
      matches: summary.matches ?? 0,
      completedResults: coverage.completed ?? 0,
      resultEligibleMatches: coverage.eligible ?? 0,
      firstSnapshotAt: summary.first_snapshot_at,
      lastSnapshotAt: summary.last_snapshot_at,
      providerCounts,
      marketCounts,
    },
    collector: collectorStatus(),
    matches: rows.map(
      (row): ResearchMatchRow => ({
        matchId: String(row.match_id),
        league: String(row.league),
        homeTeam: String(row.home_team),
        awayTeam: String(row.away_team),
        kickoffUtc: Number(row.kickoff_utc),
        snapshotCount: Number(row.snapshot_count),
        providerCount: Number(row.provider_count),
        marketCount: Number(row.market_count),
        providers: String(row.providers ?? "").split(",").filter(Boolean) as Provider[],
        latestByProvider: {
          ...(row.hkjc_last_at === null ? {} : { hkjc: Number(row.hkjc_last_at) }),
          ...(row.pinnacle_last_at === null ? {} : { pinnacle: Number(row.pinnacle_last_at) }),
          ...(row.crown_last_at === null ? {} : { crown: Number(row.crown_last_at) }),
        },
        markets: String(row.markets ?? "").split(",").filter(Boolean) as Market[],
        firstSnapshotAt: Number(row.first_snapshot_at),
        lastSnapshotAt: Number(row.last_snapshot_at),
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
      }),
    ),
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

export function researchCsv(kind: "snapshots" | "results", filters: ResearchFilters): string {
  if (kind === "results") {
    const { clause, params } = filterSql(filters);
    const rows = rawDb
      .prepare(
        `SELECT DISTINCT m.id,m.hkjc_id,m.league,m.home_team,m.away_team,m.kickoff_utc,
                COALESCE(rr.home_score,r.home_score) home_score,
                COALESCE(rr.away_score,r.away_score) away_score,
                COALESCE(rr.corners_total,r.corners_total) corners_total,
                COALESCE(rr.source,r.source) source,
                COALESCE(rr.fetched_at,r.fetched_at) fetched_at
           FROM matches m
           JOIN odds_snapshots s ON s.match_id=m.id
           LEFT JOIN research_results rr ON rr.match_id=m.id
           LEFT JOIN results r ON r.match_id=m.id
          WHERE ${clause}
            AND (rr.match_id IS NOT NULL OR r.match_id IS NOT NULL)
          ORDER BY m.kickoff_utc DESC LIMIT ?`,
      )
      .all(...params, MAX_EXPORT_ROWS) as Array<Record<string, unknown>>;
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

  const { clause, params } = filterSql(filters);
  const rows = rawDb
    .prepare(
      `SELECT s.id,s.match_id,m.hkjc_id,m.league,m.home_team,m.away_team,m.kickoff_utc,
              s.provider,s.market,s.line_key,s.selection,s.decimal_odds,
              s.source_updated_at,s.fetched_at,s.phase
         FROM odds_snapshots s JOIN matches m ON m.id=s.match_id
        WHERE ${clause}
        ORDER BY s.fetched_at DESC LIMIT ?`,
    )
    .all(...params, MAX_EXPORT_ROWS) as Array<Record<string, unknown>>;
  return toCsv(
    ["id", "match_id", "hkjc_id", "league", "home_team", "away_team", "kickoff_utc", "provider", "market", "line_key", "selection", "decimal_odds", "source_updated_at", "fetched_at", "phase"],
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
      row.line_key,
      row.selection,
      row.decimal_odds,
      row.source_updated_at,
      row.fetched_at,
      row.phase,
    ]),
  );
}
