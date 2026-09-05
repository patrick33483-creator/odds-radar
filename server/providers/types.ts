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

/**
 * A fixture's running corner count, observable only while it is in play.
 * HKJC's historic result query never populates the confirmed corner figure and
 * ended fixtures leave the pre-match feed, so this is the only way to retain a
 * corner count at all.
 */
export interface LiveCornerObservation {
  providerMatchId: string;
  status: string;
  corner: number;
  homeCorner: number | null;
  awayCorner: number | null;
}

export interface ProviderFetchResult {
  events: ProviderEvent[];
  /** Present only for providers that expose in-play corner counts. */
  liveCorners?: LiveCornerObservation[];
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
