import type { Express } from "express";
import type { Server } from "node:http";
import { z } from "zod";
import { engine } from "./lib/engine";
import { createBackup, listBackups } from "./lib/backup";
import { storage } from "./storage";
import { formatLine } from "./lib/lines";
import { AUTO_SCAN_CHECK_MS, autoScanEnabled } from "./lib/scan";
import type { Market, Selection, SimulationBetDto, SimulationSummary, SimulationsResponse } from "@shared/types";

const clearSchema = z.object({ category: z.enum(["case1_arb", "case2_ev", "synth_arb", "all"]) });
let autoScanTimer: NodeJS.Timeout | null = null;
let autoScanStartupTimer: NodeJS.Timeout | null = null;

function installAutoWindowScan(): void {
  if (!autoScanEnabled() || autoScanTimer) return;
  const tick = async () => {
    try {
      // `runScan` records a clear TARGET_REACHED status and returns before any
      // fixture or price request if the strict simulation cap is complete.
      if (engine.scanConfigInfo().simulationTargetReached) {
        const outcome = await engine.runScan();
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            scope: "radar",
            event: "auto_window_scan",
            result: outcome.result,
            message: outcome.message,
          }),
        );
        return;
      }
      const inWindow = engine.windowPreview();
      if (!inWindow.length) return;
      const outcome = await engine.runScan();
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          scope: "radar",
          event: "auto_window_scan",
          result: outcome.result,
          selected: outcome.selected.length,
          passes: outcome.passes,
          detailCalls: outcome.detailCalls,
        }),
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          scope: "radar",
          event: "auto_window_scan_error",
          error: (err as Error).message,
        }),
      );
    }
  };
  // Give boot-time lightweight refresh enough time to populate the schedule.
  autoScanStartupTimer = setTimeout(() => void tick(), 30_000);
  autoScanStartupTimer.unref();
  autoScanTimer = setInterval(() => void tick(), AUTO_SCAN_CHECK_MS);
  autoScanTimer.unref();
}

