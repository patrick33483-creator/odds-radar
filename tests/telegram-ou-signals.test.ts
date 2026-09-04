import { describe, expect, it } from "vitest";
import type { OuSignalObservation, OuSignalPrealert } from "@shared/types";
import { buildOuPrealertMessage, buildOuSignalMessage } from "../server/lib/telegram";

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
    initialLineKey: "2.25",
    t30LineKey: "2.5",
    t5LineKey: "2.5",
    linePath: "2.25→2.5→2.5",
    evaluatorVersion: "stage-main-v2",
    directionPath: "O→O→O",
    driftBucket: "持平或拉闊",
    driftComparable: false,
    originalSelection: "O",
    signalSelection: "U",
    mode: "reverse",
    referenceInitialOdds: 1.8,
    referenceT5Odds: 1.8,
    signalT5Odds: 2.0,
    oddsGap: null,
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
    expect(text).toContain("命中條件：馬會｜方向 O→O→O｜持平或拉闊");
    expect(text).toContain("主盤線路：2.25→2.5→2.5");
    expect(text).toContain("T-5 最終：小球 2.5 @ 2.000");
    expect(text).toContain("條件 T-5 原方向賠率範圍：≥ 1.800");
    expect(text).toContain("跨盤：不作原始賠率差比較");
    expect(text).toContain("前瞻命中：");
    expect(text).not.toContain("心理準備");
  });

  it("renders a moved-line T-30 candidate without claiming it is same-line", () => {
    const prealert: OuSignalPrealert = {
      uniqueKey: "prealert:M2",
      matchId: "M2",
      league: "測試聯賽",
      homeTeam: "主隊",
      awayTeam: "客隊",
      kickoffUtc: Date.UTC(2026, 8, 2, 13),
      provider: "pinnacle",
      providerLabel: "Pinnacle／平博",
      ruleId: "pinnacle-ouu-t5-selected-180-190-over-watch",
      lineKey: "3.5",
      initialLineKey: "3.25",
      t30LineKey: "3.5",
      linePath: "3.25→3.5",
      evaluatorVersion: "stage-main-v2",
      directionPath: "O→U",
      signalSelection: "O",
      mode: "reverse",
      initialSelectedOdds: 1.8,
      t30SelectedOdds: 1.82,
      initialSignalOdds: 1.8,
      signalT30Odds: 1.96,
      detectedAt: Date.now(),
      notifiedAt: null,
    };
    const text = buildOuPrealertMessage(prealert);
    expect(text).toContain("主盤線路：3.25→3.5");
    expect(text).toContain("目前 T-30 3.5 @ 1.960");
    expect(text).toContain("候選條件：Pinnacle／平博｜方向 O→U→U｜任何水位走勢");
    expect(text).toContain("歷史命中：17/26，65.4%");
    expect(text).toContain("前瞻命中：");
    expect(text).not.toContain("同線 3.5");
    expect(text).not.toContain("心理準備");
  });

  it("renders the signal-side initial price and exact drift formula for U→O", () => {
    const prealert: OuSignalPrealert = {
      uniqueKey: "prealert:signal-side",
      matchId: "signal-side",
      league: "測試聯賽",
      homeTeam: "主隊",
      awayTeam: "客隊",
      kickoffUtc: Date.UTC(2026, 8, 2, 13),
      provider: "pinnacle",
      providerLabel: "Pinnacle／平博",
      ruleId: "pinnacle-uoo-short-005-010",
      lineKey: "2.5",
      initialLineKey: "2.5",
      t30LineKey: "2.5",
      linePath: "2.5→2.5",
      evaluatorVersion: "same-line-v1",
      directionPath: "U→O",
      signalSelection: "O",
      mode: "direct",
      initialSelectedOdds: 1.710,
      t30SelectedOdds: 1.780,
      initialSignalOdds: 1.840,
      signalT30Odds: 1.780,
      detectedAt: Date.now(),
      notifiedAt: null,
    };

    const text = buildOuPrealertMessage(prealert);
    expect(text).toContain("低水方賠率：初盤 1.710 → T-30 1.780");
    expect(text).toContain("訊號邊初盤：大球 2.5 @ 1.840");
    expect(text).toContain("條件公式：初盤大球 1.840 − T-5 大球；差值 ≥ 0.050 且 < 0.100");
    expect(text).toContain("條件 T-5 大球賠率範圍：> 1.740 且 ≤ 1.790");
    expect(text).not.toContain("條件 T-5 大球賠率範圍：> 1.700");
  });
});
