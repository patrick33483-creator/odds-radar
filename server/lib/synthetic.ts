/**
 * 合成賠率 — synthetic Asian-handicap prices built from HKJC 1X2 (主客和) prices.
 *
 * PURE MATH. No network calls: it reuses the 1X2 and handicap prices already
 * fetched for the dashboard.
 *
 * Exact-payoff formulas using HKJC 1X2 and selected official handicap prices.
 * They are valid EV execution alternatives only when every result state
 * (full win, half win, push, half loss and loss) has the same return as the
 * target Asian-handicap selection.
 *
 *  1. 合成「受讓 +0.5」(雙重機會 D or A)
 *       stakes: 買和局 W·O_A/(O_D+O_A) ; 買客勝 W·O_D/(O_D+O_A)
 *       O_syn(+0.5) = O_D·O_A / (O_D + O_A)
 *
 *  2. 合成「受讓 +0」(平手盤 / DNB — 打和退還本金)
 *       stakes: 買和局(保本) W/O_D ; 買客勝(利潤層) W − W/O_D
 *       O_syn(+0) = O_A·(O_D − 1) / O_D
 *
 *  3. 合成「受讓 +0.25」(受讓半平)
 *       Blend +0 and +0.5 with profit-weighted stakes so the draw-state return
 *       exactly matches a quoted +0.25 bet.
 *
 *  4. 合成「受讓 +0.75」(受讓半一)
 *       ½W by the +0.5 formula, ½W on the OFFICIAL 讓球 +1.0 price O_(+1.0)
 *       O_syn(+0.75) = ( O_syn(+0.5) + O_(+1.0) ) / 2
 *
 *  5. 合成「讓 -0.5」= the same side's 1X2 outright win.
 *
 *  6. 合成「讓 -0.25」= half synthetic +0 and half outright -0.5.
 *
 *  7. 合成「讓 -0.75」= profit-weighted outright -0.5 and official -1.0,
 *       preserving the exact one-goal winning return.
 *
 * Home and away mirror one another with the appropriate outright price.
 */

import type { BetLeg, Selection } from "@shared/types";
import { formatHandicap } from "./lines";

export type SynSide = "home" | "away";
export const SYNTHETIC_TARGETS = [0, 0.25, 0.5, 0.75] as const;
export const EV_SYNTHETIC_TARGETS = [-0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75] as const;
export type SynTarget = (typeof EV_SYNTHETIC_TARGETS)[number];

export interface SynInputs {
  /** HKJC 1X2 prices. */
  oddsHome: number;
  oddsDraw: number;
  oddsAway: number;
  /**
   * Official HKJC handicap price for the +1.0 line on the same side
   * (home handicap +1.0 for side='home', -1.0 for side='away').
   */
  official1?: number | null;
  /** Official HKJC handicap price for the -1.0 line on the same side. */
  officialMinus1?: number | null;
}

