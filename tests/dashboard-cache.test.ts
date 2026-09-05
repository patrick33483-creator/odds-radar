import { describe, expect, it, vi } from "vitest";
import { RadarEngine } from "../server/lib/engine";
import type { DashboardResponse } from "../shared/types";

describe("dashboard projection cache", () => {
  it("serves repeat API reads from the last completed board", () => {
    const engine = new RadarEngine();
    const board = { matches: [], status: { mode: "live" } } as unknown as DashboardResponse;
    const build = vi.spyOn(engine, "buildDashboardData").mockReturnValue(board);
    expect(engine.dashboardData()).toBe(board);
    expect(engine.dashboardData()).toBe(board);
    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe("HKJC refresh single-flight", () => {
  it("shares one provider refresh across concurrent scheduler callers", async () => {
    const engine = new RadarEngine();
    let finish!: (value: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const perform = vi
      .spyOn(engine as any, "performHkjcRefresh")
      .mockReturnValue(pending);

    const first = (engine as any).refreshHkjc();
    const second = (engine as any).refreshHkjc();

    expect(perform).toHaveBeenCalledTimes(1);
    finish(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);

    await (engine as any).refreshHkjc();
    expect(perform).toHaveBeenCalledTimes(2);
  });
});
