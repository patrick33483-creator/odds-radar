/**
 * HKJC (香港賽馬會) adapter — public football data GraphQL gateway.
 *
 * Endpoint : POST https://info.cld.hkjc.com/graphql/base/
 * Auth     : none, but the query must be one of the gateway's WHITELISTED
 *            queries (see hkjc-query.ts) or it answers WHITELIST_ERROR.
 * Markets  : HAD (主客和 / 1X2), HDC (亞洲讓球), HIL (入球大細)
 * Prices   : `currentOdds` are already decimal.
 * Scope    : only `status === 'PREEVENT'` matches are emitted — pre-match only.
 */

import { fetchText } from "../lib/http";
import { HKJC_MATCH_LIST_QUERY } from "./hkjc-query";
import { HKJC_HISTORIC_FOOTBALL_MATCHES_QUERY } from "./hkjc-result-query";
import { lineKeyOf, parseHkjcHandicap, parseHkjcTotal } from "../lib/lines";
import type { OddsProvider, ProviderEvent, ProviderFetchResult, ProviderPrice } from "./types";
import type { Selection } from "@shared/types";

const ENDPOINT = "https://info.cld.hkjc.com/graphql/base/";
export const HKJC_HISTORIC_PAGE_SIZE = 20;
export const HKJC_HISTORIC_MAX_PAGES = 10;

interface GqlCombination {
  combId: string;
  str: string;
  status: string;
  currentOdds: string | null;
}
interface GqlLine {
  lineId: string;
  status: string;
  condition: string;
  main: boolean;
  combinations: GqlCombination[];
}
interface GqlPool {
  id: string;
  status: string;
  oddsType: string;
  inplay: boolean;
  updateAt: string | null;
  lines: GqlLine[];
}
interface GqlMatch {
  id: string;
  matchDate: string;
  kickOffTime: string;
  status: string;
  updateAt: string | null;
  homeTeam: { name_ch: string; name_en: string };
  awayTeam: { name_ch: string; name_en: string };
  tournament: { name_ch: string; name_en: string };
  foPools: GqlPool[] | null;
}

interface HistoricResultRow {
  homeResult?: unknown;
  awayResult?: unknown;
  payoutConfirmed?: unknown;
  stageId?: unknown;
  resultType?: unknown;
  sequence?: unknown;
}

interface HistoricMatch {
  id?: unknown;
  status?: unknown;
  results?: unknown;
}

export interface HkjcHistoricRequest {
  /** HKJC numeric match ID, optionally with the local `hkjc:` prefix. */
  matchId: string;
  kickoffUtc: number;
}

export interface HkjcOfficialResult {
  matchId: string;
  homeScore: number;
  awayScore: number;
  sequence: number;
  source: "hkjc_official";
}

const SELECTION_MAP: Record<string, Selection> = { H: "H", D: "D", A: "A", L: "U" };

