import { describe, expect, it } from "vitest";
import {
  PINNACLE_RESEARCH_LOOP_MS,
  prioritizePendingPinnacleResearchTargets,
  type PinnacleResearchTarget,
} from "../server/lib/engine";
import { AUTO_SCAN_CHECK_MS } from "../server/lib/scan";

const MINUTE = 60_000;

function target(matchId: string, kickoffUtc: number): PinnacleResearchTarget {
  return {
    matchId,
    eventId: matchId.replace("pinnacle:", ""),
    kickoffUtc,
    league: "Test League",
    homeTeam: `${matchId} home`,
    awayTeam: `${matchId} away`,
  };
}

describe("Pinnacle-only research priority queue", () => {
  it("must yield before the next automatic scan tick", () => {
    expect(PINNACLE_RESEARCH_LOOP_MS).toBeLessThan(AUTO_SCAN_CHECK_MS);
  });

  it("prioritizes missing T5, then T15, T30 and initial", () => {
    const now = 1_800_000_000_000;
    const result = prioritizePendingPinnacleResearchTargets([
      target("pinnacle:initial", now + 3 * 60 * MINUTE),
      target("pinnacle:t30", now + 20 * MINUTE),
      target("pinnacle:t5-later", now + 4 * MINUTE),
      target("pinnacle:t15", now + 10 * MINUTE),
      target("pinnacle:t5-sooner", now + 2 * MINUTE),
    ], new Set(), now);

    expect(result.map(({ matchId, stage }) => [matchId, stage])).toEqual([
      ["pinnacle:t5-sooner", "T5"],
      ["pinnacle:t5-later", "T5"],
      ["pinnacle:t15", "T15"],
      ["pinnacle:t30", "T30"],
      ["pinnacle:initial", "initial"],
    ]);
  });

  it("skips a fixture when its current OU stage is already captured", () => {
    const now = 1_800_000_000_000;
    const result = prioritizePendingPinnacleResearchTargets([
      target("pinnacle:done", now + 3 * MINUTE),
      target("pinnacle:missing", now + 4 * MINUTE),
    ], new Set(["pinnacle:done:T5"]), now);

    expect(result.map((row) => row.matchId)).toEqual(["pinnacle:missing"]);
  });

  it("excludes kicked-off fixtures and fixtures outside the 24-hour horizon", () => {
    const now = 1_800_000_000_000;
    const result = prioritizePendingPinnacleResearchTargets([
      target("pinnacle:past", now),
      target("pinnacle:far", now + 24 * 60 * MINUTE + 1),
      target("pinnacle:valid", now + 31 * MINUTE),
    ], new Set(), now);

    expect(result.map(({ matchId, stage }) => [matchId, stage])).toEqual([
      ["pinnacle:valid", "initial"],
    ]);
  });
});
