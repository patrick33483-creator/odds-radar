/**
 * Tests for the ONLY automated scanning path: the dense pre-kickoff window scan.
 *
 * Proves:
 *   - outside the 30-minute window -> NO_WINDOW and ZERO detail calls
 *   - inside the window            -> the in-window events are scanned
 *   - already-started / in-play / unmapped events are excluded
 *   - configuration is always bounded below 300 s
 *   - the recurring helper contains no full-scan path (it only ever receives
 *     the events selected by the window filter)
 */

import { describe, expect, it } from "vitest";
import {
  isSimulationPurchaseWindow,
  isPrewarmWindow,
  autoScanEnabled,
  runWindowScan,
  scanConfig,
  selectWindowEvents,
  SCAN_HARD_LIMIT_SEC,
  type ScanCandidate,
  type ScanConfig,
} from "../server/lib/scan";
import {
  isPinnacleName,
  normalizeBookmakerName,
  selectPinnacleRow,
  BLOCKED_COMPANY_IDS,
} from "../server/providers/pinnacle-names";
import { parsePinnacleAsianTriple, parsePinnacle1X2, listBookmakerRows } from "../server/providers/pinnacle";
import { parseOpticPrices } from "../server/providers/opticodds";

const NOW = 1_800_000_000_000;
const CFG: ScanConfig = { windowMinutes: 30, intervalSec: 30, maxRuntimeSec: 240 };

function cand(over: Partial<ScanCandidate> & { minutes: number }): ScanCandidate {
  return {
    matchId: over.matchId ?? `hkjc:${over.minutes}`,
    matchLabel: over.matchLabel ?? `隊A vs 隊B (${over.minutes}m)`,
    kickoffUtc: NOW + over.minutes * 60_000,
    inplay: over.inplay ?? false,
    status: over.status ?? "PREEVENT",
    pinnacleMatchId: over.pinnacleMatchId === undefined ? "t7-1" : over.pinnacleMatchId,
  };
}

/* ---------------------------- window selection ---------------------------- */

describe("window selection", () => {
  it("keeps only 0 < minutes_to_kickoff <= 30", () => {
    const picked = selectWindowEvents(
      [cand({ minutes: 45 }), cand({ minutes: 31 }), cand({ minutes: 30 }), cand({ minutes: 1 }), cand({ minutes: 180 })],
      NOW,
      CFG,
    );
    expect(picked.map((p) => Math.round(p.minutesToKickoff))).toEqual([1, 30]);
  });

  it("excludes matches that already kicked off, are in-play or finished", () => {
    const picked = selectWindowEvents(
      [
        cand({ minutes: 0 }), // kickoff exactly now -> excluded
        cand({ minutes: -5 }), // started 5 minutes ago
        cand({ minutes: 10, inplay: true }),
        cand({ minutes: 12, status: "INPLAY" }),
        cand({ minutes: 14, status: "FINISHED" }),
        cand({ minutes: 20 }), // the only valid one
      ],
      NOW,
      CFG,
    );
    expect(picked).toHaveLength(1);
    expect(Math.round(picked[0].minutesToKickoff)).toBe(20);
  });

  it("excludes events without a Pinnacle mapping", () => {
    expect(selectWindowEvents([cand({ minutes: 10, pinnacleMatchId: null })], NOW, CFG)).toHaveLength(0);
  });

  it("allows simulated purchases only strictly before kickoff and within 30 minutes", () => {
    expect(isSimulationPurchaseWindow(NOW + 30 * 60_000, NOW)).toBe(true);
    expect(isSimulationPurchaseWindow(NOW + 1, NOW)).toBe(true);
    expect(isSimulationPurchaseWindow(NOW + 30 * 60_000 + 1, NOW)).toBe(false);
    expect(isSimulationPurchaseWindow(NOW, NOW)).toBe(false);
    expect(isSimulationPurchaseWindow(NOW - 1, NOW)).toBe(false);
  });

  it("limits hourly pre-warm detail refreshes to the next 24 hours", () => {
    expect(isPrewarmWindow(NOW + 24 * 60 * 60_000, NOW)).toBe(true);
    expect(isPrewarmWindow(NOW + 24 * 60 * 60_000 + 1, NOW)).toBe(false);
    expect(isPrewarmWindow(NOW + 1, NOW)).toBe(true);
    expect(isPrewarmWindow(NOW, NOW)).toBe(false);
  });
});