export interface SyntheticQuote {
  side: SynSide;
  target: SynTarget;
  /** Handicap received by `side`, as a signed home handicap. */
  homeHandicap: number;
  lineDisplay: string;
  odds: number;
  formula: string;
  components: BetLeg[];
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function leg(
  selection: Selection,
  decimalOdds: number,
  stake: number,
  detail: string,
  market: "1X2" | "AH" = "1X2",
  lineKey = "",
  lineDisplay = "—",
): BetLeg {
  return {
    provider: "hkjc-synthetic",
    label: "馬會（合成）",
    market,
    lineKey,
    lineDisplay,
    selection,
    decimalOdds: r3(decimalOdds),
    stake: r2(stake),
    synthetic: true,
    syntheticDetail: detail,
  };
}

/** O_syn(+0.5) = O_D·O_S/(O_D+O_S) with the equal-payout split. */
function syn05(oD: number, oS: number, side: SynSide, W: number) {
  const odds = (oD * oS) / (oD + oS);
  const stakeDraw = (W * oS) / (oD + oS);
  const stakeSide = (W * oD) / (oD + oS);
  const sel: Selection = side === "away" ? "A" : "H";
  return {
    odds,
    components: [
      leg("D", oD, stakeDraw, "和局（+0.5 等額拆分）"),
      leg(sel, oS, stakeSide, side === "away" ? "客勝（+0.5 等額拆分）" : "主勝（+0.5 等額拆分）"),
    ],
  };
}

/** O_syn(+0) = O_S·(O_D−1)/O_D, draw returns the principal. */
function syn00(oD: number, oS: number, side: SynSide, W: number) {
  const odds = (oS * (oD - 1)) / oD;
  const stakeDraw = W / oD;
  const stakeSide = W - W / oD;
  const sel: Selection = side === "away" ? "A" : "H";
  return {
    odds,
    components: [
      leg("D", oD, stakeDraw, "和局（保本層）"),
      leg(sel, oS, stakeSide, side === "away" ? "客勝（利潤層）" : "主勝（利潤層）"),
    ],
  };
}

function mergeComponents(a: BetLeg[], b: BetLeg[]): BetLeg[] {
  const out: BetLeg[] = [];
  for (const l of [...a, ...b]) {
    const hit = out.find(
      (o) => o.selection === l.selection && o.market === l.market && o.lineKey === l.lineKey,
    );
    if (hit) {
      hit.stake = r2(hit.stake + l.stake);
      hit.syntheticDetail = `${hit.syntheticDetail} + ${l.syntheticDetail}`;
    } else {
      out.push({ ...l });
    }
  }
  return out;
}

/** Keep executable component stakes equal to the requested total after cent rounding. */
function normalizeStakeTotal(components: BetLeg[], totalStake: number): BetLeg[] {
  const out = components.map((component) => ({ ...component }));
  if (out.length === 0) return out;

  const currentTotal = r2(out.reduce((sum, component) => sum + component.stake, 0));
  const residual = r2(r2(totalStake) - currentTotal);
  if (residual !== 0) {
    let largestIndex = 0;
    for (let index = 1; index < out.length; index += 1) {
      if (out[index].stake > out[largestIndex].stake) largestIndex = index;
    }
    out[largestIndex].stake = r2(out[largestIndex].stake + residual);
  }
  return out;
}

/**
 * Build a synthetic quote. Returns null when the structure is not valid
 * (missing inputs, non-positive odds, or a DNB layer that cannot break even).
 */
export function buildSynthetic(
  side: SynSide,
  target: SynTarget,
  inputs: SynInputs,
  totalStake: number,
): SyntheticQuote | null {
  const { oddsDraw: oD, official1, officialMinus1 } = inputs;
  const oS = side === "away" ? inputs.oddsAway : inputs.oddsHome;
  if (!(oD > 1) || !(oS > 1) || !(totalStake > 0)) return null;
  const homeHandicap = side === "away" ? -target : target;
  const lineDisplay = formatHandicap(side === "away" ? -target : target);

  let odds: number;
  let components: BetLeg[];
  let formula: string;

  if (target === -0.5) {
    odds = oS;
    const sel: Selection = side === "away" ? "A" : "H";
    components = [leg(sel, oS, totalStake, side === "away" ? "客勝（-0.5 完全等價）" : "主勝（-0.5 完全等價）")];
    formula = "O_syn(-0.5) = O_S（主客和勝方）";
  } else if (target === -0.25) {
    const half = totalStake / 2;
    const a = syn00(oD, oS, side, half);
    if (!(a.odds > 1)) return null;
    const sel: Selection = side === "away" ? "A" : "H";
    const b = { odds: oS, components: [leg(sel, oS, half, side === "away" ? "客勝（-0.5 層）" : "主勝（-0.5 層）")] };
    odds = (a.odds + b.odds) / 2;
    components = mergeComponents(a.components, b.components);
    formula = "O_syn(-0.25) = ( O_syn(+0) + O_S ) / 2";
  } else if (target === -0.75) {
    if (!(officialMinus1 && officialMinus1 > 1)) return null;
    const denominator = oS + officialMinus1 - 2;
    if (!(denominator > 0)) return null;
    const outrightStake = totalStake * (officialMinus1 - 1) / denominator;
    const officialStake = totalStake - outrightStake;
    const sel: Selection = side === "away" ? "A" : "H";
    const officialHandicap = side === "away" ? 1 : -1;
    odds = (outrightStake * oS + officialStake * officialMinus1) / totalStake;
    components = mergeComponents(
      [leg(sel, oS, outrightStake, side === "away" ? "客勝（-0.5 層）" : "主勝（-0.5 層）")],
      [
        leg(
          sel,
          officialMinus1,
          officialStake,
          `官方讓球 ${formatHandicap(officialHandicap)}`,
          "AH",
          officialHandicap.toFixed(2),
          formatHandicap(officialHandicap),
        ),
      ],
    );
    formula = "O_syn(-0.75) = -0.5 與官方 -1.0 的等回報利潤加權";
  } else if (target === 0.5) {
    const s = syn05(oD, oS, side, totalStake);
    odds = s.odds;
    components = s.components;
    formula = "O_syn(+0.5) = O_D·O_S / (O_D + O_S)";
  } else if (target === 0) {
    if (!(oD > 1)) return null;
    const s = syn00(oD, oS, side, totalStake);
    if (!(s.odds > 1)) return null; // DNB layer cannot produce a tradeable price
    odds = s.odds;
    components = s.components;
    formula = "O_syn(+0) = O_S·(O_D − 1) / O_D";
  } else if (target === 0.25) {
    const probeA = syn00(oD, oS, side, 1);
    const probeB = syn05(oD, oS, side, 1);
    const denominator = probeA.odds + probeB.odds - 2;
    if (!(probeA.odds > 1) || !(denominator > 0)) return null;
    const dnbStake = totalStake * (probeB.odds - 1) / denominator;
    const plusHalfStake = totalStake - dnbStake;
    const a = syn00(oD, oS, side, dnbStake);
    const b = syn05(oD, oS, side, plusHalfStake);
    if (!(a.odds > 1)) return null;
    odds = (dnbStake * a.odds + plusHalfStake * b.odds) / totalStake;
    components = mergeComponents(a.components, b.components);
    formula = "O_syn(+0.25) = +0 與 +0.5 的等回報利潤加權";
  } else {
    if (!(official1 && official1 > 1)) return null; // needs the official +1.0 price
    const half = totalStake / 2;
    const b = syn05(oD, oS, side, half);
    odds = (b.odds + official1) / 2;
    const officialSel: Selection = side === "away" ? "A" : "H";
    const officialHandicap = side === "away" ? -1 : 1;
    components = mergeComponents(b.components, [
      leg(
        officialSel,
        official1,
        half,
        `官方讓球 ${formatHandicap(officialHandicap)}`,
        "AH",
        officialHandicap.toFixed(2),
        formatHandicap(officialHandicap),
      ),
    ]);
    formula = "O_syn(+0.75) = ( O_syn(+0.5) + O_官方(+1.0) ) / 2";
  }

  if (!(odds > 1)) return null;
  return {
    side,
    target,
    homeHandicap,
    lineDisplay,
    odds: r3(odds),
    formula,
    components: normalizeStakeTotal(components, totalStake),
  };
}

/**
 * Structural validity of comparing a synthetic quote against a Crown single.
 * The Crown leg must be the exact opposite leg on the exact mirrored line, so
 * that the pair fully covers every outcome.
 */
export function syntheticCoversCrown(
  quote: SyntheticQuote,
  crownHomeHandicap: number,
  crownSelection: Selection,
): boolean {
  const needSelection: Selection = quote.side === "away" ? "H" : "A";
  if (crownSelection !== needSelection) return false;
  return Math.abs(crownHomeHandicap - quote.homeHandicap) < 1e-9;
}
