/**
 * Expected value (正期望值) using Pinnacle no-vig probabilities as the true-probability
 * baseline. Simulation only — never used for notifications.
 */

import type { EvOpportunity, Market, Selection } from "@shared/types";

export const EV_THRESHOLD = 0.03;
export const HKJC_FIXED_STAKE = 10000;
/** A price this far from the Pinnacle fair price is treated as suspicious. */
export const OUTLIER_RATIO = 0.35;
/** Prices older than this are treated as stale and excluded. */
export const STALE_MS = 90_000;
export const MIN_MAPPING_CONFIDENCE = 0.8;

/** Remove the bookmaker margin by proportional normalization. */
export function noVigProbs(odds: number[]): number[] | null {
  if (odds.some((o) => !(o > 1))) return null;
  const raw = odds.map((o) => 1 / o);
  const sum = raw.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  return raw.map((r) => r / sum);
}

export function margin(odds: number[]): number | null {
  if (odds.some((o) => !(o > 1))) return null;
  return odds.reduce((a, o) => a + 1 / o, 0) - 1;
}

export interface EvInput {
  matchId: string;
  matchLabel: string;
  league: string;
  kickoffUtc: number;
  market: Market;
  lineKey: string;
  lineDisplay: string;
  /** Pinnacle prices for the full complementary set of the same exact line. */
  pinnacle: Array<{ selection: Selection; decimalOdds: number }>;
  /** HKJC prices on the same exact line. */
  hkjc: Array<{ selection: Selection; decimalOdds: number; fetchedAt: number }>;
  now: number;
  mappingConfidence: number;
  threshold?: number;
  stake?: number;
}

/**
 * Evaluate every HKJC selection on one exact line against the Pinnacle no-vig fair
 * price. Returns opportunities at or above the threshold, annotated with
 * safeguard flags.
 */
export function evaluateEv(input: EvInput): EvOpportunity[] {
  const threshold = input.threshold ?? EV_THRESHOLD;
  const stake = input.stake ?? HKJC_FIXED_STAKE;
  if (input.pinnacle.length < 2) return [];
  const probs = noVigProbs(input.pinnacle.map((c) => c.decimalOdds));
  if (!probs) return [];
  const fairBySelection = new Map<Selection, number>();
  input.pinnacle.forEach((c, i) => fairBySelection.set(c.selection, probs[i]));

  const out: EvOpportunity[] = [];
  for (const leg of input.hkjc) {
    const p = fairBySelection.get(leg.selection);
    if (p === undefined || !(p > 0)) continue;
    if (!(leg.decimalOdds > 1)) continue;
    const edge = p * leg.decimalOdds - 1;
    if (!(edge >= threshold)) continue;
    const fairOdds = 1 / p;
    const flags: string[] = [];
    if (input.now - leg.fetchedAt > STALE_MS) flags.push("stale");
    if (leg.decimalOdds / fairOdds - 1 > OUTLIER_RATIO) flags.push("outlier");
    if (input.mappingConfidence < MIN_MAPPING_CONFIDENCE) flags.push("low_confidence");
    out.push({
      key: `ev|${input.matchId}|${input.market}|${input.lineKey}|${leg.selection}`,
      matchId: input.matchId,
      matchLabel: input.matchLabel,
      league: input.league,
      kickoffUtc: input.kickoffUtc,
      market: input.market,
      lineKey: input.lineKey,
      lineDisplay: input.lineDisplay,
      selection: leg.selection,
      hkjcOdds: leg.decimalOdds,
      fairOdds: Math.round(fairOdds * 1000) / 1000,
      trueProb: Math.round(p * 1e6) / 1e6,
      edge: Math.round(edge * 1e6) / 1e6,
      stake,
      expectedProfit: Math.round(stake * edge * 100) / 100,
      flags,
    });
  }
  return out;
}

/** Opportunities that pass every safeguard (used for simulated purchases). */
export function isSafe(op: EvOpportunity): boolean {
  return op.flags.length === 0;
}
