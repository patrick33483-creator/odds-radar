import type { Market, Selection } from "@shared/types";

export interface ProviderPrice {
  market: Market;
  /** normalized line value (quarter steps); null for 1X2 */
  lineValue: number | null;
  isMain: boolean;
  selection: Selection;
  decimalOdds: number;
  sourceUpdatedAt?: number | null;
}

export interface ProviderEvent {
  providerMatchId: string;
  league: string;
  leagueEn?: string | null;
  homeTeam: string;
  awayTeam: string;
  homeTeamEn?: string | null;
  awayTeamEn?: string | null;
  kickoffUtc: number;
  inplay: boolean;
  status: string;
  prices: ProviderPrice[];
}

export interface ProviderFetchResult {
  events: ProviderEvent[];
  latencyMs: number;
  partial: boolean;
  warnings: string[];
}

/** Every provider adapter is isolated behind this interface and is replaceable. */
export interface OddsProvider {
  readonly name: "hkjc" | "pinnacle";
  /** Pre-match events with raw tradeable decimal prices. Never in-play. */
  fetchPreMatch(opts?: { windowMinutes?: number; matchIds?: string[] }): Promise<ProviderFetchResult>;
}

export interface FinalResult {
  providerMatchId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: number;
  homeScore: number;
  awayScore: number;
  halfHome?: number | null;
  halfAway?: number | null;
  source: string;
}
