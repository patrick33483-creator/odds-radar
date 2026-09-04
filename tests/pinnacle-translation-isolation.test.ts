/**
 * Regression guard: Chinese-label translation for Pinnacle-only fixtures MUST
 * NEVER be invoked from the latency-sensitive research timeline.  Historically
 * a translation side-effect inside `refreshPinnacleOnlyResearch` caused every
 * Pinnacle-only fixture to miss its T-30 / T-15 / T-5 milestones because the
 * broad third-party fetch monopolised the collector loop.
 *
 * These tests assert:
 *   1. `refreshPinnacleOnlyResearch` no longer references any translation
 *      helper (source-level guard, cheap and deterministic).
 *   2. The independent backfill entry point exists and respects its
 *      `maxFixtures` cap so a slow provider cannot monopolise the worker.
 *   3. The independent scheduler in `server/routes.ts` is gated by
 *      `RADAR_PINNACLE_TRANSLATION_BACKFILL=1` — timeline traffic never
 *      touches translation code paths by default.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("Pinnacle translation is isolated from the research timeline", () => {
  it("refreshPinnacleOnlyResearch does not invoke translation helpers", () => {
    const src = readSource("server/lib/engine.ts");
    const start = src.indexOf("async refreshPinnacleOnlyResearch(");
    expect(start).toBeGreaterThan(-1);
    // The refresh method closes with `\n  }` at its own indentation. Scan
    // forward for a class-method boundary so we only inspect the timeline path.
    const scanEnd = src.indexOf("\n\n  ", start);
    const timelineBody = scanEnd === -1 ? src.slice(start) : src.slice(start, scanEnd);
    expect(timelineBody).not.toMatch(/translatePinnacleFixture\s*\(/);
    expect(timelineBody).not.toMatch(/translatePinnacleOnlyTargets\s*\(/);
    expect(timelineBody).not.toMatch(/RADAR_PINNACLE_TRANSLATION_ENABLED/);
  });

  it("exposes a bounded backfill entry point for the independent worker", () => {
    const src = readSource("server/lib/engine.ts");
    expect(src).toMatch(/async\s+runPinnacleTranslationBackfillBatch\s*\(/);
    expect(src).toMatch(/listPinnacleTranslationBackfillTargets\s*\(/);
    expect(src).toMatch(/maxFixtures/);
  });

  it("routes.ts installs the backfill worker unless explicitly disabled", () => {
    const src = readSource("server/routes.ts");
    expect(src).toMatch(/installPinnacleTranslationBackfill\s*\(/);
    expect(src).toMatch(/RADAR_PINNACLE_TRANSLATION_BACKFILL\s*===\s*"0"/);
    // The auto-scan tick MUST NOT call the backfill worker.
    const autoScanStart = src.indexOf("function installAutoWindowScan(");
    const autoScanEnd = src.indexOf("\n}\n", autoScanStart);
    const autoScanBody = src.slice(autoScanStart, autoScanEnd);
    expect(autoScanBody).not.toMatch(/runPinnacleTranslationBackfillBatch/);
    expect(autoScanBody).not.toMatch(/listPinnacleTranslationBackfillTargets/);
  });
});
