/**
 * Pinnacle OFFICIAL API strategy (strategy "a").
 *
 * Pinnacle's own API documentation states that **general public access to the
 * API was closed on 23 July 2025**; only approved partners/customers keep
 * access. Approved access is plain HTTPS + JSON with HTTP Basic authentication
 * and the sports / fixtures / odds endpoints used below.
 *   docs: https://github.com/pinnacleapi/pinnacleapi-documentation
 *
 * This strategy therefore activates ONLY when both PINNACLE_API_USERNAME and
 * PINNACLE_API_PASSWORD are supplied. Without credentials the adapter falls
 * back to the credential-free titan007 strategy (see pinnacle.ts). It never
 * falls back to a different bookmaker.
 *
 * Env:
 *   PINNACLE_API_USERNAME / PINNACLE_API_PASSWORD  approved credentials
 *   PINNACLE_API_BASE      default https://api.pinnacle.com
 *   PINNACLE_SPORT_ID      default 29 (Soccer)
 */

import { fetchJson } from "../lib/http";
import type { ProviderPrice } from "./types";
import { snapToQuarter } from "../lib/lines";

export const OFFICIAL_API_CLOSED_NOTE =
  "Pinnacle 官方公開 API 自 2025-07-23 起不再對一般公眾開放；只有獲批帳戶可用（HTTPS/JSON + Basic 認證）。";

export interface ApiFixture {
  providerMatchId: string; // "api:<eventId>"
  league: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: number;
  live: boolean;
}

interface FixturesResponse {
  sportId: number;
  last: number;
  league?: Array<{
    id: number;
    name?: string;
    events?: Array<{
      id: number;
      starts: string;
      home: string;
      away: string;
      liveStatus?: number;
      status?: string;
      parlayRestriction?: number;
    }>;
  }>;
}

interface OddsResponse {
  sportId: number;
  leagues?: Array<{
    id: number;
    events?: Array<{
      id: number;
      periods?: Array<{
        number: number;
        moneyline?: { home: number; draw?: number; away: number };
        spreads?: Array<{ hdp: number; home: number; away: number; altLineId?: number }>;
        totals?: Array<{ points: number; over: number; under: number; altLineId?: number }>;
      }>;
    }>;
  }>;
}

export function hasOfficialCredentials(): boolean {
  return !!(process.env.PINNACLE_API_USERNAME && process.env.PINNACLE_API_PASSWORD);
}

function base(): string {
  return process.env.PINNACLE_API_BASE ?? "https://api.pinnacle.com";
}

function sportId(): string {
  return process.env.PINNACLE_SPORT_ID ?? "29";
}

function authHeaders(): Record<string, string> {
  const user = process.env.PINNACLE_API_USERNAME ?? "";
  const pass = process.env.PINNACLE_API_PASSWORD ?? "";
  const token = Buffer.from(`${user}:${pass}`).toString("base64");
  return { authorization: `Basic ${token}`, accept: "application/json" };
}

export function apiEventId(providerMatchId: string): string {
  return providerMatchId.startsWith("api:") ? providerMatchId.slice(4) : providerMatchId;
}

/** Pre-match fixtures from /v1/fixtures. In-play events are dropped. */
export async function fetchApiFixtures(): Promise<ApiFixture[]> {
  const url = `${base()}/v1/fixtures?sportId=${sportId()}`;
  const data = await fetchJson<FixturesResponse>(url, { headers: authHeaders(), timeoutMs: 25_000, retries: 1 });
  const out: ApiFixture[] = [];
  for (const league of data.league ?? []) {
    for (const ev of league.events ?? []) {
      const kickoffUtc = Date.parse(ev.starts);
      if (!Number.isFinite(kickoffUtc)) continue;
      const live = (ev.liveStatus ?? 0) === 1;
      if (live) continue; // pre-match only
      out.push({
        providerMatchId: `api:${ev.id}`,
        league: league.name ?? String(league.id),
        homeTeam: ev.home,
        awayTeam: ev.away,
        kickoffUtc,
        live,
      });
    }
  }
  return out;
}

/**
 * Decimal prices for one event from /v1/odds (period 0 = full time).
 * Pinnacle spreads use `hdp` from the HOME perspective with the SAME sign
 * convention as ours (negative = home gives), so no negation is applied.
 */
export async function fetchApiPrices(providerMatchId: string): Promise<ProviderPrice[]> {
  const id = apiEventId(providerMatchId);
  const url = `${base()}/v1/odds?sportId=${sportId()}&oddsFormat=Decimal&eventIds=${id}`;
  const data = await fetchJson<OddsResponse>(url, { headers: authHeaders(), timeoutMs: 25_000, retries: 1 });
  const now = Date.now();
  const prices: ProviderPrice[] = [];
  for (const league of data.leagues ?? []) {
    for (const ev of league.events ?? []) {
      if (String(ev.id) !== id) continue;
      const ft = (ev.periods ?? []).find((p) => p.number === 0);
      if (!ft) continue;
      if (ft.moneyline && ft.moneyline.home > 1 && ft.moneyline.away > 1) {
        prices.push({ market: "1X2", lineValue: null, isMain: true, selection: "H", decimalOdds: ft.moneyline.home, sourceUpdatedAt: now });
        if (ft.moneyline.draw && ft.moneyline.draw > 1) {
          prices.push({ market: "1X2", lineValue: null, isMain: true, selection: "D", decimalOdds: ft.moneyline.draw, sourceUpdatedAt: now });
        }
        prices.push({ market: "1X2", lineValue: null, isMain: true, selection: "A", decimalOdds: ft.moneyline.away, sourceUpdatedAt: now });
      }
      const spreads = (ft.spreads ?? []).filter((s) => s.home > 1 && s.away > 1);
      spreads.forEach((s, i) => {
        const lineValue = snapToQuarter(s.hdp);
        if (Math.abs(lineValue - s.hdp) > 1e-9) return;
        prices.push({ market: "AH", lineValue, isMain: i === 0, selection: "H", decimalOdds: s.home, sourceUpdatedAt: now });
        prices.push({ market: "AH", lineValue, isMain: i === 0, selection: "A", decimalOdds: s.away, sourceUpdatedAt: now });
      });
      const totals = (ft.totals ?? []).filter((t) => t.over > 1 && t.under > 1);
      totals.forEach((t, i) => {
        const lineValue = snapToQuarter(t.points);
        if (Math.abs(lineValue - t.points) > 1e-9) return;
        prices.push({ market: "OU", lineValue, isMain: i === 0, selection: "O", decimalOdds: t.over, sourceUpdatedAt: now });
        prices.push({ market: "OU", lineValue, isMain: i === 0, selection: "U", decimalOdds: t.under, sourceUpdatedAt: now });
      });
    }
  }
  return prices;
}
