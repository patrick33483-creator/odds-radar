import { splitLine } from "./lines";

export const CLOSING_TOTAL_LINES = [2.5, 3, 3.5, 4] as const;
export const CLOSING_TOTAL_MAX_AGE_MS = 90_000;

export interface ClosingTotalQuote {
  lineValue: number;
  selection: "O" | "U";
  decimalOdds: number;
  sourceUpdatedAt: number | null;
  fetchedAt: number;
}

export interface ClosingTotalFairLine {
  lineValue: number;
  overMarketOdds: number;
  underMarketOdds: number;
  overNoVigProbability: number;
  fairOverOdds: number;
  fairUnderOdds: number;
}

export interface ClosingTotalModel {
  status: "available" | "incomplete" | "stale" | "poor_fit";
  observedAt: number | null;
  sourceUpdatedAt: number | null;
  closing: boolean;
  ageSec: number | null;
  secondsBeforeKickoff: number | null;
  requiredLines: number[];
  availableLines: number[];
  lambda: number | null;
  rmse: number | null;
  lines: ClosingTotalFairLine[];
  warning: string | null;
}

function poissonProbabilities(lambda: number, maxGoals = 40): number[] {
  const probabilities = [Math.exp(-lambda)];
  for (let goals = 1; goals <= maxGoals; goals++) {
    probabilities.push(probabilities[goals - 1] * lambda / goals);
  }
  const total = probabilities.reduce((sum, probability) => sum + probability, 0);
  probabilities[probabilities.length - 1] += Math.max(0, 1 - total);
  return probabilities;
}

function overTarget(line: number, probabilities: number[]): number {
  const integer = Math.round(line);
  if (Math.abs(line - integer) < 1e-9) {
    const over = probabilities.slice(integer + 1).reduce((sum, probability) => sum + probability, 0);
    const under = probabilities.slice(0, integer).reduce((sum, probability) => sum + probability, 0);
    return over / (over + under);
  }
  const floor = Math.floor(line);
  return probabilities.slice(floor + 1).reduce((sum, probability) => sum + probability, 0);
}

function noVigOver(over: number, under: number): number {
  const overRaw = 1 / over;
  const underRaw = 1 / under;
  return overRaw / (overRaw + underRaw);
}

function fairAsianOdds(line: number, selection: "O" | "U", probabilities: number[]): number {
  const halves = splitLine(line);
  const halfStake = 1 / halves.length;
  let winCoefficient = 0;
  let pushReturn = 0;

  probabilities.forEach((probability, goals) => {
    for (const half of halves) {
      const diff = selection === "O" ? goals - half : half - goals;
      if (diff > 1e-9) winCoefficient += probability * halfStake;
      else if (Math.abs(diff) <= 1e-9) pushReturn += probability * halfStake;
    }
  });

  if (winCoefficient <= 0) return Number.POSITIVE_INFINITY;
  return (1 - pushReturn) / winCoefficient;
}

function fitLambda(targets: Array<{ line: number; probability: number }>): { lambda: number; rmse: number } {
  let bestLambda = 0.2;
  let bestError = Number.POSITIVE_INFINITY;
  for (let step = 0; step <= 7800; step++) {
    const lambda = 0.2 + step * 0.001;
    const probabilities = poissonProbabilities(lambda);
    const error = targets.reduce((sum, target) => {
      const delta = overTarget(target.line, probabilities) - target.probability;
      return sum + delta * delta;
    }, 0) / targets.length;
    if (error < bestError) {
      bestError = error;
      bestLambda = lambda;
    }
  }
  return { lambda: bestLambda, rmse: Math.sqrt(bestError) };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function buildClosingTotalModel(
  quotes: ClosingTotalQuote[],
  kickoffUtc: number,
  now = Date.now(),
): ClosingTotalModel {
  const requiredLines = [...CLOSING_TOTAL_LINES];
  const complete = new Map<number, { over: ClosingTotalQuote; under: ClosingTotalQuote }>();
  for (const line of CLOSING_TOTAL_LINES) {
    const over = quotes.find((quote) => quote.lineValue === line && quote.selection === "O");
    const under = quotes.find((quote) => quote.lineValue === line && quote.selection === "U");
    if (over && under) complete.set(line, { over, under });
  }

  const availableLines = [...complete.keys()];
  const observedAt = quotes.length ? Math.min(...quotes.map((quote) => quote.fetchedAt)) : null;
  const sourceTimes = quotes
    .map((quote) => quote.sourceUpdatedAt)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const sourceUpdatedAt = sourceTimes.length ? Math.min(...sourceTimes) : null;
  const ageSec = observedAt === null ? null : Math.max(0, Math.round((now - observedAt) / 1000));
  const secondsBeforeKickoff = observedAt === null ? null : Math.round((kickoffUtc - observedAt) / 1000);
  const base = {
    observedAt,
    sourceUpdatedAt,
    closing: now >= kickoffUtc,
    ageSec,
    secondsBeforeKickoff,
    requiredLines,
    availableLines,
  };

  if (complete.size !== CLOSING_TOTAL_LINES.length) {
    return {
      ...base,
      status: "incomplete",
      lambda: null,
      rmse: null,
      lines: [],
      warning: `Pinnacle 尾盤梯形不完整：只有 ${availableLines.join("、") || "0"} 球完整雙邊報價。`,
    };
  }

  const targets = CLOSING_TOTAL_LINES.map((line) => {
    const pair = complete.get(line)!;
    return { line, probability: noVigOver(pair.over.decimalOdds, pair.under.decimalOdds) };
  });
  const fit = fitLambda(targets);
  const probabilities = poissonProbabilities(fit.lambda);
  const lines = CLOSING_TOTAL_LINES.map((line): ClosingTotalFairLine => {
    const pair = complete.get(line)!;
    return {
      lineValue: line,
      overMarketOdds: pair.over.decimalOdds,
      underMarketOdds: pair.under.decimalOdds,
      overNoVigProbability: round(noVigOver(pair.over.decimalOdds, pair.under.decimalOdds), 6),
      fairOverOdds: round(fairAsianOdds(line, "O", probabilities), 3),
      fairUnderOdds: round(fairAsianOdds(line, "U", probabilities), 3),
    };
  });
  const stale = observedAt === null
    || (now < kickoffUtc
      ? now - observedAt > CLOSING_TOTAL_MAX_AGE_MS
      : kickoffUtc - observedAt > CLOSING_TOTAL_MAX_AGE_MS);
  const poorFit = fit.rmse > 0.06;
  return {
    ...base,
    status: stale ? "stale" : poorFit ? "poor_fit" : "available",
    lambda: round(fit.lambda, 3),
    rmse: round(fit.rmse, 6),
    lines,
    warning: stale
      ? "最後完整四線快照距離當刻或開賽超過 90 秒，只供覆盤，禁止用作即時投注。"
      : poorFit
        ? "四線去水機率互相不一致，Poisson 擬合誤差過高，只供診斷。"
        : null,
  };
}