/* ------------------------------ configuration ----------------------------- */

describe("scan configuration", () => {
  it("enables automatic schedule checks by default and allows an explicit off switch", () => {
    expect(autoScanEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(autoScanEnabled({ RADAR_AUTO_SCAN: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(autoScanEnabled({ RADAR_AUTO_SCAN: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("defaults to 30 s dense interval and <=240 s runtime", () => {
    const cfg = scanConfig({} as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ windowMinutes: 30, intervalSec: 30, maxRuntimeSec: 240 });
  });

  it("clamps env overrides and always stays below the 300 s hard limit", () => {
    const cfg = scanConfig({
      RADAR_SCAN_WINDOW_MIN: "600",
      RADAR_SCAN_INTERVAL_SEC: "1",
      RADAR_SCAN_MAX_RUNTIME_SEC: "9999",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.windowMinutes).toBe(30);
    expect(cfg.intervalSec).toBe(5);
    expect(cfg.maxRuntimeSec).toBeLessThan(SCAN_HARD_LIMIT_SEC);
    expect(cfg.maxRuntimeSec).toBe(290);
    for (const raw of ["0", "-5", "abc", undefined]) {
      const c = scanConfig({ RADAR_SCAN_MAX_RUNTIME_SEC: raw } as unknown as NodeJS.ProcessEnv);
      expect(c.maxRuntimeSec).toBeLessThan(SCAN_HARD_LIMIT_SEC);
      expect(c.maxRuntimeSec).toBeGreaterThanOrEqual(30);
    }
  });
});

/* --------------------------------- runner --------------------------------- */

interface Harness {
  detailCalls: number;
  passes: number;
  polled: string[][];
  slept: number[];
}

function harness(
  candidates: ScanCandidate[],
  opts: { arbOnPass?: number; cfg?: ScanConfig } = {},
) {
  const h: Harness = { detailCalls: 0, passes: 0, polled: [], slept: [] };
  let clock = NOW;
  const deps = {
    now: () => clock,
    loadCandidates: async () => candidates,
    pollPass: async (events: ScanCandidate[]) => {
      h.passes++;
      h.polled.push(events.map((e) => e.matchId));
      h.detailCalls += events.length;
      clock += 2_000; // each pass costs 2 s
      return {
        detailCalls: events.length,
        newOpportunityKeys: opts.arbOnPass === h.passes ? ["arb|hkjc:10|AH|-0.50|H"] : [],
      };
    },
    sleep: async (ms: number) => {
      h.slept.push(ms);
      clock += ms;
    },
    config: opts.cfg ?? CFG,
  };
  return { h, deps };
}

describe("runWindowScan", () => {
  it("returns NO_WINDOW with zero detail calls when nothing is within 30 minutes", async () => {
    const { h, deps } = harness([cand({ minutes: 90 }), cand({ minutes: 31 }), cand({ minutes: -10 })]);
    const out = await runWindowScan(deps);
    expect(out.result).toBe("NO_WINDOW");
    expect(out.detailCalls).toBe(0);
    expect(h.passes).toBe(0);
    expect(h.polled).toEqual([]);
    expect(out.selected).toEqual([]);
    expect(out.runtimeMs).toBeLessThan(1000);
  });

  it("densely scans only the in-window events, never the whole card", async () => {
    const { h, deps } = harness([
      cand({ matchId: "in-1", minutes: 10 }),
      cand({ matchId: "in-2", minutes: 25 }),
      cand({ matchId: "out-1", minutes: 200 }),
      cand({ matchId: "started", minutes: -3 }),
    ]);
    const out = await runWindowScan(deps);
    expect(out.result).toBe("NO_ALERT");
    expect(out.selected.map((s) => s.matchId)).toEqual(["in-1", "in-2"]);
    for (const pass of h.polled) expect(pass).toEqual(["in-1", "in-2"]);
    expect(h.passes).toBeGreaterThan(1);
    // Every pass touched exactly the 2 in-window events — no full-scan path.
    expect(out.detailCalls).toBe(h.passes * 2);
  });

  it("stops immediately when a new arb appears", async () => {
    const { h, deps } = harness([cand({ matchId: "in-1", minutes: 5 })], { arbOnPass: 2 });
    const out = await runWindowScan(deps);
    expect(out.result).toBe("ALERT");
    expect(h.passes).toBe(2);
    expect(out.newOpportunityKeys).toEqual(["arb|hkjc:10|AH|-0.50|H"]);
  });

  it("never exceeds the configured runtime budget (and it is < 300 s)", async () => {
    const cfg: ScanConfig = { windowMinutes: 30, intervalSec: 30, maxRuntimeSec: 240 };
    const { deps } = harness([cand({ matchId: "in-1", minutes: 20 })], { cfg });
    const out = await runWindowScan(deps);
    expect(out.runtimeMs).toBeLessThanOrEqual(cfg.maxRuntimeSec * 1000);
    expect(cfg.maxRuntimeSec * 1000).toBeLessThan(SCAN_HARD_LIMIT_SEC * 1000);
  });

  it("drops events that kick off mid-session", async () => {
    const cfg: ScanConfig = { windowMinutes: 30, intervalSec: 30, maxRuntimeSec: 120 };
    const { h, deps } = harness([cand({ matchId: "soon", minutes: 1 })], { cfg });
    const out = await runWindowScan(deps);
    expect(out.result).toBe("NO_ALERT");
    // kickoff is 60 s away, interval is 30 s -> at most a couple of passes
    expect(h.passes).toBeLessThanOrEqual(3);
  });

  it("reports ERROR (not a full scan) when fixtures cannot be loaded", async () => {
    const out = await runWindowScan({
      now: () => NOW,
      loadCandidates: async () => {
        throw new Error("upstream down");
      },
      pollPass: async () => {
        throw new Error("must not be called");
      },
      sleep: async () => undefined,
      config: CFG,
    });
    expect(out.result).toBe("ERROR");
    expect(out.detailCalls).toBe(0);
  });
});

/* -------------------- Pinnacle row identification (by name) --------------- */

const ASIAN_PAGE = `
<table>
<tr><td width="35"><input type="checkbox" name="oddsShow" data-id="3" value="0"></td>
<td height="25">Crow*</td><td><span class='down' companyID='3'></span></td>
<td>0.83</td><td goals="0.5">半球</td><td>0.99</td>
<td oddstype="wholeOdds">0.97</td><td goals="1" oddstype="wholeOdds">一球</td><td oddstype="wholeOdds">0.92</td></tr>
<tr><td width="35"><input type="checkbox" name="oddsShow" data-id="47" value="0"></td>
<td height="25">平*</td><td><span class='down' companyID='47'></span></td>
<td>1.00</td><td goals="0.75">半球/一球</td><td>0.81</td>
<td oddstype="wholeOdds">1.00</td><td goals="1" oddstype="wholeOdds">一球</td><td oddstype="wholeOdds">0.88</td></tr>
</table>`;

describe("Pinnacle bookmaker-row identification", () => {
  it("normalizes masked bookmaker labels", () => {
    expect(normalizeBookmakerName("平*")).toBe("平");
    expect(normalizeBookmakerName(" Pinnacle Sports ")).toBe("pinnaclesports");
  });

  it("accepts Pinnacle spellings and masked prefixes, rejects Crown", () => {
    expect(isPinnacleName("Pinnacle")).toBe(true);
    expect(isPinnacleName("平博")).toBe(true);
    expect(isPinnacleName("平*")).toBe(true);
    expect(isPinnacleName("Crow*")).toBe(false);
    expect(isPinnacleName("皇冠")).toBe(false);
    expect(isPinnacleName("36*")).toBe(false);
  });

  it("blocks the historical Crown company id from ever being selected", () => {
    expect(BLOCKED_COMPANY_IDS.has("3")).toBe(true);
    const picked = selectPinnacleRow([{ companyId: "3", rawName: "Crow*", html: "" }]);
    expect(picked).toBeNull();
  });

  it("selects the Pinnacle row by name from a real titan007 table", () => {
    const rows = listBookmakerRows(ASIAN_PAGE);
    expect(rows.map((r) => r.companyId)).toEqual(["3", "47"]);
    const triple = parsePinnacleAsianTriple(ASIAN_PAGE);
    expect(triple).not.toBeNull();
    expect(triple!.companyId).toBe("47");
    expect(triple!.matchedBy).toBe("name");
    expect(triple!.home).toBe(1);
    expect(triple!.away).toBe(0.88);
  });

  it("returns null (degraded) when no Pinnacle row is present", () => {
    const onlyCrown = ASIAN_PAGE.replace(/data-id="47"/, 'data-id="99"').replace("平*", "其他*");
    expect(parsePinnacleAsianTriple(onlyCrown)).toBeNull();
  });

  it("selects Pinnacle by full name in the 1X2 feed and ignores Crown", () => {
    const js = 'var game = Array("545|1|Crown|1.83|4.05|3.45|50|22|26|92|1.56|4.65|4.50|59|20|20","177|2|Pinnacle|1.78|3.93|3.95|52|23|23|93|1.61|4.63|4.81|59|20|19");';
    const out = parsePinnacle1X2(js);
    expect(out).toEqual({ h: 1.61, d: 4.63, a: 4.81, companyId: "177" });
  });
});

describe("OpticOdds Pinnacle normalization", () => {
  const fixture = {
    id: "optic-1",
    start_date: "2026-08-07T12:00:00Z",
    home_team_display: "Alpha United",
    away_team_display: "Beta City",
    odds: [
      { sportsbook: "Pinnacle", market: "Asian Handicap Relative", selection: "Alpha United", points: -0.25, price: 1.95, is_main: true, timestamp: 1_800_000_000 },
      { sportsbook: "Pinnacle", market: "Asian Handicap Relative", selection: "Beta City", points: 0.25, price: 1.97, is_main: true, timestamp: 1_800_000_000 },
      { sportsbook: "Pinnacle", market: "Asian Total Goals", name: "Over 2.75", points: 2.75, price: 1.91, is_main: true },
      { sportsbook: "Pinnacle", market: "Asian Total Goals", name: "Under 2.75", points: 2.75, price: 1.99, is_main: true },
      { sportsbook: "Pinnacle", market: "1st Half Asian Total Goals", name: "Over 1", points: 1, price: 1.75, is_main: true },
      { sportsbook: "Pinnacle", market: "Asian Handicap Relative Corners", selection: "Alpha United", points: -0.5, price: 1.9, is_main: true },
      { sportsbook: "Pinnacle", market: "Asian Handicap Relative Corners", selection: "Beta City", points: 0.5, price: 1.9, is_main: true },
    ],
  };

  it("keeps Pinnacle -0.25 as HKJC home gives level/half", () => {
    const prices = parseOpticPrices(fixture);
    expect(prices.filter((p) => p.market === "AH").map((p) => [p.selection, p.lineValue])).toEqual([
      ["H", -0.25],
      ["A", -0.25],
    ]);
    expect(prices.filter((p) => p.market === "OU").map((p) => [p.selection, p.lineValue])).toEqual([
      ["O", 2.75],
      ["U", 2.75],
    ]);
  });

  it("flips side and handicap when the provider fixture is reversed", () => {
    const prices = parseOpticPrices(fixture, true);
    expect(prices.filter((p) => p.market === "AH").map((p) => [p.selection, p.lineValue]).sort()).toEqual([
      ["H", 0.25],
      ["A", 0.25],
    ].sort());
  });

  it("excludes derivative markets and incoherent complementary prices", () => {
    const noisy = {
      ...fixture,
      odds: [
        ...fixture.odds,
        { sportsbook: "Pinnacle", market: "Asian Total Goals", name: "Over 3.25", points: 3.25, price: 4.19, is_main: true },
        { sportsbook: "Pinnacle", market: "Asian Total Goals", name: "Under 3.25", points: 3.25, price: 6.51, is_main: true },
      ],
    };
    const prices = parseOpticPrices(noisy);
    expect(prices.some((p) => p.market === "OU" && p.lineValue === 1)).toBe(false);
    expect(prices.some((p) => p.market === "AH" && p.lineValue === -0.5)).toBe(false);
    expect(prices.some((p) => p.market === "OU" && p.lineValue === 3.25)).toBe(false);
  });
});
