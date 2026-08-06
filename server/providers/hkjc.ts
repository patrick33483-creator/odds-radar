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
import { lineKeyOf, parseHkjcHandicap, parseHkjcTotal } from "../lib/lines";
import type { OddsProvider, ProviderEvent, ProviderFetchResult, ProviderPrice } from "./types";
import type { Selection } from "@shared/types";

const ENDPOINT = "https://info.cld.hkjc.com/graphql/base/";

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

const SELECTION_MAP: Record<string, Selection> = { H: "H", D: "D", A: "A", L: "U" };

function toEpoch(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
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
}

export const lineKey = lineKeyOf;
