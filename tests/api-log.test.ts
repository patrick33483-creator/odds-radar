import { describe, expect, it } from "vitest";
import { apiLogBody } from "../server/lib/api-log";

describe("dashboard API logging", () => {
  it("summarizes the large dashboard response without reserializing quote cells", () => {
    const body = {
      matches: [{ lines: [{ market: "AH" }, { market: "OU" }] }, { lines: [{ market: "1X2" }] }],
      status: { refreshing: true, mode: "live", degradedReason: null },
    };
    expect(apiLogBody("/api/dashboard", body)).toEqual({
      dashboard: true, matches: 2, lines: 3, refreshing: true, mode: "live", degraded: false,
    });
  });

  it("does not change non-dashboard API log bodies", () => {
    const body = { ok: true, rows: [1, 2] };
    expect(apiLogBody("/api/status", body)).toBe(body);
  });
});
