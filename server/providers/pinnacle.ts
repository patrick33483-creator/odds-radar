/**
 * Pinnacle (平博) adapter — REPLACEABLE, two strategies, never substituted.
 *
 *   (a) "official-api"  approved Pinnacle API (HTTPS + JSON + Basic auth). Used
 *       only when PINNACLE_API_USERNAME and PINNACLE_API_PASSWORD are set.
 *       General public API access closed on 2025-07-23, so this is opt-in.
 *       See pinnacle-api.ts.
 *   (b) "titan007"      credential-free public odds pages on titan007 / 球探網.
 *       The Pinnacle row is located by NORMALIZED BOOKMAKER NAME (see
 *       pinnacle-names.ts) — never by assuming the old Crown company id (3),
 *       which is explicitly blocked.
 *
 * If neither strategy yields a Pinnacle row, the adapter throws / returns empty
 * and the engine reports degraded status while keeping the last good snapshot.
 * Crown (or any other book) is NEVER used as a stand-in.
 *
 * titan007 endpoints (gb18030-encoded HTML unless noted):
 *   fixtures  : http://bf.titan007.com/football/Next_YYYYMMDD.htm   (upcoming)
 *               http://bf.titan007.com/football/Over_YYYYMMDD.htm   (played + scores)
 *   handicap  : http://vip.titan007.com/AsianOdds_n.aspx?id=<sId>
 *   totals    : http://vip.titan007.com/OverDown_n.aspx?id=<sId>
 *   1X2       : http://1x2d.titan007.com/<sId>.js  (UTF-8 JS, full bookmaker names)
 *
 * Conventions:
 *   - Asian pages quote HONG KONG odds -> decimal = hk + 1. The 1X2 JS is decimal.
 *   - titan007's `goals` is signed POSITIVE = home gives; our internal
 *     convention is the opposite, so it is negated in parsePinnacleHandicap().
 *   - Pre-match only: the current full-time triple, never in-play.
 *
 * Verified live on 2026-08-07: the Pinnacle row is present on the Asian pages
 * (visible label "平*", company id 47) and in the 1X2 JS as "Pinnacle".
 */

import { fetchText } from "../lib/http";
import { hkToDecimal, parsePinnacleHandicap, parsePinnacleTotal } from "../lib/lines";
import {
  fetchApiFixtures,
  fetchApiPrices,
  hasOfficialCredentials,
  OFFICIAL_API_CLOSED_NOTE,
} from "./pinnacle-api";
import {
  isPinnacleName,
  normalizeBookmakerName,
  selectPinnacleRow,
  type BookmakerRow,
} from "./pinnacle-names";
import type { FinalResult, ProviderEvent, ProviderPrice } from "./types";

/** Base URLs are overridable so the source can be swapped or fault-injected. */
const BF = process.env.TITAN_BF_BASE ?? "http://bf.titan007.com/football";
const VIP = process.env.TITAN_VIP_BASE ?? "https://vip.titan007.com";
const X2 = process.env.TITAN_1X2_BASE ?? "http://1x2d.titan007.com";
const LIVE_DATA = process.env.TITAN_LIVE_DATA_URL ?? "https://livestatic.titan007.com/vbsxml/bfdata_ut.js";
const HK_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

export type PinnacleStrategy = "official-api" | "titan007";
export { OFFICIAL_API_CLOSED_NOTE };

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

export interface PinnacleFixture {
  providerMatchId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: number;
  statusText: string;
  homeScore: number | null;
  awayScore: number | null;
  halfHome: number | null;
  halfAway: number | null;
  handicapVal: number | null;
  totalVal: number | null;
}

/**
 * titan007 renders kickoff times in UTC+8 in two shapes:
 *   Next_ pages : "8-7 10:30"
 *   Over_ pages : "5日10:40"  (day only — month/year come from the page key)
 */
