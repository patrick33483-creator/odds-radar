/**
 * Settlement.
 *
 * Asian handicap and totals are settled per quarter half-line: each half-line is
 * settled independently at half the stake, then aggregated:
 *   win / half_win / push / half_loss / loss
 *
 * 1X2 is settled on the final result. Totals are settled on total goals.
 * All handicaps use the internal home-handicap convention (negative = home gives).
 */

import { splitLine } from "./lines";
import { matchEvent, type AliasIndex, type CandidateEvent } from "./matching";
import type { Market, Selection } from "@shared/types";
import type { FinalResult } from "../providers/types";

export type LegStatus = "win" | "half_win" | "push" | "half_loss" | "loss";

export const LEG_STATUS_LABEL: Record<LegStatus, string> = {
  win: "中",
  half_win: "半中",
  push: "走盤",
  half_loss: "半輸",
  loss: "輸",
};

export interface Score {
  homeScore: number;
  awayScore: number;
}

/** Outcome of one half-line: +1 win, 0 push, -1 loss. */
function halfOutcome(diff: number): 1 | 0 | -1 {
  if (diff > 1e-9) return 1;
  if (diff < -1e-9) return -1;
  return 0;
}

function aggregate(a: 1 | 0 | -1, b: 1 | 0 | -1): LegStatus {
  const sum = a + b;
  if (a === 1 && b === 1) return "win";
  if (sum === 1) return "half_win";
  if (sum === 0 && a === 0 && b === 0) return "push";
  if (sum === 0) return "push"; // one win + one loss on a quarter line cannot happen, but stays neutral
  if (sum === -1) return "half_loss";
  return "loss";
}

/**
 * Settle an Asian-handicap leg.
 * @param homeHandicap normalized home handicap (negative = home gives)
 * @param selection 'H' or 'A'
 */
export function settleHandicap(
  homeHandicap: number,
  selection: "H" | "A",
  score: Score,
): LegStatus {
  const halves = splitLine(homeHandicap);
  const outcomes = halves.map((h) => {
    const adjusted = score.homeScore + h - score.awayScore;
    const diff = selection === "H" ? adjusted : -adjusted;
    return halfOutcome(diff);
  });
  if (outcomes.length === 1) {
    const o = outcomes[0];
    return o === 1 ? "win" : o === 0 ? "push" : "loss";
  }
  return aggregate(outcomes[0], outcomes[1]);
}

/** Settle a totals leg. `selection` 'O' = 大, 'U' = 細. */
export function settleTotal(total: number, selection: "O" | "U", score: Score): LegStatus {
  const goals = score.homeScore + score.awayScore;
  const halves = splitLine(total);
  const outcomes = halves.map((t) => {
    const diff = selection === "O" ? goals - t : t - goals;
    return halfOutcome(diff);
  });
  if (outcomes.length === 1) {
    const o = outcomes[0];
    return o === 1 ? "win" : o === 0 ? "push" : "loss";
  }
  return aggregate(outcomes[0], outcomes[1]);
}

/** Settle a 1X2 leg on the final result. */
export function settle1X2(selection: "H" | "D" | "A", score: Score): LegStatus {
  const d = score.homeScore - score.awayScore;
  const winner: "H" | "D" | "A" = d > 0 ? "H" : d < 0 ? "A" : "D";
  return selection === winner ? "win" : "loss";
}

export function settleLeg(
  market: Market,
  lineValue: number | null,
  selection: Selection,
  score: Score,
): LegStatus {
  if (market === "1X2") return settle1X2(selection as "H" | "D" | "A", score);
  if (lineValue === null || !Number.isFinite(lineValue)) return "push";
  if (market === "AH") return settleHandicap(lineValue, selection as "H" | "A", score);
  return settleTotal(lineValue, selection as "O" | "U", score);
}

/** Money returned to the bettor (stake included) for a settled leg. */
export function legReturn(status: LegStatus, stake: number, decimalOdds: number): number {
  const profit = decimalOdds - 1;
  switch (status) {
    case "win":
      return round2(stake * decimalOdds);
    case "half_win":
      return round2(stake * (1 + profit / 2));
    case "push":
      return round2(stake);
    case "half_loss":
      return round2(stake / 2);
    case "loss":
      return 0;
  }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Aggregate status for a multi-leg simulated bet. */
export function aggregateBetStatus(statuses: LegStatus[]): string {
  if (statuses.length === 0) return "unsettled";
  const uniq = Array.from(new Set(statuses));
  if (uniq.length === 1) return uniq[0];
  return "mixed";
}

/** Auto-settlement becomes eligible this long after kickoff. */
export const SETTLE_AFTER_MS = 105 * 60 * 1000;

export function isSettleEligible(kickoffUtc: number, now: number): boolean {
  return now - kickoffUtc >= SETTLE_AFTER_MS;
}

export interface PinnapiLiveCacheState {
  homeScore: number;
  awayScore: number;
  seenLive: number;
  noLongerLive: number;
}

/**
 * PinnAPI may only settle after a score was genuinely observed in its live
 * feed, the event subsequently disappeared from that feed, and the normal
 * 105-minute grace period has elapsed. A missing cache deliberately permits
 * the titan007 fallback; a currently-live cache deliberately blocks it.
 */
export function chooseSettlementSource(
  cache: PinnapiLiveCacheState | null | undefined,
  kickoffUtc: number,
  now: number,
): "pinnapi_live" | "wait_for_pinnapi_end" | "titan_fallback" {
  if (!isSettleEligible(kickoffUtc, now)) return "wait_for_pinnapi_end";
  if (!cache || !cache.seenLive) return "titan_fallback";
  return cache.noLongerLive ? "pinnapi_live" : "wait_for_pinnapi_end";
}

export interface MatchedFinalResult {
  result: FinalResult;
  /** True when the final-result feed listed the teams in the reverse order. */
  reversed: boolean;
}

/**
 * Safe fallback when a titan007 ID is unavailable or stale. It uses the same
 * hard kickoff window, league scoring and normalized-team safeguards as normal
 * fixture mapping; names alone can never settle a bet.
 */
export function matchFinalResult(
  target: CandidateEvent,
  results: FinalResult[],
  aliases?: AliasIndex,
): MatchedFinalResult | null {
  const candidates = results
    .filter((result) => result.providerMatchId && result.league && result.homeTeam && result.awayTeam && Number.isFinite(result.kickoffUtc))
    .map((result) => ({
      id: result.providerMatchId,
      league: result.league,
      homeTeam: result.homeTeam,
      awayTeam: result.awayTeam,
      kickoffUtc: result.kickoffUtc,
    }));
  const decision = matchEvent(target, candidates, aliases);
  if (!decision.pinnacleMatchId) return null;
  const result = results.find((entry) => entry.providerMatchId === decision.pinnacleMatchId);
  return result ? { result, reversed: decision.reversed } : null;
}
