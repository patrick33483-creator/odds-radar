import { describe, expect, it } from "vitest";
import {
  buildClosingTotalModel,
  CLOSING_TOTAL_MAX_AGE_MS,
  type ClosingTotalQuote,
} from "../server/lib/closing-totals";

const NOW = 1_800_000_000_000;
const KICKOFF = NOW + 30_000;

function ladder(fetchedAt = NOW): ClosingTotalQuote[] {
  return [
    [2.5, 1.7, 2.2],
    [3, 2.02, 1.86],
    [3.5, 2.55, 1.6],
    [4, 3.35, 1.4],
  ].flatMap(([lineValue, over, under]) => [
    { lineValue, selection: "O" as const, decimalOdds: over, sourceUpdatedAt: fetchedAt, fetchedAt },
    { lineValue, selection: "U" as const, decimalOdds: under, sourceUpdatedAt: fetchedAt, fetchedAt },
  ]);
}

describe("Pinnacle closing totals fair-price model", () => {
  it("requires all four complete two-sided lines", () => {
    const model = buildClosingTotalModel(ladder().filter((quote) => quote.lineValue !== 4), KICKOFF, NOW);
    expect(model.status).toBe("incomplete");
    expect(model.availableLines).toEqual([2.5, 3, 3.5]);
    expect(model.lines).toEqual([]);
  });

  it("de-vigs the ladder, fits a goal distribution and returns Asian fair odds", () => {
    const model = buildClosingTotalModel(ladder(), KICKOFF, NOW);
    expect(model.status).toBe("available");
    expect(model.lambda).toBeGreaterThan(2);
    expect(model.lambda).toBeLessThan(5);
    expect(model.lines).toHaveLength(4);
    expect(model.lines.map((line) => line.lineValue)).toEqual([2.5, 3, 3.5, 4]);
    for (const line of model.lines) {
      expect(line.fairOverOdds).toBeGreaterThan(1);
      expect(line.fairUnderOdds).toBeGreaterThan(1);
      expect(line.overNoVigProbability).toBeGreaterThan(0);
      expect(line.overNoVigProbability).toBeLessThan(1);
    }
  });

  it("marks an old full ladder stale instead of treating it as tradeable", () => {
    const observedAt = NOW - CLOSING_TOTAL_MAX_AGE_MS - 1;
    const model = buildClosingTotalModel(ladder(observedAt), KICKOFF, NOW);
    expect(model.status).toBe("stale");
    expect(model.warning).toContain("禁止用作即時投注");
  });

  it("treats the final fresh pre-kick observation as a closing snapshot after kickoff", () => {
    const model = buildClosingTotalModel(ladder(NOW), NOW + 30_000, NOW + 31_000);
    expect(model.closing).toBe(true);
    expect(model.status).toBe("available");
    expect(model.secondsBeforeKickoff).toBe(30);
  });
});
