/**
 * Tipsme's public history endpoints provide real opening rows separately from
 * the live execution feeds.  This adapter is deliberately research-only:
 * nothing here updates odds_latest, opportunities, or simulations.
 */

import { parseHkjcHandicap, parseHkjcTotal, hkToDecimal } from "../lib/lines";
import { fetchJson } from "../lib/http";
import type { Market, Selection } from "@shared/types";

const BASE = process.env.TIPSME_BASE_URL ?? "https://tipsme-web.azurewebsites.net/api/Score";

export interface TipsmeScheduleEvent {
  sourceMatchId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: number;
}

export interface OpeningQuote {
  provider: "hkjc" | "pinnacle";
  market: Extract<Market, "AH" | "OU" | "COU">;
  lineValue: number;
  isMain: boolean;
  selection: Extract<Selection, "H" | "A" | "O" | "U">;
  decimalOdds: number;
  /** Null when the public source does not timestamp its opening observation. */
  sourceUpdatedAt: number | null;
  origin: "external_opening";
  sourceName: "tipsme";
  sourceMatchId: string;
  sourceUrl: string;
}

export interface TipsmeOpeningResult {
  quotes: OpeningQuote[];
  /** Explicitly records markets which the public source cannot provide. */
  missing: Array<{ provider: "hkjc" | "pinnacle"; market: "AH" | "OU" | "COU"; note: string }>;
}

interface TipsmeScheduleRow {
  matchId?: string | number;
  leagueName?: string;
  leagueNameOriginal?: string;
  home?: string;
  homeOriginal?: string;
  away?: string;
  awayOriginal?: string;
  fullMatchTimeUtc?: string;
}

