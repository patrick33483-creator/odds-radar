import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The corner count is only observable while a fixture is in play, so the
 * extraction must sit before the in-play skip and the persistence must never
 * lower a stored count.
 */
describe("hkjc live corner capture", () => {
  const hkjc = readFileSync("server/providers/hkjc.ts", "utf8");
  const engine = readFileSync("server/lib/engine.ts", "utf8");

  it("harvests corners before skipping in-play fixtures", () => {
    const harvest = hkjc.indexOf("liveCorners.push(");
    const skip = hkjc.indexOf("inplaySkipped++");
    expect(harvest).toBeGreaterThan(-1);
    expect(skip).toBeGreaterThan(-1);
    expect(harvest).toBeLessThan(skip);
  });

  it("rejects HKJC's -1 missing-corner sentinel", () => {
    expect(hkjc).toContain("corner !== null && corner >= 0");
  });

  it("never lowers a stored corner count", () => {
    expect(engine).toContain("corner=MAX(hkjc_live_corners.corner, excluded.corner)");
  });

  it("keeps live corners out of research_results", () => {
    const helper = engine.slice(
      engine.indexOf("private persistLiveCorners"),
      engine.indexOf("private async performHkjcRefresh"),
    );
    expect(helper).not.toContain("research_results");
    expect(helper).not.toContain("corners_total");
  });
});
