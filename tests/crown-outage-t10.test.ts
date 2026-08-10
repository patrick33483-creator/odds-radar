import { describe, expect, it, vi } from "vitest";
import {
  CROWN_EXECUTION_OBSERVATION_MAX_AGE_MS,
  crownExecutionPolicy,
  enforceCrownExecutionGate,
} from "../server/lib/crown-outage-guard";

const NOW = 1_800_000_000_000;
const LIVE_SIGNALS = {
  arbs: [{ key: "arb|match|AH|-0.50|H" }],
  ev: [{ key: "ev|match|OU|2.50|O" }],
  synthetics: [{ key: "synth|match|home|0.5" }],
};

function runFaultInjectedPass(minutesToKickoff: number, crownRows: number, oldRows = true) {
  const kickoffUtc = NOW + minutesToKickoff * 60_000;
  const policy = crownExecutionPolicy({
    now: NOW,
    kickoffUtc,
    observation: { observedAt: NOW, available: crownRows > 0, rowCount: crownRows },
    hasHistoricalCrownRows: oldRows,
  });
  const predictionCalculator = vi.fn(() => ({ probability: 0.61 }));
  const lockCalculator = vi.fn(() => LIVE_SIGNALS.arbs);
  const evCalculator = vi.fn(() => LIVE_SIGNALS.ev);
  const syntheticCalculator = vi.fn(() => LIVE_SIGNALS.synthetics);
  const telegram = vi.fn();

  // Historical rows remain usable only by the prediction path.
  const prediction = policy.predictionFallbackAllowed ? predictionCalculator() : null;
  const calculated = policy.executionEnabled
    ? {
        arbs: lockCalculator(),
        ev: evCalculator(),
        synthetics: syntheticCalculator(),
      }
    : { arbs: [], ev: [], synthetics: [] };
  const signals = enforceCrownExecutionGate(policy, calculated);
  const newBetKeys = [...signals.arbs, ...signals.ev, ...signals.synthetics].map((row) => `bet|${row.key}`);
  if (newBetKeys.length) telegram(newBetKeys);

  return {
    policy,
    prediction,
    signals,
    newBetKeys,
    predictionCalculator,
    lockCalculator,
    evCalculator,
    syntheticCalculator,
    telegram,
  };
}

describe("Crown outage fail-closed policy around T-10", () => {
  it.each([
    ["T-10 前", 10.01],
    ["T-10 正界線", 10],
    ["T-10 後", 9.99],
    ["T-5", 5],
    ["T-0.5", 0.5],
  ])("%s 空盤：舊盤只供預測，所有執行訊號及通知歸零", (_label, minutes) => {
    const out = runFaultInjectedPass(minutes, 0, true);
    expect(out.policy.mode).toBe("prediction_only");
    expect(out.policy.executionEnabled).toBe(false);
    expect(out.policy.predictionFallbackAllowed).toBe(true);
    expect(out.prediction).toEqual({ probability: 0.61 });
    expect(out.predictionCalculator).toHaveBeenCalledOnce();
    expect(out.lockCalculator).not.toHaveBeenCalled();
    expect(out.evCalculator).not.toHaveBeenCalled();
    expect(out.syntheticCalculator).not.toHaveBeenCalled();
    expect(out.signals).toEqual({ arbs: [], ev: [], synthetics: [] });
    expect(out.newBetKeys).toEqual([]);
    expect(out.telegram).not.toHaveBeenCalled();
  });

  it("沒有舊盤時連預測後備也停用", () => {
    const out = runFaultInjectedPass(9.5, 0, false);
    expect(out.policy.reason).toBe("empty_crown_snapshot");
    expect(out.policy.predictionFallbackAllowed).toBe(false);
    expect(out.prediction).toBeNull();
    expect(out.predictionCalculator).not.toHaveBeenCalled();
  });

  it("舊嘅成功狀態超時後一樣 fail-closed", () => {
    const policy = crownExecutionPolicy({
      now: NOW,
      kickoffUtc: NOW + 9 * 60_000,
      observation: {
        observedAt: NOW - CROWN_EXECUTION_OBSERVATION_MAX_AGE_MS - 1,
        available: true,
        rowCount: 12,
      },
      hasHistoricalCrownRows: true,
    });
    expect(policy.reason).toBe("stale_crown_observation");
    expect(policy.executionEnabled).toBe(false);
    expect(enforceCrownExecutionGate(policy, LIVE_SIGNALS)).toEqual({
      arbs: [],
      ev: [],
      synthetics: [],
    });
  });

  it("新鮮非空皇冠盤恢復後，執行計算先重新開啟", () => {
    const out = runFaultInjectedPass(8, 8, true);
    expect(out.policy.mode).toBe("live");
    expect(out.policy.executionEnabled).toBe(true);
    expect(out.policy.predictionFallbackAllowed).toBe(false);
    expect(out.lockCalculator).toHaveBeenCalledOnce();
    expect(out.evCalculator).toHaveBeenCalledOnce();
    expect(out.syntheticCalculator).toHaveBeenCalledOnce();
    expect(out.signals).toEqual(LIVE_SIGNALS);
    expect(out.telegram).toHaveBeenCalledOnce();
  });

  it("500 場大批量空盤故障不產生任何鎖利、EV、模擬注單或通知", () => {
    let predictions = 0;
    let locks = 0;
    let ev = 0;
    let synthetic = 0;
    let bets = 0;
    let notifications = 0;

    for (let i = 0; i < 500; i++) {
      const minutes = 5 + (i % 11) * 0.5; // T-5 至 T-10
      const out = runFaultInjectedPass(minutes, 0, true);
      predictions += out.prediction ? 1 : 0;
      locks += out.signals.arbs.length;
      ev += out.signals.ev.length;
      synthetic += out.signals.synthetics.length;
      bets += out.newBetKeys.length;
      notifications += out.telegram.mock.calls.length;
    }

    expect({ predictions, locks, ev, synthetic, bets, notifications }).toEqual({
      predictions: 500,
      locks: 0,
      ev: 0,
      synthetic: 0,
      bets: 0,
      notifications: 0,
    });
  });
});