function toEpoch(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asNonNegativeInt(value: unknown): number | null {
  if (typeof value === "string" && !value.trim()) return null;
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function asInt(value: unknown): number | null {
  if (typeof value === "string" && !value.trim()) return null;
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) ? n : null;
}

function isEndedStatus(status: unknown): boolean {
  const value = typeof status === "string" ? status.trim().toUpperCase() : "";
  return value === "MATCHENDED" || value === "INPLAYMATCHENDED" || /(?:^|_)ENDED$/.test(value);
}

function historicMatches(payload: unknown): HistoricMatch[] {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const matches = data?.matches ?? data?.matchResult;
  return Array.isArray(matches) ? (matches as HistoricMatch[]) : [];
}

function normalizedHkjcMatchId(matchId: string): string {
  return matchId.replace(/^hkjc:/i, "").trim();
}

/**
 * Return the HKT calendar date for the official historic-results query.
 * Formatting through parts avoids host-timezone and locale-dependent dates.
 */
export function hkjcHktDate(epochMs: number): string | null {
  if (!Number.isFinite(epochMs)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(epochMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day ? `${values.year}-${values.month}-${values.day}` : null;
}

/**
 * HKJC's historic endpoint rejects large result ranges. Each request stays at
 * the verified 20-row width; the total number of requests is also bounded.
 */
export function historicPageRanges(
  maxPages = HKJC_HISTORIC_MAX_PAGES,
  pageSize = HKJC_HISTORIC_PAGE_SIZE,
): Array<{ startIndex: number; endIndex: number }> {
  const safePages = Math.max(0, Math.floor(maxPages));
  const safeSize = Math.max(1, Math.floor(pageSize));
  return Array.from({ length: safePages }, (_, page) => ({
    startIndex: page * safeSize,
    endIndex: (page + 1) * safeSize,
  }));
}

/**
 * Strictly extract official full-match results only. In particular, this
 * ignores live/interim rows and result types 2/4 even if they carry a score.
 */
export function parseHkjcHistoricResults(
  payload: unknown,
  requestedMatchIds: Iterable<string>,
): HkjcOfficialResult[] {
  const requested = new Set(
    Array.from(requestedMatchIds, normalizedHkjcMatchId).filter((matchId) => !!matchId),
  );
  if (!requested.size) return [];

  const best = new Map<string, HkjcOfficialResult>();
  for (const match of historicMatches(payload)) {
    const matchId = typeof match.id === "string" || typeof match.id === "number" ? normalizedHkjcMatchId(String(match.id)) : "";
    if (!matchId || !requested.has(matchId) || !isEndedStatus(match.status) || !Array.isArray(match.results)) continue;

    for (const row of match.results as HistoricResultRow[]) {
      if (asInt(row.resultType) !== 1 || asInt(row.stageId) !== 5 || row.payoutConfirmed !== true) continue;
      const homeScore = asNonNegativeInt(row.homeResult);
      const awayScore = asNonNegativeInt(row.awayResult);
      const sequence = asNonNegativeInt(row.sequence);
      if (homeScore === null || awayScore === null || sequence === null) continue;
      const existing = best.get(matchId);
      if (!existing || sequence > existing.sequence) {
        best.set(matchId, { matchId, homeScore, awayScore, sequence, source: "hkjc_official" });
      }
    }
  }
  return [...best.values()];
}

export function mapHkjcMatch(m: GqlMatch): ProviderEvent | null {
  const kickoffUtc = toEpoch(m.kickOffTime);
  if (kickoffUtc === null) return null;
  const inplay = m.status !== "PREEVENT";
  const prices: ProviderPrice[] = [];
  for (const pool of m.foPools ?? []) {
    // NOTE: `pool.inplay` means "this pool is ALSO offered in-play", not that the
    // quoted price is an in-play price. Pre-match/in-play separation is enforced
    // by the match-level `status === 'PREEVENT'` gate below.
    const market = pool.oddsType === "HAD" ? "1X2" : pool.oddsType === "HDC" ? "AH" : pool.oddsType === "HIL" ? "OU" : null;
    if (!market) continue;
    const sourceUpdatedAt = toEpoch(pool.updateAt);
    for (const line of pool.lines) {
      let lineValue: number | null = null;
      if (market === "AH") {
        lineValue = parseHkjcHandicap(line.condition);
        if (lineValue === null) continue;
      } else if (market === "OU") {
        lineValue = parseHkjcTotal(line.condition);
        if (lineValue === null) continue;
      }
      for (const comb of line.combinations) {
        const sel = SELECTION_MAP[comb.str];
        if (!sel) continue;
        // HIL uses H for 大 and L for 細
        const selection: Selection = market === "OU" ? (comb.str === "H" ? "O" : "U") : sel;
        const odds = Number(comb.currentOdds);
        if (!Number.isFinite(odds) || odds <= 1) continue;
        prices.push({
          market,
          lineValue,
          isMain: !!line.main,
          selection,
          decimalOdds: odds,
          sourceUpdatedAt,
        });
      }
    }
  }
  return {
    providerMatchId: m.id,
    league: m.tournament?.name_ch ?? "",
    leagueEn: m.tournament?.name_en ?? null,
    homeTeam: m.homeTeam?.name_ch ?? "",
    awayTeam: m.awayTeam?.name_ch ?? "",
    homeTeamEn: m.homeTeam?.name_en ?? null,
    awayTeamEn: m.awayTeam?.name_en ?? null,
    kickoffUtc,
    inplay,
    status: m.status,
    prices,
  };
}

export class HkjcProvider implements OddsProvider {
  readonly name = "hkjc" as const;

  async fetchPreMatch(opts: { windowMinutes?: number } = {}): Promise<ProviderFetchResult> {
    const started = Date.now();
    const body = JSON.stringify({
      query: HKJC_MATCH_LIST_QUERY,
      variables: {
        fbOddsTypes: ["HAD", "HDC", "HIL"],
        fbOddsTypesM: ["HAD", "HDC", "HIL"],
        inplayOnly: false,
        featuredMatchesOnly: false,
        startDate: null,
        endDate: null,
        tournIds: null,
        matchIds: null,
        frontEndIds: null,
        earlySettlementOnly: false,
      },
    });
    const text = await fetchText(ENDPOINT, {
      method: "POST",
      body,
      timeoutMs: 25_000,
      retries: 2,
      headers: {
        "content-type": "application/json",
        origin: "https://bet.hkjc.com",
        referer: "https://bet.hkjc.com/",
        accept: "application/json",
      },
    });
    const json = JSON.parse(text) as { data?: { matches?: GqlMatch[] }; errors?: Array<{ message: string }> };
    if (json.errors?.length && !json.data?.matches) {
      throw new Error(`HKJC GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    const raw = json.data?.matches ?? [];
    const warnings: string[] = [];
    const cutoff = opts.windowMinutes ? Date.now() + opts.windowMinutes * 60_000 : null;
    const events: ProviderEvent[] = [];
    let inplaySkipped = 0;
    for (const m of raw) {
      const ev = mapHkjcMatch(m);
      if (!ev) continue;
      if (ev.inplay) {
        inplaySkipped++;
        continue;
      }
      if (cutoff !== null && ev.kickoffUtc > cutoff) continue;
      events.push(ev);
    }
    if (inplaySkipped) warnings.push(`skipped ${inplaySkipped} in-play match(es)`);
    return {
      events,
      latencyMs: Date.now() - started,
      partial: cutoff !== null,
      warnings,
    };
  }

  /**
   * Fetch only the official historic rows needed to settle due simulations.
   * The date range follows those bets' HKT kickoff dates, and every GraphQL
   * response is locally reduced to the requested HKJC match IDs.
   */
  async fetchHistoricResults(requests: HkjcHistoricRequest[]): Promise<HkjcOfficialResult[]> {
    const requested = Array.from(
      new Map(
        requests
          .map((request) => ({
            matchId: normalizedHkjcMatchId(request.matchId),
            date: hkjcHktDate(request.kickoffUtc),
          }))
          .filter((request): request is { matchId: string; date: string } => !!request.matchId && !!request.date)
          .map((request) => [request.matchId, request]),
      ).values(),
    );
    if (!requested.length) return [];

    const dates = requested.map((request) => request.date).sort();
    const startDate = dates[0];
    const endDate = dates[dates.length - 1];
    const requestedIds = new Set(requested.map((request) => request.matchId));
    const best = new Map<string, HkjcOfficialResult>();

    for (const { startIndex, endIndex } of historicPageRanges()) {
      const text = await fetchText(ENDPOINT, {
        method: "POST",
        body: JSON.stringify({
          query: HKJC_HISTORIC_FOOTBALL_MATCHES_QUERY,
          variables: { startDate, endDate, startIndex, endIndex, teamId: null },
        }),
        timeoutMs: 25_000,
        retries: 2,
        headers: {
          "content-type": "application/json",
          origin: "https://bet.hkjc.com",
          referer: "https://bet.hkjc.com/",
          accept: "application/json",
        },
      });
      const json = JSON.parse(text) as { data?: unknown; errors?: Array<{ message: string }> };
      if (json.errors?.length) {
        throw new Error(`HKJC historic GraphQL error: ${json.errors.map((error) => error.message).join("; ")}`);
      }

      const rows = historicMatches(json);
      for (const result of parseHkjcHistoricResults(json, requestedIds)) {
        const existing = best.get(result.matchId);
        if (!existing || result.sequence > existing.sequence) best.set(result.matchId, result);
      }
      if (best.size === requestedIds.size || rows.length < HKJC_HISTORIC_PAGE_SIZE) break;
    }
    return [...best.values()];
  }
}

export const lineKey = lineKeyOf;
