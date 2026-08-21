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