export function parseTitanTime(text: string, pageYyyymmdd: string): number | null {
  const year = Number(pageYyyymmdd.slice(0, 4));
  const pageMonth = Number(pageYyyymmdd.slice(4, 6));
  let mo: number;
  let d: number;
  let h: number;
  let mi: number;
  const a = text.match(/(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  const b = text.match(/(\d{1,2})\u65e5\s*(\d{1,2}):(\d{2})/);
  if (a) {
    mo = Number(a[1]);
    d = Number(a[2]);
    h = Number(a[3]);
    mi = Number(a[4]);
  } else if (b) {
    mo = pageMonth;
    d = Number(b[1]);
    h = Number(b[2]);
    mi = Number(b[3]);
  } else {
    return null;
  }
  const utc = Date.UTC(year, mo - 1, d, h, mi);
  return utc - HK_TZ_OFFSET_MS;
}

/** Parse a Next_/Over_ schedule page. */
export function parseSchedulePage(html: string, yyyymmdd: string): PinnacleFixture[] {
  const out: PinnacleFixture[] = [];
  const rowRe = /<tr[^>]*sId='(\d+)'[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html))) {
    const sId = m[1];
    const row = m[2];
    const rawCells = row.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? [];
    if (rawCells.length < 7) continue;
    const cells = rawCells.map(stripTags);
    const league = cells[0].replace(/\[\d+\]$/, "").trim();
    const kickoffUtc = parseTitanTime(cells[1], yyyymmdd);
    if (kickoffUtc === null) continue;
    const statusText = cells[2];
    const homeTeam = cells[3].replace(/\[[^\]]*\]/g, "").trim();
    const awayTeam = cells[5].replace(/\[[^\]]*\]/g, "").trim();
    const score = cells[4].match(/(\d+)\s*-\s*(\d+)/);
    const half = (cells[6] ?? "").match(/(\d+)\s*-\s*(\d+)/);
    const hdpAttr = rawCells.find((c) => /id='hdp_\d+'/.test(c));
    const ouAttr = rawCells.find((c) => /id='ou_\d+'/.test(c));
    const hdpVal = hdpAttr?.match(/val='(-?[\d.]*)'/)?.[1];
    const ouVal = ouAttr?.match(/val='(-?[\d.]*)'/)?.[1];
    out.push({
      providerMatchId: sId,
      league,
      homeTeam,
      awayTeam,
      kickoffUtc,
      statusText,
      homeScore: score ? Number(score[1]) : null,
      awayScore: score ? Number(score[2]) : null,
      halfHome: half ? Number(half[1]) : null,
      halfAway: half ? Number(half[2]) : null,
      handicapVal: hdpVal ? Number(hdpVal) : null,
      totalVal: ouVal ? Number(ouVal) : null,
    });
  }
  return out;
}

/**
 * Parse Titan's complete live fixture feed. Unlike the static Next_ page this
 * feed includes youth and smaller-league fixtures, while still carrying both
 * Simplified and Traditional Chinese labels plus the stable odds-page sId.
 *
 * Record fields used here:
 *  0 sId, 2/3 league SC/TC, 5/6 home SC/TC, 8/9 away SC/TC,
 *  12 local UTC+8 kickoff tuple with a zero-based month.
 */
export function parseTitanLiveData(jsText: string): PinnacleFixture[] {
  const out: PinnacleFixture[] = [];
  const recordRe = /A\[\d+\]\s*=\s*"((?:\\.|[^"])*)"\.split\(['"]\^['"]\);/g;
  let match: RegExpExecArray | null;
  while ((match = recordRe.exec(jsText))) {
    let decoded = match[1];
    try {
      decoded = JSON.parse(`"${match[1]}"`) as string;
    } catch {
      // Most records contain no escapes. Keep the raw value rather than
      // discarding a usable fixture because one optional label is malformed.
    }
    const fields = decoded.split("^");
    const providerMatchId = fields[0]?.trim();
    const tuple = fields[12]?.split(",").map(Number) ?? [];
    if (!providerMatchId || tuple.length < 5 || !tuple.slice(0, 5).every(Number.isFinite)) continue;
    const [year, zeroBasedMonth, day, hour, minute, second = 0] = tuple;
    const kickoffUtc = Date.UTC(year, zeroBasedMonth, day, hour, minute, second) - HK_TZ_OFFSET_MS;
    const league = (fields[3] || fields[2] || "").trim();
    const homeTeam = (fields[6] || fields[5] || "").trim();
    const awayTeam = (fields[9] || fields[8] || "").trim();
    if (!league || !homeTeam || !awayTeam || !Number.isFinite(kickoffUtc)) continue;
    out.push({
      providerMatchId,
      league,
      homeTeam,
      awayTeam,
      kickoffUtc,
      statusText: "PREEVENT",
      homeScore: null,
      awayScore: null,
      halfHome: null,
      halfAway: null,
      handicapVal: null,
      totalVal: null,
    });
  }
  return out;
}

