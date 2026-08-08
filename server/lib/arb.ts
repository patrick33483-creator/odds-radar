/**
 * Arbitrage (鎖利) math.
 *
 * Rules enforced here:
 *  - Same event + same market + EXACT same normalized line only.
 *  - Two-way legs must be genuinely complementary (H/A on the same handicap,
 *    O/U on the same total).
 *  - 1X2 requires ALL THREE outcomes to be covered. Two of three is never
 *    treated as full coverage.
 *  - q = Σ 1/O. Arbitrage only when q < 1.
 *  - Every Crown selection is capped at HK$5,000 (user preference); the HKJC
 *    stake is back-calculated for equal payout and is uncapped.
 */

import type { ArbOpportunity, BetLeg, Market, Provider, Selection } from "@shared/types";

export const CROWN_FIXED_STAKE = 5000;

export function impliedProb(decimalOdds: number): number {
  if (!(decimalOdds > 1)) return Number.POSITIVE_INFINITY;
  return 1 / decimalOdds;
}

export function totalProbability(odds: number[]): number {
  return odds.reduce((acc, o) => acc + impliedProb(o), 0);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface LegInput {
  provider: Provider;
  selection: Selection;
  decimalOdds: number;
  label: string;
  market: Market;
  lineKey: string;
  lineDisplay: string;
}

export interface StakePlan {
  legs: BetLeg[];
  totalStake: number;
  payout: number;
  profit: number;
  roi: number;
}

/**
 * Size all legs for an equal payout, with no Crown selection above HK$5,000.
 * When several Crown legs exist (only possible in the 3-way structure), the
 * lowest-priced Crown leg is the HK$5,000 anchor. Every other Crown leg then
 * requires an equal or smaller stake for the same payout.
 */
export function planStakes(legs: LegInput[], crownStake = CROWN_FIXED_STAKE): StakePlan | null {
  if (legs.length < 2) return null;
  const crownLegs = legs.filter((l) => l.provider === "crown");
  const anchor = crownLegs.length
    ? crownLegs.reduce((a, b) => (b.decimalOdds < a.decimalOdds ? b : a))
    : null;
  if (!anchor) return null; // cross-book structure requires a Crown leg
  const targetPayout = crownStake * anchor.decimalOdds;
  const out: BetLeg[] = legs.map((l) => ({
    provider: l.provider,
    label: l.label,
    market: l.market,
    lineKey: l.lineKey,
    lineDisplay: l.lineDisplay,
    selection: l.selection,
    decimalOdds: l.decimalOdds,
    stake: round2(targetPayout / l.decimalOdds),
  }));
  const totalStake = round2(out.reduce((a, l) => a + l.stake, 0));
  const payout = round2(targetPayout);
  const profit = round2(payout - totalStake);
  return { legs: out, totalStake, payout, profit, roi: totalStake > 0 ? profit / totalStake : 0 };
}

export interface TwoWayInput {
  matchId: string;
  matchLabel: string;
  league: string;
  kickoffUtc: number;
  market: Extract<Market, "AH" | "OU">;
  lineKey: string;
  lineDisplay: string;
  /** HKJC price for one side and Crown price for the complementary side. */
  hkjc: { selection: Selection; decimalOdds: number };
  crown: { selection: Selection; decimalOdds: number };
}

const COMPLEMENTS: Record<string, string> = { H: "A", A: "H", O: "U", U: "O" };

export function isComplementaryPair(a: Selection, b: Selection): boolean {
  return COMPLEMENTS[a] === b;
}

/** Two-way complementary arbitrage on one exact line. Returns null when q >= 1. */
export function findTwoWayArb(input: TwoWayInput, crownStake = CROWN_FIXED_STAKE): ArbOpportunity | null {
  const { hkjc, crown } = input;
  if (!isComplementaryPair(hkjc.selection, crown.selection)) return null;
  if (!(hkjc.decimalOdds > 1) || !(crown.decimalOdds > 1)) return null;
  const q = impliedProb(hkjc.decimalOdds) + impliedProb(crown.decimalOdds);
  if (!(q < 1)) return null;
  const plan = planStakes(
    [
      {
        provider: "crown",
        selection: crown.selection,
        decimalOdds: crown.decimalOdds,
        label: "皇冠",
        market: input.market,
        lineKey: input.lineKey,
        lineDisplay: input.lineDisplay,
      },
      {
        provider: "hkjc",
        selection: hkjc.selection,
        decimalOdds: hkjc.decimalOdds,
        label: "馬會",
        market: input.market,
        lineKey: input.lineKey,
        lineDisplay: input.lineDisplay,
      },
    ],
    crownStake,
  );
  if (!plan) return null;
  return {
    key: `arb|${input.matchId}|${input.market}|${input.lineKey}|${hkjc.selection}`,
    matchId: input.matchId,
    matchLabel: input.matchLabel,
    league: input.league,
    kickoffUtc: input.kickoffUtc,
    market: input.market,
    lineKey: input.lineKey,
    lineDisplay: input.lineDisplay,
    q: Math.round(q * 1e6) / 1e6,
    structure: "two-way-complementary",
    ...plan,
  };
}

export interface ThreeWayInput {
  matchId: string;
  matchLabel: string;
  league: string;
  kickoffUtc: number;
  hkjc: Partial<Record<"H" | "D" | "A", number>>;
  crown: Partial<Record<"H" | "D" | "A", number>>;
}

/**
 * 1X2 cover structure. Requires H, D and A to all be available from at least
 * one book, and at least one leg to come from Crown. Picks the best price per
 * outcome. Two of three outcomes is never accepted.
 */
export function findThreeWayArb(input: ThreeWayInput, crownStake = CROWN_FIXED_STAKE): ArbOpportunity | null {
  const outcomes: Array<"H" | "D" | "A"> = ["H", "D", "A"];
  const picks: LegInput[] = [];
  for (const o of outcomes) {
    const h = input.hkjc[o];
    const c = input.crown[o];
    const best = Math.max(h && h > 1 ? h : 0, c && c > 1 ? c : 0);
    if (!(best > 1)) return null; // incomplete coverage -> not an arb
    const provider: Provider = c && c === best ? "crown" : "hkjc";
    picks.push({
      provider,
      selection: o,
      decimalOdds: best,
      label: provider === "crown" ? "皇冠" : "馬會",
      market: "1X2",
      lineKey: "",
      lineDisplay: "—",
    });
  }
  if (!picks.some((p) => p.provider === "crown")) return null;
  const q = totalProbability(picks.map((p) => p.decimalOdds));
  if (!(q < 1)) return null;
  const plan = planStakes(picks, crownStake);
  if (!plan) return null;
  return {
    key: `arb|${input.matchId}|1X2||HDA`,
    matchId: input.matchId,
    matchLabel: input.matchLabel,
    league: input.league,
    kickoffUtc: input.kickoffUtc,
    market: "1X2",
    lineKey: "",
    lineDisplay: "—",
    q: Math.round(q * 1e6) / 1e6,
    structure: "three-way-cover",
    ...plan,
  };
}