function numeric(value: unknown): number | null {
  if (typeof value === "string" && !value.trim()) return null;
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function epoch(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

function validOdds(value: unknown): number | null {
  const odds = numeric(value);
  return odds !== null && odds > 1 ? odds : null;
}

function firstByLine<T>(
  rows: T[],
  lineOf: (row: T) => number | null,
  timeOf: (row: T) => number | null,
): T[] {
  const first = new Map<number, { row: T; at: number; index: number }>();
  rows.forEach((row, index) => {
    const line = lineOf(row);
    const at = timeOf(row);
    if (line === null || at === null) return;
    const current = first.get(line);
    if (!current || at < current.at || (at === current.at && index < current.index)) {
      first.set(line, { row, at, index });
    }
  });
  return [...first.values()].sort((a, b) => a.at - b.at || a.index - b.index).map((entry) => entry.row);
}

/**
 * Tipsme caps are primarily Chinese-display strings (e.g. 受一/球半).  The
 * output is always the normalized HOME handicap used by the rest of Radar.
 */
export function parseTipsmeHandicap(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\[\]\s盤]/g, "");
  if (!text) return null;
  // Numeric HKJC representation, e.g. [+1/+1.5].
  const numericLine = parseHkjcHandicap(text);
  if (numericLine !== null) return numericLine;
  // Tipsme omits 「讓」 when the home side gives the handicap (e.g. 半/一).
  // Only an explicit 「受」 represents a positive home handicap.
  const sign = text.includes("受") ? 1 : -1;
  const clean = text.replace(/[受讓]/g, "");
  if (clean === "平手" || clean === "平") return 0;
  const numberOf = (part: string): number | null => {
    if (part === "半") return 0.5;
    if (part === "球半") return 1.5;
    const direct = Number(part);
    if (Number.isFinite(direct)) return direct;
    const digits: Record<string, number> = { 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const ballHalf = part.match(/^([一二兩两三四五六七八九])?球半$/);
    if (ballHalf) return (ballHalf[1] ? digits[ballHalf[1]] : 1) + 0.5;
    const ball = part.match(/^([一二兩两三四五六七八九])?球$/);
    if (ball) return ball[1] ? digits[ball[1]] : 1;
    if (part.length === 1 && digits[part] !== undefined) return digits[part];
    return null;
  };
  const parts = clean.split("/").filter(Boolean).map(numberOf);
  if (!parts.length || parts.some((part) => part === null)) return null;
  const values = parts as number[];
  if (values.length > 2 || (values.length === 2 && Math.abs(values[0] - values[1]) !== 0.5)) return null;
  const result = sign * values.reduce((sum, part) => sum + part, 0) / values.length;
  return Math.abs(result * 4 - Math.round(result * 4)) < 1e-9 ? result : null;
}

function pushPair(
  output: OpeningQuote[],
  base: Omit<OpeningQuote, "selection" | "decimalOdds">,
  first: number | null,
  firstSelection: OpeningQuote["selection"],
  second: number | null,
  secondSelection: OpeningQuote["selection"],
): void {
  if (first !== null) output.push({ ...base, selection: firstSelection, decimalOdds: first });
  if (second !== null) output.push({ ...base, selection: secondSelection, decimalOdds: second });
}

/**
 * Parse true first-source records only.  HKJC history has real create_time
 * timestamps; Tipsme's Pinnacle detail rows expose opening values but no
 * opening timestamp, so their source_updated_at intentionally remains null.
 */
export function parseTipsmeOpeningQuotes(
  sourceMatchId: string,
  hkjcPayload: Record<string, unknown>,
  pinnaclePayload: Record<string, unknown>,
): TipsmeOpeningResult {
  const quotes: OpeningQuote[] = [];
  const hkjcUrl = `${BASE}/odds/hkjc/${encodeURIComponent(sourceMatchId)}`;
  const pinnacleUrl = `${BASE}/odds/v2/${encodeURIComponent(sourceMatchId)}`;
  const hkjcBase = (market: OpeningQuote["market"], lineValue: number, sourceUpdatedAt: number): Omit<OpeningQuote, "selection" | "decimalOdds"> => ({
    provider: "hkjc",
    market,
    lineValue,
    isMain: false,
    sourceUpdatedAt,
    origin: "external_opening",
    sourceName: "tipsme",
    sourceMatchId,
    sourceUrl: hkjcUrl,
  });

  const hdpRows = Array.isArray(hkjcPayload.hdpOdds) ? hkjcPayload.hdpOdds as Array<Record<string, unknown>> : [];
  for (const row of firstByLine(hdpRows, (row) => parseTipsmeHandicap(row.home_cap), (row) => epoch(row.create_time))) {
    const lineValue = parseTipsmeHandicap(row.home_cap);
    const created = epoch(row.create_time);
    if (lineValue === null || created === null) continue;
    pushPair(quotes, hkjcBase("AH", lineValue, created), validOdds(row.home_win_odds), "H", validOdds(row.away_win_odds), "A");
  }

  const totals = [
    ["hiloOdds", "OU", "number_of_goals"],
    ["chiloOdds", "COU", "number_of_corners"],
  ] as const;
  for (const [key, market, lineKey] of totals) {
    const rows = Array.isArray(hkjcPayload[key]) ? hkjcPayload[key] as Array<Record<string, unknown>> : [];
    for (const row of firstByLine(rows, (item) => parseHkjcTotal(String(item[lineKey] ?? "").replace(/[\[\]]/g, "")), (item) => epoch(item.create_time))) {
      const lineValue = parseHkjcTotal(String(row[lineKey] ?? "").replace(/[\[\]]/g, ""));
      const created = epoch(row.create_time);
      if (lineValue === null || created === null) continue;
      pushPair(quotes, hkjcBase(market, lineValue, created), validOdds(row.big_odds), "O", validOdds(row.small_odds), "U");
    }
  }

  const pinnacleBase = (market: Extract<OpeningQuote["market"], "AH" | "OU">, lineValue: number): Omit<OpeningQuote, "selection" | "decimalOdds"> => ({
    provider: "pinnacle",
    market,
    lineValue,
    isMain: false,
    sourceUpdatedAt: null,
    origin: "external_opening",
    sourceName: "tipsme",
    sourceMatchId,
    sourceUrl: pinnacleUrl,
  });
  const isPinnacle = (row: Record<string, unknown>) => row.companyName === "平*" || row.companyNameOriginal === "平*";
  const hdp = (Array.isArray(pinnaclePayload.hdpDetails) ? pinnaclePayload.hdpDetails : []).find(
    (row): row is Record<string, unknown> => !!row && typeof row === "object" && isPinnacle(row as Record<string, unknown>),
  );
  if (hdp) {
    const lineValue = parseTipsmeHandicap(hdp.hdpBeginCap);
    if (lineValue !== null) {
      const home = numeric(hdp.hdpBeginHomeOdds);
      const away = numeric(hdp.hdpBeginAwayOdds);
      pushPair(quotes, pinnacleBase("AH", lineValue), home !== null && home >= 0 ? hkToDecimal(home) : null, "H", away !== null && away >= 0 ? hkToDecimal(away) : null, "A");
    }
  }
  const hilo = (Array.isArray(pinnaclePayload.hiloDetails) ? pinnaclePayload.hiloDetails : []).find(
    (row): row is Record<string, unknown> => !!row && typeof row === "object" && isPinnacle(row as Record<string, unknown>),
  );
  if (hilo) {
    const lineValue = parseHkjcTotal(String(hilo.hiloBeginCap ?? ""));
    if (lineValue !== null) {
      const over = numeric(hilo.hiloBeginBigOdds);
      const under = numeric(hilo.hiloBeginSmallOdds);
      pushPair(quotes, pinnacleBase("OU", lineValue), over !== null && over >= 0 ? hkToDecimal(over) : null, "O", under !== null && under >= 0 ? hkToDecimal(under) : null, "U");
    }
  }

  return {
    quotes,
    missing: [{
      provider: "pinnacle",
      market: "COU",
      note: "Pinnacle COU opening unavailable: Tipsme public v2 has no Pinnacle corner-opening source.",
    }],
  };
}

export class TipsmeOpeningProvider {
  async fetchSchedule(date: string): Promise<TipsmeScheduleEvent[]> {
    const rows = await fetchJson<TipsmeScheduleRow[]>(`${BASE}/schedule/${encodeURIComponent(date)}`, { timeoutMs: 20_000, retries: 1 });
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
      const sourceMatchId = row.matchId === undefined || row.matchId === null ? "" : String(row.matchId);
      const kickoffUtc = epoch(row.fullMatchTimeUtc);
      const league = row.leagueNameOriginal || row.leagueName || "";
      const homeTeam = row.homeOriginal || row.home || "";
      const awayTeam = row.awayOriginal || row.away || "";
      return sourceMatchId && kickoffUtc !== null && league && homeTeam && awayTeam
        ? [{ sourceMatchId, league, homeTeam, awayTeam, kickoffUtc }]
        : [];
    });
  }

  async fetchOpening(sourceMatchId: string): Promise<TipsmeOpeningResult> {
    const [hkjcPayload, pinnaclePayload] = await Promise.all([
      fetchJson<Record<string, unknown>>(`${BASE}/odds/hkjc/${encodeURIComponent(sourceMatchId)}`, { timeoutMs: 20_000, retries: 1 }),
      fetchJson<Record<string, unknown>>(`${BASE}/odds/v2/${encodeURIComponent(sourceMatchId)}`, { timeoutMs: 20_000, retries: 1 }),
    ]);
    return parseTipsmeOpeningQuotes(sourceMatchId, hkjcPayload, pinnaclePayload);
  }
}