export interface PinnacleRowTriple {
  home: number;
  goals: number;
  away: number;
  companyId: string;
  matchedBy: "name" | "id-hint";
}

/** Every bookmaker row on an AsianOdds_n / OverDown_n page with its visible label. */
export function listBookmakerRows(html: string): BookmakerRow[] {
  const out: BookmakerRow[] = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html))) {
    const row = m[1];
    const id = row.match(/data-id="(\d+)"/) ?? row.match(/companyID=['"](\d+)['"]/);
    if (!id) continue;
    // The visible label is the first non-checkbox cell of the row.
    const nameCell = row.match(/<td[^>]*height="25"[^>]*>([\s\S]*?)<\/td>/) ?? row.match(/<td[^>]*>([^<]{1,24})<\/td>/);
    out.push({ companyId: id[1], rawName: stripTags(nameCell?.[1] ?? ""), html: row });
  }
  return out;
}

function rowTriple(rowHtml: string): { home: number; goals: number; away: number } | null {
  let fallback: { home: number; goals: number; away: number } | null = null;
  // titan007 emits two "current" triples and toggles which one is visible
  // depending on match state (`wholeOdds` / `wholeLastOdds`).
  for (const type of ["wholeLastOdds", "wholeOdds"]) {
    const cells = rowHtml.match(new RegExp(`<td[^>]*oddstype="${type}"[^>]*>[\\s\\S]*?<\\/td>`, "g"));
    if (!cells || cells.length < 3) continue;
    const visible = !cells.some((c) => /display:\s*none/.test(c));
    const home = Number(stripTags(cells[0]));
    const goals = Number(cells[1].match(/goals="(-?[\d.]+)"/)?.[1]);
    const away = Number(stripTags(cells[2]));
    if (![home, goals, away].every(Number.isFinite)) continue;
    if (visible) return { home, goals, away };
    fallback = fallback ?? { home, goals, away };
  }
  return fallback;
}

/**
 * Titan places the explicit bookmaker opening triple immediately before its
 * oddstype=current cells. Untyped values are required; malformed/missing
 * opening cells return null and must never fall back to the current quote.
 */
function openingRowTriple(rowHtml: string): { home: number; goals: number; away: number } | null {
  const currentAt = rowHtml.search(/<td[^>]*oddstype=["']whole(?:Last)?Odds["']/i);
  if (currentAt < 0) return null;
  const prefix = rowHtml.slice(0, currentAt);
  const triples = Array.from(prefix.matchAll(
    /<td(?![^>]*oddstype)[^>]*>([\s\S]*?)<\/td>\s*<td(?![^>]*oddstype)([^>]*)>([\s\S]*?)<\/td>\s*<td(?![^>]*oddstype)[^>]*>([\s\S]*?)<\/td>/gi,
  ));
  for (let index = triples.length - 1; index >= 0; index--) {
    const match = triples[index];
    const goalsText = match[2].match(/goals=["'](-?[\d.]+)["']/i)?.[1];
    const home = Number(stripTags(match[1]));
    const goals = Number(goalsText);
    const away = Number(stripTags(match[4]));
    if ([home, goals, away].every(Number.isFinite) && home > -1 && away > -1) {
      return { home, goals, away };
    }
  }
  return null;
}

/**
 * Extract Pinnacle's current full-time triple from an AsianOdds_n / OverDown_n
 * page, identified by bookmaker NAME (with an optional numeric hint). Returns
 * null when no Pinnacle row exists — the caller must then degrade, not guess.
 */
export function parsePinnacleAsianTriple(html: string): PinnacleRowTriple | null {
  const picked = selectPinnacleRow(listBookmakerRows(html));
  if (!picked) return null;
  const triple = rowTriple(picked.row.html);
  if (!triple) return null;
  return { ...triple, companyId: picked.row.companyId, matchedBy: picked.matchedBy };
}

function isCrownName(name: string): boolean {
  const normalized = normalizeBookmakerName(name);
  return normalized === "crown" || normalized === "crow" || normalized === "皇冠";
}

/** Crown's current full-time Asian-odds triple from titan007. */
export function parseCrownAsianTriple(
  html: string,
): { home: number; goals: number; away: number; companyId: string } | null {
  const row = listBookmakerRows(html).find((candidate) => candidate.companyId === "3" || isCrownName(candidate.rawName));
  if (!row) return null;
  const triple = rowTriple(row.html);
  return triple ? { ...triple, companyId: row.companyId } : null;
}

/** Crown's explicit opening Asian-odds triple; never a first-seen current quote. */
export function parseCrownOpeningAsianTriple(
  html: string,
): { home: number; goals: number; away: number; companyId: string } | null {
  const row = listBookmakerRows(html).find((candidate) => candidate.companyId === "3" || isCrownName(candidate.rawName));
  if (!row) return null;
  const triple = openingRowTriple(row.html);
  return triple ? { ...triple, companyId: row.companyId } : null;
}

export interface CrownResearchPrices {
  opening: ProviderPrice[];
  current: ProviderPrice[];
  sourceUrls: { AH: string; OU: string };
}

/**
 * Pinnacle 1X2 from titan007's European-odds JS. That feed carries FULL
 * bookmaker names, so selection is purely name-based.
 */
export function parsePinnacle1X2(js: string): { h: number; d: number; a: number; companyId: string } | null {
  const m = js.match(/var\s+game\s*=\s*Array\(([\s\S]*?)\);/);
  if (!m) return null;
  const items = Array.from(m[1].matchAll(/"([^"]*)"/g)).map((x) => x[1]);
  for (const it of items) {
    const p = it.split("|");
    const name = p[2] ?? "";
    if (!(isPinnacleName(name) || normalizeBookmakerName(name) === "pinnacle")) continue;
    // Field layout: id|oddsId|name|open H|open D|open A|probs...|payout|CURRENT H|CURRENT D|CURRENT A|...
    const h = Number(p[10]);
    const d = Number(p[11]);
    const a = Number(p[12]);
    if ([h, d, a].every((v) => Number.isFinite(v) && v > 1)) return { h, d, a, companyId: p[0] };
  }
  return null;
}

/** Crown 1X2 from titan007's European-odds JS feed. */
export function parseCrown1X2(js: string): { h: number; d: number; a: number; companyId: string } | null {
  const m = js.match(/var\s+game\s*=\s*Array\(([\s\S]*?)\);/);
  if (!m) return null;
  const items = Array.from(m[1].matchAll(/"([^"]*)"/g)).map((x) => x[1]);
  for (const it of items) {
    const p = it.split("|");
    if (!isCrownName(p[2] ?? "")) continue;
    const h = Number(p[10]);
    const d = Number(p[11]);
    const a = Number(p[12]);
    if ([h, d, a].every((v) => Number.isFinite(v) && v > 1)) return { h, d, a, companyId: p[0] };
  }
  return null;
}

function ymd(date: Date): string {
  const hk = new Date(date.getTime() + HK_TZ_OFFSET_MS);
  return `${hk.getUTCFullYear()}${String(hk.getUTCMonth() + 1).padStart(2, "0")}${String(hk.getUTCDate()).padStart(2, "0")}`;
}

export interface PinnacleSourceStatus {
  strategy: PinnacleStrategy;
  officialConfigured: boolean;
  /** How the last successful Pinnacle row was identified. */
  lastRowMatchedBy: "name" | "id-hint" | null;
  lastRowCompanyId: string | null;
  warnings: string[];
}

export class PinnacleProvider {
  readonly name = "pinnacle" as const;

  private officialFailed = false;
  private lastRowMatchedBy: "name" | "id-hint" | null = null;
  private lastRowCompanyId: string | null = null;
  private warnings: string[] = [];
  /** Matches where titan007 listed no Pinnacle row (aggregated, not per match). */
  private missingRows = new Set<string>();

  get strategy(): PinnacleStrategy {
    return hasOfficialCredentials() && !this.officialFailed ? "official-api" : "titan007";
  }

  status(): PinnacleSourceStatus {
    return {
      strategy: this.strategy,
      officialConfigured: hasOfficialCredentials(),
      lastRowMatchedBy: this.lastRowMatchedBy,
      lastRowCompanyId: this.lastRowCompanyId,
      warnings: [...this.warnings],
    };
  }

  private warn(message: string): void {
    // Aggregated "N 場…" messages replace their previous version instead of piling up.
    const aggregated = /未列出 Pinnacle 賠率/.test(message);
    if (aggregated) this.warnings = this.warnings.filter((w) => !/未列出 Pinnacle 賠率/.test(w));
    if (!this.warnings.includes(message)) this.warnings.push(message);
    if (this.warnings.length > 5) this.warnings.shift();
  }

  /** Fixture list. Official API when configured, titan007 otherwise. */
  async fetchFixtures(dayOffsets: number[] = [0, 1]): Promise<PinnacleFixture[]> {
    if (this.strategy === "official-api") {
      try {
        const api = await fetchApiFixtures();
        return api.map((f) => ({
          providerMatchId: f.providerMatchId,
          league: f.league,
          homeTeam: f.homeTeam,
          awayTeam: f.awayTeam,
          kickoffUtc: f.kickoffUtc,
          statusText: "scheduled",
          homeScore: null,
          awayScore: null,
          halfHome: null,
          halfAway: null,
          handicapVal: null,
          totalVal: null,
        }));
      } catch (err) {
        this.officialFailed = true;
        this.warn(`official Pinnacle API unavailable (${(err as Error).message}); ${OFFICIAL_API_CLOSED_NOTE}`);
      }
    }
    return this.fetchTitanFixtures(dayOffsets);
  }

  private async fetchTitanFixtures(dayOffsets: number[]): Promise<PinnacleFixture[]> {
    const out: PinnacleFixture[] = [];
    const now = Date.now();
    const requestedKeys = new Set(dayOffsets.map((off) => ymd(new Date(now + off * 86_400_000))));

    // The live feed is the complete same-day universe. It includes fixtures
    // omitted from Next_ pages (notably youth and smaller leagues), so let it
    // win deduplication and use the static pages as future-day/backup coverage.
    try {
      const liveJs = await fetchText(`${LIVE_DATA}?r=007${now}`, {
        headers: { referer: "https://live.titan007.com/" },
        timeoutMs: 15_000,
        retries: 1,
      });
      out.push(...parseTitanLiveData(liveJs).filter((fixture) => requestedKeys.has(ymd(new Date(fixture.kickoffUtc)))));
    } catch (err) {
      this.warn(`Titan 即時完整賽程暫時不可用 (${(err as Error).message}); 已改用靜態賽程後備`);
    }

    for (const off of dayOffsets) {
      const key = ymd(new Date(now + off * 86_400_000));
      // Upcoming days live under Next_, elapsed days under Over_. Today can be
      // in either, so try Next_ first and fall back.
      for (const kind of off >= 0 ? ["Next", "Over"] : ["Over", "Next"]) {
        try {
          // `/football/big/` is Titan007's Traditional-Chinese schedule and
          // carries the same stable sId used by the odds detail pages.  Names
          // from this page are persisted directly; no translation service is
          // involved.
          let html: string;
          try {
            html = await fetchText(`${BF}/big/${kind}_${key}.htm`, {
              charset: "gb18030",
              timeoutMs: 25_000,
              retries: 1,
            });
          } catch {
            // The Simplified-Chinese schedule is still an acceptable direct
            // Chinese source if the Traditional page is temporarily absent.
            html = await fetchText(`${BF}/${kind}_${key}.htm`, {
              charset: "gb18030",
              timeoutMs: 25_000,
              retries: 1,
            });
          }
          const rows = parseSchedulePage(html, key);
          if (rows.length) {
            out.push(...rows);
            break;
          }
        } catch {
          /* try the other kind */
        }
      }
    }
    const seen = new Set<string>();
    return out.filter((f) => (seen.has(f.providerMatchId) ? false : (seen.add(f.providerMatchId), true)));
  }

  /** Titan schedule is the authoritative fixture universe for Crown research. */
  async fetchTitanResearchFixtures(dayOffsets: number[] = [0, 1]): Promise<PinnacleFixture[]> {
    return this.fetchTitanFixtures(dayOffsets);
  }

  /** Pinnacle prices for one provider match id. Missing markets are simply absent. */
  async fetchMatchPrices(providerMatchId: string): Promise<ProviderPrice[]> {
    if (this.strategy === "official-api" && providerMatchId.startsWith("api:")) {
      try {
        return await fetchApiPrices(providerMatchId);
      } catch (err) {
        this.officialFailed = true;
        this.warn(`official Pinnacle odds call failed (${(err as Error).message}); switching to titan007 Pinnacle rows`);
        return [];
      }
    }
    return this.fetchTitanPrices(providerMatchId);
  }

  /** Crown prices for lock calculations only. Pinnacle remains the EV source. */
  async fetchCrownMatchPrices(sId: string): Promise<ProviderPrice[]> {
    const prices: ProviderPrice[] = [];
    const now = Date.now();
    const [ah, ou, x2] = await Promise.allSettled([
      fetchText(`${VIP}/AsianOdds_n.aspx?id=${sId}`, { timeoutMs: 30_000, retries: 1 }),
      fetchText(`${VIP}/OverDown_n.aspx?id=${sId}`, { timeoutMs: 30_000, retries: 1 }),
      fetchText(`${X2}/${sId}.js`, { timeoutMs: 20_000, retries: 0 }),
    ]);
    if (ah.status === "fulfilled") {
      const row = parseCrownAsianTriple(ah.value);
      const lineValue = row ? parsePinnacleHandicap(row.goals) : null;
      if (row && lineValue !== null) {
        prices.push({ market: "AH", lineValue, isMain: true, selection: "H", decimalOdds: hkToDecimal(row.home), sourceUpdatedAt: now });
        prices.push({ market: "AH", lineValue, isMain: true, selection: "A", decimalOdds: hkToDecimal(row.away), sourceUpdatedAt: now });
      }
    }
    if (ou.status === "fulfilled") {
      const row = parseCrownAsianTriple(ou.value);
      const lineValue = row ? parsePinnacleTotal(Math.abs(row.goals)) : null;
      if (row && lineValue !== null) {
        prices.push({ market: "OU", lineValue, isMain: true, selection: "O", decimalOdds: hkToDecimal(row.home), sourceUpdatedAt: now });
        prices.push({ market: "OU", lineValue, isMain: true, selection: "U", decimalOdds: hkToDecimal(row.away), sourceUpdatedAt: now });
      }
    }
    if (x2.status === "fulfilled") {
      const row = parseCrown1X2(x2.value);
      if (row) {
        prices.push({ market: "1X2", lineValue: null, isMain: true, selection: "H", decimalOdds: row.h, sourceUpdatedAt: now });
        prices.push({ market: "1X2", lineValue: null, isMain: true, selection: "D", decimalOdds: row.d, sourceUpdatedAt: now });
        prices.push({ market: "1X2", lineValue: null, isMain: true, selection: "A", decimalOdds: row.a, sourceUpdatedAt: now });
      }
    }
    if (ah.status === "rejected" && ou.status === "rejected" && x2.status === "rejected") {
      throw new Error(`Crown detail unavailable for ${sId}: ${(ah.reason as Error)?.message ?? "unknown"}`);
    }
    return prices;
  }

  /** Research-only Crown AH/OU with explicit opening and current values. */
  async fetchCrownResearchPrices(sId: string): Promise<CrownResearchPrices> {
    const now = Date.now();
    const sourceUrls = {
      AH: `${VIP}/AsianOdds_n.aspx?id=${sId}`,
      OU: `${VIP}/OverDown_n.aspx?id=${sId}`,
    };
    const [ah, ou] = await Promise.allSettled([
      fetchText(sourceUrls.AH, { timeoutMs: 30_000, retries: 1 }),
      fetchText(sourceUrls.OU, { timeoutMs: 30_000, retries: 1 }),
    ]);
    if (ah.status === "rejected" && ou.status === "rejected") {
      throw new Error(`Crown research detail unavailable for ${sId}: ${(ah.reason as Error)?.message ?? "unknown"}`);
    }
    const opening: ProviderPrice[] = [];
    const current: ProviderPrice[] = [];
    const append = (
      target: ProviderPrice[],
      market: "AH" | "OU",
      row: { home: number; goals: number; away: number } | null,
      sourceUpdatedAt: number | null,
    ) => {
      const lineValue = row
        ? market === "AH"
          ? parsePinnacleHandicap(row.goals)
          : parsePinnacleTotal(Math.abs(row.goals))
        : null;
      if (!row || lineValue === null) return;
      target.push({
        market,
        lineValue,
        isMain: true,
        selection: market === "AH" ? "H" : "O",
        decimalOdds: hkToDecimal(row.home),
        sourceUpdatedAt,
      });
      target.push({
        market,
        lineValue,
        isMain: true,
        selection: market === "AH" ? "A" : "U",
        decimalOdds: hkToDecimal(row.away),
        sourceUpdatedAt,
      });
    };
    if (ah.status === "fulfilled") {
      append(opening, "AH", parseCrownOpeningAsianTriple(ah.value), null);
      append(current, "AH", parseCrownAsianTriple(ah.value), now);
    }
    if (ou.status === "fulfilled") {
      append(opening, "OU", parseCrownOpeningAsianTriple(ou.value), null);
      append(current, "OU", parseCrownAsianTriple(ou.value), now);
    }
    return { opening, current, sourceUrls };
  }

  private async fetchTitanPrices(sId: string): Promise<ProviderPrice[]> {
    const prices: ProviderPrice[] = [];
    const now = Date.now();

    const [ah, ou, x2] = await Promise.allSettled([
      fetchText(`${VIP}/AsianOdds_n.aspx?id=${sId}`, { timeoutMs: 30_000, retries: 1 }),
      fetchText(`${VIP}/OverDown_n.aspx?id=${sId}`, { timeoutMs: 30_000, retries: 1 }),
      fetchText(`${X2}/${sId}.js`, { timeoutMs: 20_000, retries: 0 }),
    ]);

    let rowFound = false;
    if (ah.status === "fulfilled") {
      const row = parsePinnacleAsianTriple(ah.value);
      if (row) {
        rowFound = true;
        this.lastRowMatchedBy = row.matchedBy;
        this.lastRowCompanyId = row.companyId;
        if (row.matchedBy === "id-hint") {
          this.warn(`Pinnacle row resolved by configured id hint (${row.companyId}); visible label did not match a Pinnacle alias`);
        }
        const lineValue = parsePinnacleHandicap(row.goals);
        if (lineValue !== null) {
          prices.push({ market: "AH", lineValue, isMain: true, selection: "H", decimalOdds: hkToDecimal(row.home), sourceUpdatedAt: now });
          prices.push({ market: "AH", lineValue, isMain: true, selection: "A", decimalOdds: hkToDecimal(row.away), sourceUpdatedAt: now });
        }
      }
    }
    if (ou.status === "fulfilled") {
      const row = parsePinnacleAsianTriple(ou.value);
      if (row) {
        rowFound = true;
        const lineValue = parsePinnacleTotal(Math.abs(row.goals));
        if (lineValue !== null) {
          prices.push({ market: "OU", lineValue, isMain: true, selection: "O", decimalOdds: hkToDecimal(row.home), sourceUpdatedAt: now });
          prices.push({ market: "OU", lineValue, isMain: true, selection: "U", decimalOdds: hkToDecimal(row.away), sourceUpdatedAt: now });
        }
      }
    }
    if (x2.status === "fulfilled") {
      const row = parsePinnacle1X2(x2.value);
      if (row) {
        rowFound = true;
        prices.push({ market: "1X2", lineValue: null, isMain: true, selection: "H", decimalOdds: row.h, sourceUpdatedAt: now });
        prices.push({ market: "1X2", lineValue: null, isMain: true, selection: "D", decimalOdds: row.d, sourceUpdatedAt: now });
        prices.push({ market: "1X2", lineValue: null, isMain: true, selection: "A", decimalOdds: row.a, sourceUpdatedAt: now });
      }
    }
    if (ah.status === "rejected" && ou.status === "rejected" && x2.status === "rejected") {
      throw new Error(`Pinnacle detail unavailable for ${sId}: ${(ah.reason as Error)?.message ?? "unknown"}`);
    }
    if (rowFound) {
      this.missingRows.delete(sId);
    } else {
      this.missingRows.add(sId);
      this.warn(
        `${this.missingRows.size} 場在 titan007 未列出 Pinnacle 賠率，該些場次會留空（絕不以其他書商替代）`,
      );
    }
    return prices;
  }

  /**
   * Final scores. Scores are neutral match data and always come from titan007's
   * played-fixture pages (no odds are read here). Keep titan's own ID and
   * fixture identity so a stale mapping can safely fall back to team + kickoff
   * matching at settlement time.
   */
  async fetchResults(dayOffsets: number[] = [0, -1, -2]): Promise<FinalResult[]> {
    const out: FinalResult[] = [];
    const now = Date.now();
    for (const off of dayOffsets) {
      const key = ymd(new Date(now + off * 86_400_000));
      for (const kind of off === 0 ? ["Over", "Next"] : ["Over"]) {
        try {
          const html = await fetchText(`${BF}/${kind}_${key}.htm`, {
            charset: "gb18030",
            timeoutMs: 25_000,
            retries: 1,
          });
          for (const f of parseSchedulePage(html, key)) {
            if (f.homeScore === null || f.awayScore === null) continue;
            const finished = /完|-1/.test(f.statusText) || off < 0;
            if (!finished) continue;
            out.push({
              // Settlement uses the titan ID as a fast path, then falls back
              // to the original fixture identity (teams + kickoff) if an ID
              // mapping is stale or absent. Never collapse that evidence into
              // an active odds-provider ID here.
              providerMatchId: f.providerMatchId,
              league: f.league,
              homeTeam: f.homeTeam,
              awayTeam: f.awayTeam,
              kickoffUtc: f.kickoffUtc,
              homeScore: f.homeScore,
              awayScore: f.awayScore,
              halfHome: f.halfHome,
              halfAway: f.halfAway,
              source: off === 0 ? "titan_today" : `titan_over_${key}`,
            });
          }
          break;
        } catch {
          /* next kind/day */
        }
      }
    }
    return out.filter((r) => r.providerMatchId);
  }

}

export function pinnacleFixtureToEvent(f: PinnacleFixture, prices: ProviderPrice[]): ProviderEvent {
  return {
    providerMatchId: f.providerMatchId,
    league: f.league,
    homeTeam: f.homeTeam,
    awayTeam: f.awayTeam,
    kickoffUtc: f.kickoffUtc,
    inplay: false,
    status: f.statusText || "scheduled",
    prices,
  };
}
