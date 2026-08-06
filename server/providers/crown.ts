/**
 * Crown 皇冠 adapter — sourced from titan007 / 球探網, companyID = 3 ("Crow*").
 *
 * Endpoints (all gb18030-encoded HTML unless noted):
 *   fixtures  : http://bf.titan007.com/football/Next_YYYYMMDD.htm   (upcoming)
 *               http://bf.titan007.com/football/Over_YYYYMMDD.htm   (completed + scores)
 *   handicap  : http://vip.titan007.com/AsianOdds_n.aspx?id=<sId>
 *   totals    : http://vip.titan007.com/OverDown_n.aspx?id=<sId>
 *   1X2       : http://1x2d.titan007.com/<sId>.js  (UTF-8 JS; Crown is usually
 *               absent there because it is an Asian-only book on titan007)
 *
 * Conventions:
 *   - Prices are HONG KONG odds -> decimal = hk + 1.
 *   - `goals` is signed with POSITIVE = home gives; our internal convention is
 *     the opposite, so it is negated in parseCrownHandicap().
 *   - Only the `oddstype="wholeOdds"` (current full-time) triple is used, and
 *     only for fixtures that have not kicked off — pre-match only.
 */

import { fetchText } from "../lib/http";
import { hkToDecimal, parseCrownHandicap, parseCrownTotal } from "../lib/lines";
import type { FinalResult, ProviderEvent, ProviderPrice } from "./types";

const BF = "http://bf.titan007.com/football";
const VIP = "http://vip.titan007.com";
const HK_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
}

export interface CrownFixture {
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
export function parseSchedulePage(html: string, yyyymmdd: string): CrownFixture[] {
  const out: CrownFixture[] = [];
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

interface CrownRowTriple {
  home: number;
  goals: number;
  away: number;
}

/**
 * Extract the Crown (companyID 3) current full-time triple from an
 * AsianOdds_n / OverDown_n page.
 */
export function parseCrownRow(html: string): CrownRowTriple | null {
  let fallback: CrownRowTriple | null = null;
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html))) {
    const row = m[1];
    if (!/data-id="3"|companyID='3'|companyID="3"/.test(row)) continue;
    // titan007 emits two "current" triples and toggles which one is visible
    // depending on match state (`wholeOdds` / `wholeLastOdds`). Prefer the
    // visible triple; fall back to the hidden one.
    for (const type of ["wholeLastOdds", "wholeOdds"]) {
      const cells = row.match(new RegExp(`<td[^>]*oddstype="${type}"[^>]*>[\\s\\S]*?<\\/td>`, "g"));
      if (!cells || cells.length < 3) continue;
      const visible = !cells.some((c) => /display:\s*none/.test(c));
      const home = Number(stripTags(cells[0]));
      const goals = Number(cells[1].match(/goals="(-?[\d.]+)"/)?.[1]);
      const away = Number(stripTags(cells[2]));
      if (![home, goals, away].every(Number.isFinite)) continue;
      if (visible) return { home, goals, away };
      fallback = fallback ?? { home, goals, away };
    }
  }
  return fallback;
}

/** Extract Crown 1X2 from titan007's European-odds JS, if present. */
export function parseCrown1X2(js: string): { h: number; d: number; a: number } | null {
  const m = js.match(/var\s+game\s*=\s*Array\(([\s\S]*?)\);/);
  if (!m) return null;
  const items = Array.from(m[1].matchAll(/"([^"]*)"/g)).map((x) => x[1]);
  for (const it of items) {
    const p = it.split("|");
    if (p[0] !== "3") continue;
    const h = Number(p[10]);
    const d = Number(p[11]);
    const a = Number(p[12]);
    if ([h, d, a].every((v) => Number.isFinite(v) && v > 1)) return { h, d, a };
  }
  return null;
}

function ymd(date: Date): string {
  const hk = new Date(date.getTime() + HK_TZ_OFFSET_MS);
  return `${hk.getUTCFullYear()}${String(hk.getUTCMonth() + 1).padStart(2, "0")}${String(hk.getUTCDate()).padStart(2, "0")}`;
}

export class CrownProvider {
  readonly name = "crown" as const;

  /** Fixture list for the HK-local day offsets given (0 = today). */
  async fetchFixtures(dayOffsets: number[] = [0, 1]): Promise<CrownFixture[]> {
    const out: CrownFixture[] = [];
    const now = Date.now();
    for (const off of dayOffsets) {
      const key = ymd(new Date(now + off * 86_400_000));
      // Upcoming days live under Next_, elapsed days under Over_. Today can be
      // in either, so try Next_ first and fall back.
      for (const kind of off >= 0 ? ["Next", "Over"] : ["Over", "Next"]) {
        try {
          const html = await fetchText(`${BF}/${kind}_${key}.htm`, {
            charset: "gb18030",
            timeoutMs: 25_000,
            retries: 1,
          });
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
    // de-duplicate by providerMatchId
    const seen = new Set<string>();
    return out.filter((f) => (seen.has(f.providerMatchId) ? false : (seen.add(f.providerMatchId), true)));
  }

  /** Crown prices for one titan007 match id. Any missing market is simply absent. */
  async fetchMatchPrices(sId: string): Promise<ProviderPrice[]> {
    const prices: ProviderPrice[] = [];
    const now = Date.now();

    const [ah, ou, x2] = await Promise.allSettled([
      fetchText(`${VIP}/AsianOdds_n.aspx?id=${sId}`, { timeoutMs: 30_000, retries: 1 }),
      fetchText(`${VIP}/OverDown_n.aspx?id=${sId}`, { timeoutMs: 30_000, retries: 1 }),
      fetchText(`http://1x2d.titan007.com/${sId}.js`, { timeoutMs: 20_000, retries: 0 }),
    ]);

    if (ah.status === "fulfilled") {
      const row = parseCrownRow(ah.value);
      if (row) {
        const lineValue = parseCrownHandicap(row.goals);
        if (lineValue !== null) {
          prices.push({ market: "AH", lineValue, isMain: true, selection: "H", decimalOdds: hkToDecimal(row.home), sourceUpdatedAt: now });
          prices.push({ market: "AH", lineValue, isMain: true, selection: "A", decimalOdds: hkToDecimal(row.away), sourceUpdatedAt: now });
        }
      }
    }
    if (ou.status === "fulfilled") {
      const row = parseCrownRow(ou.value);
      if (row) {
        const lineValue = parseCrownTotal(Math.abs(row.goals));
        if (lineValue !== null) {
          prices.push({ market: "OU", lineValue, isMain: true, selection: "O", decimalOdds: hkToDecimal(row.home), sourceUpdatedAt: now });
          prices.push({ market: "OU", lineValue, isMain: true, selection: "U", decimalOdds: hkToDecimal(row.away), sourceUpdatedAt: now });
        }
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
    if (
      ah.status === "rejected" &&
      ou.status === "rejected" &&
      x2.status === "rejected"
    ) {
      throw new Error(`Crown detail unavailable for ${sId}: ${(ah.reason as Error)?.message ?? "unknown"}`);
    }
    return prices;
  }

  /** Final results: today's schedule page first, historical Over_ pages as fallback. */
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
              providerMatchId: f.providerMatchId,
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
    return out;
  }
}

export function crownFixtureToEvent(f: CrownFixture, prices: ProviderPrice[]): ProviderEvent {
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
