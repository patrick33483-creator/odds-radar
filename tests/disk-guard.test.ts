import { describe, expect, it } from "vitest";
import {
  CRITICAL_FREE_RATIO,
  REPEAT_MS,
  WARN_FREE_RATIO,
  classify,
  evaluateDisk,
  parseDiskAlertState,
  runDiskCheck,
  type DiskAlertState,
} from "../server/lib/disk-guard";

const GB = 1024 ** 3;
const usage = (freeGb: number, totalGb = 24) => ({
  totalBytes: totalGb * GB,
  freeBytes: freeGb * GB,
});

describe("disk pressure classification", () => {
  it("treats healthy headroom as ok", () => {
    expect(classify(usage(6.5)).level).toBe("ok");
  });

  it("warns below the warn ratio", () => {
    const free = 24 * GB * (WARN_FREE_RATIO - 0.01);
    expect(classify({ totalBytes: 24 * GB, freeBytes: free }).level).toBe("warn");
  });

  it("escalates below the critical ratio", () => {
    const free = 24 * GB * (CRITICAL_FREE_RATIO - 0.01);
    expect(classify({ totalBytes: 24 * GB, freeBytes: free }).level).toBe("critical");
  });

  it("classifies the state the outage was actually in", () => {
    // 892K free on a 24G volume, as observed on 2026-09-05.
    expect(classify({ totalBytes: 24 * GB, freeBytes: 892 * 1024 }).level).toBe("critical");
  });

  it("does not divide by zero on an unreadable volume", () => {
    expect(classify({ totalBytes: 0, freeBytes: 0 }).level).toBe("ok");
  });
});

describe("alert throttling", () => {
  it("alerts the first time space runs low", () => {
    const outcome = evaluateDisk(usage(2), null, 1_000);
    expect(outcome.shouldAlert).toBe(true);
    expect(outcome.level).toBe("warn");
    expect(outcome.message).toContain("磁碟空間偏低");
  });

  it("stays quiet while healthy and never alerted", () => {
    expect(evaluateDisk(usage(10), null, 1_000).shouldAlert).toBe(false);
  });

  it("suppresses a repeat of the same level within the repeat window", () => {
    const previous: DiskAlertState = { level: "warn", at: 1_000 };
    expect(evaluateDisk(usage(2), previous, 1_000 + REPEAT_MS - 1).shouldAlert).toBe(false);
  });

  it("re-alerts once the repeat window has passed", () => {
    const previous: DiskAlertState = { level: "warn", at: 1_000 };
    expect(evaluateDisk(usage(2), previous, 1_000 + REPEAT_MS).shouldAlert).toBe(true);
  });

  it("escalates warn to critical immediately, without waiting", () => {
    const previous: DiskAlertState = { level: "warn", at: 1_000 };
    const outcome = evaluateDisk(usage(0.5), previous, 1_500);
    expect(outcome.shouldAlert).toBe(true);
    expect(outcome.level).toBe("critical");
    expect(outcome.message).toContain("嚴重不足");
  });

  it("does not re-alert when pressure eases from critical to warn", () => {
    const previous: DiskAlertState = { level: "critical", at: 1_000 };
    expect(evaluateDisk(usage(2), previous, 1_500).shouldAlert).toBe(false);
  });

  it("reports recovery once real headroom is back", () => {
    const previous: DiskAlertState = { level: "critical", at: 1_000 };
    const outcome = evaluateDisk(usage(10), previous, 1_500);
    expect(outcome.shouldAlert).toBe(true);
    expect(outcome.level).toBe("ok");
    expect(outcome.message).toContain("回復");
  });

  it("withholds recovery while barely above the warn line, to avoid flapping", () => {
    const previous: DiskAlertState = { level: "warn", at: 1_000 };
    const outcome = evaluateDisk(usage(24 * 0.16), previous, 1_500);
    expect(outcome.level).toBe("ok");
    expect(outcome.shouldAlert).toBe(false);
  });

  it("reports free and total space in the message", () => {
    const outcome = evaluateDisk(usage(1.5), null, 1_000);
    expect(outcome.message).toContain("1.5G / 24.0G");
  });
});

describe("runDiskCheck", () => {
  it("sends and records the alert", async () => {
    const sent: string[] = [];
    let stored: DiskAlertState | null = null;
    const outcome = await runDiskCheck({
      usage: () => usage(1),
      readState: () => stored,
      writeState: (state) => {
        stored = state;
      },
      send: async (text) => {
        sent.push(text);
      },
      now: () => 5_000,
    });
    expect(outcome.shouldAlert).toBe(true);
    expect(sent).toHaveLength(1);
    expect(stored).toEqual({ level: "critical", at: 5_000 });
  });

  it("does not send or record anything while healthy", async () => {
    const sent: string[] = [];
    let stored: DiskAlertState | null = null;
    await runDiskCheck({
      usage: () => usage(12),
      readState: () => stored,
      writeState: (state) => {
        stored = state;
      },
      send: async (text) => {
        sent.push(text);
      },
      now: () => 5_000,
    });
    expect(sent).toEqual([]);
    expect(stored).toBeNull();
  });

  it("keeps the previous state when delivery fails, so the warning is retried", async () => {
    let stored: DiskAlertState | null = null;
    await expect(
      runDiskCheck({
        usage: () => usage(1),
        readState: () => stored,
        writeState: (state) => {
          stored = state;
        },
        send: async () => {
          throw new Error("Telegram delivery failed: 502");
        },
        now: () => 5_000,
      }),
    ).rejects.toThrow("Telegram delivery failed");
    expect(stored).toBeNull();
  });
});

describe("stored alert state", () => {
  it("round-trips a valid state", () => {
    expect(parseDiskAlertState(JSON.stringify({ level: "warn", at: 42 }))).toEqual({
      level: "warn",
      at: 42,
    });
  });

  it("treats missing, malformed and unknown levels as no previous alert", () => {
    expect(parseDiskAlertState(null)).toBeNull();
    expect(parseDiskAlertState("not json")).toBeNull();
    expect(parseDiskAlertState(JSON.stringify({ level: "nope", at: 1 }))).toBeNull();
    expect(parseDiskAlertState(JSON.stringify({ level: "warn" }))).toBeNull();
  });
});
