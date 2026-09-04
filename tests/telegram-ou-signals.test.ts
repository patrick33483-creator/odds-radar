import { describe, expect, it } from "vitest";
import type { OuSignalObservation } from "@shared/types";
import { buildOuSignalMessage } from "../server/lib/telegram";

function signal(ruleId: string): OuSignalObservation {
  return {
    uniqueKey: `${ruleId}:M1`,
    matchId: "M1",
    league: "測試聯賽",
    homeTeam: "主隊",
    awayTeam: "客隊",
    kickoffUtc: Date.UTC(2026, 8, 2, 13),
    matchStatus: "upcoming",
    provider: "hkjc",
    providerLabel: "馬會",
    ruleId,
    lineKey: "2.5",
    directionPath: "O→O→O",
    driftBucket: "持平或拉闊",
    originalSelection: "O",
    signalSelection: "U",
    mode: "reverse",
    referenceInitialOdds: 1.8,
    referenceT5Odds: 1.8,
    signalT5Odds: 2.0,
    oddsGap: 0,
    detectedAt: Date.now(),
    notifiedAt: null,
    result: null,
  };
}

describe("Radar OU Telegram message", () => {
  it("combines overlapping rules and includes each historical hit rate", () => {
    const text = buildOuSignalMessage([
      signal("hkjc-ooo-flat-wide-line-225-250-under-watch"),
      signal("hkjc-ooo-flat-wide-reverse"),
    ]);
    expect(text).toContain("命中條件：2 條");
    expect(text).toContain("歷史命中：17/23，73.9%");
    expect(text).toContain("歷史命中：17/24，70.8%");
    expect(text).toContain("17/23");
    expect(text).toContain("17/24");
    expect(text).toContain("達成條件：馬會｜方向 O→O→O｜持平或拉闊");
    expect(text).toContain("T-5 原方向低水賠率：≥ 1.800");
  });
});