function buildSimulations(): SimulationsResponse {
  const rows = storage.listSimulations();
  const bets: SimulationBetDto[] = rows.map((r) => ({
    id: r.bet.id,
    uniqueKey: r.bet.uniqueKey,
    category: r.bet.category as SimulationBetDto["category"],
    matchId: r.bet.matchId,
    matchLabel: r.bet.matchLabel,
    league: r.bet.league,
    market: r.bet.market as Market,
    lineKey: r.bet.lineKey,
    lineDisplay: formatLine(r.bet.market as Market, r.bet.lineKey ? Number(r.bet.lineKey) : null),
    selection: r.bet.selection as Selection,
    kickoffUtc: r.bet.kickoffUtc,
    totalStake: r.bet.totalStake,
    expectedPayout: r.bet.expectedPayout,
    expectedProfit: r.bet.expectedProfit,
    roi: r.bet.roi,
    evPct: r.bet.evPct,
    qTotal: r.bet.qTotal,
    placedAt: r.bet.placedAt,
    settledAt: r.bet.settledAt,
    resultStatus: r.bet.resultStatus,
    realizedReturn: r.bet.realizedReturn,
    realizedPnl: r.bet.realizedPnl,
    finalScore: r.bet.finalScore,
    legs: r.legs.map((l) => ({
      id: l.id,
      provider: l.provider,
      market: l.market as Market,
      lineKey: l.lineKey,
      lineDisplay: formatLine(l.market as Market, l.lineKey ? Number(l.lineKey) : null),
      selection: l.selection as Selection,
      decimalOdds: l.decimalOdds,
      stake: l.stake,
      synthetic: !!l.synthetic,
      syntheticDetail: l.syntheticDetail,
      legStatus: l.legStatus,
      legReturn: l.legReturn,
    })),
  }));

  const cats: SimulationSummary["category"][] = ["case1_arb", "case2_ev", "synth_arb"];
  const summaries: SimulationSummary[] = cats.map((c) => {
    const list = bets.filter((b) => b.category === c);
    const settled = list.filter((b) => b.settledAt);
    const totalStake = list.reduce((a, b) => a + b.totalStake, 0);
    const expectedProfit = list.reduce((a, b) => a + b.expectedProfit, 0);
    const realizedPnl = settled.reduce((a, b) => a + (b.realizedPnl ?? 0), 0);
    const settledStake = settled.reduce((a, b) => a + b.totalStake, 0);
    return {
      category: c,
      count: list.length,
      totalStake: Math.round(totalStake * 100) / 100,
      expectedProfit: Math.round(expectedProfit * 100) / 100,
      roi: totalStake > 0 ? expectedProfit / totalStake : 0,
      settledCount: settled.length,
      hitCount: settled.filter((b) => (b.realizedPnl ?? 0) > 0).length,
      realizedPnl: Math.round(realizedPnl * 100) / 100,
      realizedRoi: settledStake > 0 ? realizedPnl / settledStake : 0,
    };
  });

  const settledAll = bets.filter((b) => b.settledAt);
  const settledStake = settledAll.reduce((a, b) => a + b.totalStake, 0);
  const realizedPnl = settledAll.reduce((a, b) => a + (b.realizedPnl ?? 0), 0);
  return {
    bets,
    summaries,
    overall: {
      settledCount: settledAll.length,
      totalStake: Math.round(settledStake * 100) / 100,
      realizedPnl: Math.round(realizedPnl * 100) / 100,
      realizedRoi: settledStake > 0 ? realizedPnl / settledStake : 0,
      hitRate: settledAll.length ? settledAll.filter((b) => (b.realizedPnl ?? 0) > 0).length / settledAll.length : 0,
    },
  };
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // Boot warm-up is LIGHTWEIGHT ONLY (HKJC single call + cached fixture list).
  // It never polls per-match Pinnacle odds detail. Set RADAR_BOOTSTRAP=0 to skip.
  if (process.env.RADAR_BOOTSTRAP !== "0") {
    void engine.refresh({ mode: "lightweight" }).catch(() => undefined);
  }
  installAutoWindowScan();

  app.get("/api/status", (_req, res) => {
    const dash = engine.buildDashboardData();
    res.json(dash.status);
  });

  // Read-only: the dashboard's automated 20 s polling must never trigger an
  // all-match Pinnacle detail scan. A throttled lightweight fixture/HKJC
  // refresh is allowed because it makes zero per-match detail requests.
  app.get("/api/dashboard", async (_req, res) => {
    void engine.refresh({ mode: "lightweight" }).catch(() => undefined);
    res.json(engine.buildDashboardData());
  });

  /**
   * Manual refresh (human action).
   *   default        -> dense window scope (<=30 min to kickoff) detail refresh
   *   ?scope=full    -> explicit all-match detail scan; NOT used by any
   *                     recurring/automated path
   *   ?scope=24h     -> future 24 h pre-warm; refreshes detail but never buys
   *   ?scope=light   -> fixtures + HKJC only
   */
  app.post("/api/refresh", async (req, res) => {
    const scope = String(req.query.scope ?? "window");
    const mode =
      scope === "full"
        ? "full"
        : scope === "24h"
          ? "prewarm24h"
          : scope === "light"
            ? "lightweight"
            : "window";
    const r = await engine.refresh({ force: true, mode });
    res.json({ ...r, status: engine.buildDashboardData().status });
  });

  /**
   * Dense pre-kickoff window scan helper — the only automated scan path.
   * Suitable for an external trigger. This route creates no external schedule.
   * Returns NO_WINDOW immediately, with zero provider detail calls, when no
   * match is within the window.
   */
  app.post("/api/scan/window", async (_req, res) => {
    const outcome = await engine.runScan();
    res.json(outcome);
  });

  app.get("/api/scan/window", (_req, res) => {
    res.json({ config: engine.scanConfigInfo(), inWindow: engine.windowPreview() });
  });

  app.get("/api/opportunities", (_req, res) => {
    res.json(storage.listOpportunities());
  });

  app.get("/api/simulations", (_req, res) => {
    res.json(buildSimulations());
  });

  app.post("/api/simulations/settle", async (_req, res) => {
    const result = await engine.settleDue(true);
    res.json({ ...result, simulations: buildSimulations() });
  });

  app.post("/api/simulations/clear", (req, res) => {
    const parsed = clearSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid category" });
    const removed = engine.clearSimulations(parsed.data.category === "all" ? undefined : parsed.data.category);
    return res.json({ removed, simulations: buildSimulations() });
  });

  app.get("/api/backups", (_req, res) => {
    res.json({ backups: listBackups(), retain: 14 });
  });

  app.post("/api/backups", (_req, res) => {
    const info = createBackup();
    res.json({ created: info, backups: listBackups() });
  });

  app.get("/api/history", (req, res) => {
    const matchId = String(req.query.matchId ?? "");
    const market = String(req.query.market ?? "");
    const lineKey = String(req.query.lineKey ?? "");
    if (!matchId) return res.status(400).json({ message: "matchId required" });
    return res.json(storage.priceHistory(matchId, market, lineKey));
  });

  return httpServer;
}
