import type { Express } from "express";
import type { Server } from "node:http";
import { z } from "zod";
import { engine } from "./lib/engine";
import { createBackup, listBackups } from "./lib/backup";
import { storage } from "./storage";
import { formatLine, formatSelectionLine } from "./lib/lines";
import { AUTO_SCAN_CHECK_MS, autoScanEnabled, createAutoScanTickGate } from "./lib/scan";
import { readCornerValidationReport, runPinnapiCornerValidation } from "./lib/corner-validation";
import { PinnapiProvider } from "./providers/pinnapi";
import { HkjcProvider } from "./providers/hkjc";
import {
  collectResearchInitialSnapshots,
  collectResearchResults,
  collectTodayCrownBackfill,
  parseResearchFilters,
  researchCsv,
  researchDataset,
} from "./lib/research";
import { ouSignalDataset } from "./lib/ou-signals";
import type { Market, Selection, SimulationBetDto, SimulationSummary, SimulationsResponse } from "@shared/types";

const clearSchema = z.object({ category: z.enum(["case1_arb", "case2_ev", "synth_arb", "all"]) });
const matchRefreshSchema = z.object({ matchId: z.string().min(1).max(120) });
let autoScanTimer: NodeJS.Timeout | null = null;
let autoScanStartupTimer: NodeJS.Timeout | null = null;
let hourlyPrewarmTimer: NodeJS.Timeout | null = null;
let hourlyPrewarmStartupTimer: NodeJS.Timeout | null = null;
let cornerValidationInFlight: Promise<unknown> | null = null;
let researchResultsTimer: NodeJS.Timeout | null = null;
let researchResultsStartupTimer: NodeJS.Timeout | null = null;
let researchResultsInFlight: Promise<{ candidates: number; collected: number }> | null = null;
let researchOpeningsTimer: NodeJS.Timeout | null = null;
let researchOpeningsStartupTimer: NodeJS.Timeout | null = null;
let researchOpeningsInFlight: Promise<Awaited<ReturnType<typeof collectResearchInitialSnapshots>>> | null = null;
let crownBackfillTimer: NodeJS.Timeout | null = null;
let crownBackfillStartupTimer: NodeJS.Timeout | null = null;
let crownBackfillInFlight: Promise<Awaited<ReturnType<typeof collectTodayCrownBackfill>>> | null = null;
const researchHkjc = new HkjcProvider();

function installResearchResultCollection(): void {
  if (process.env.RADAR_RESEARCH_RESULTS === "0" || researchResultsTimer) return;
  const run = async () => {
    if (researchResultsInFlight) return;
    researchResultsInFlight = collectResearchResults(researchHkjc);
    try {
      const outcome = await researchResultsInFlight;
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "research_results",
        ...outcome,
      }));
    } catch (err) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "research_results_error",
        error: (err as Error).message,
      }));
    } finally {
      researchResultsInFlight = null;
    }
  };
  researchResultsStartupTimer = setTimeout(() => void run(), 10 * 60_000);
  researchResultsStartupTimer.unref();
  researchResultsTimer = setInterval(() => void run(), 60 * 60_000);
  researchResultsTimer.unref();
}

/**
 * Crown fixtures that already kicked off today can sit without an official
 * result or an opening snapshot.  This research-only job backfills both so the
 * research page fills in naturally; it never touches execution tables.
 */
function installTodayCrownBackfill(): void {
  if (process.env.RADAR_TODAY_CROWN_BACKFILL === "0" || crownBackfillTimer) return;
  const run = async () => {
    if (crownBackfillInFlight) return;
    crownBackfillInFlight = collectTodayCrownBackfill();
    try {
      const outcome = await crownBackfillInFlight;
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "today_crown_backfill_run",
        ...outcome,
      }));
    } catch (err) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "today_crown_backfill_run_error",
        error: (err as Error).message,
      }));
    } finally {
      crownBackfillInFlight = null;
    }
  };
  crownBackfillStartupTimer = setTimeout(() => void run(), 5 * 60_000);
  crownBackfillStartupTimer.unref();
  crownBackfillTimer = setInterval(() => void run(), 15 * 60_000);
  crownBackfillTimer.unref();
}

/**
 * The opening-history job is deliberately separate from window scans and
 * betting.  It has no dependency on simulation targets and only invokes the
 * research-only Tipsme collector.
 */
function installResearchOpeningCollection(): void {
  if (process.env.RADAR_RESEARCH_OPENINGS === "0" || researchOpeningsTimer) return;
  const configuredMinutes = Number(process.env.RADAR_RESEARCH_OPENING_INTERVAL_MINUTES ?? 30);
  const intervalMs = Math.max(5, Math.min(24 * 60, Number.isFinite(configuredMinutes) ? configuredMinutes : 30)) * 60_000;
  const run = async () => {
    if (researchOpeningsInFlight) return;
    researchOpeningsInFlight = collectResearchInitialSnapshots();
    try {
      const outcome = await researchOpeningsInFlight;
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "research_openings",
        ...outcome,
      }));
    } catch (err) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "research_openings_error",
        error: (err as Error).message,
      }));
    } finally {
      researchOpeningsInFlight = null;
    }
  };
  researchOpeningsStartupTimer = setTimeout(() => void run(), 90_000);
  researchOpeningsStartupTimer.unref();
  researchOpeningsTimer = setInterval(() => void run(), intervalMs);
  researchOpeningsTimer.unref();
}

function installAutoWindowScan(): void {
  if (!autoScanEnabled() || autoScanTimer) return;
  const tickGate = createAutoScanTickGate();
  const tick = () => {
    void tickGate.run(async () => {
      try {
        const research = await engine.runResearchTimelineTick();
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            scope: "radar",
            event: "auto_research_timeline",
            selected: research.selected,
            detailCalls: research.detailCalls,
          }),
        );
        if (engine.scanConfigInfo().simulationTargetReached) return;
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
    });
  };
  // Give boot-time lightweight refresh enough time to populate the schedule.
  autoScanStartupTimer = setTimeout(() => void tick(), 30_000);
  autoScanStartupTimer.unref();
  autoScanTimer = setInterval(() => void tick(), AUTO_SCAN_CHECK_MS);
  autoScanTimer.unref();
}

function installHourlyPrewarm(): void {
  if (process.env.RADAR_HOURLY_PREWARM === "0" || hourlyPrewarmTimer) return;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const outcome = await engine.refresh({ force: true, mode: "prewarm24h" });
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          scope: "radar",
          event: "hourly_prewarm",
          started: outcome.started,
          throttled: outcome.throttled,
          mode: outcome.mode,
        }),
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          scope: "radar",
          event: "hourly_prewarm_error",
          error: (err as Error).message,
        }),
      );
    } finally {
      running = false;
    }
  };
  // The normal boot refresh runs first; pre-warm follows after five minutes.
  hourlyPrewarmStartupTimer = setTimeout(() => void run(), 5 * 60_000);
  hourlyPrewarmStartupTimer.unref();
  hourlyPrewarmTimer = setInterval(() => void run(), 60 * 60_000);
  hourlyPrewarmTimer.unref();
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
    lineDisplay: formatSelectionLine(
      r.bet.market as Market,
      r.bet.lineKey ? Number(r.bet.lineKey) : null,
      r.bet.selection,
    ),
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
    settlementSource: r.bet.settlementSource,
    legs: r.legs.map((l) => ({
      id: l.id,
      provider: l.provider,
      market: l.market as Market,
      lineKey: l.lineKey,
      lineDisplay: formatSelectionLine(
        l.market as Market,
        l.lineKey ? Number(l.lineKey) : null,
        l.selection,
      ),
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
  installHourlyPrewarm();
  installResearchOpeningCollection();
  installResearchResultCollection();
  installTodayCrownBackfill();

  app.get("/api/status", (_req, res) => {
    const dash = engine.dashboardData();
    res.json(dash.status);
  });

  // Read-only: the dashboard's automated 20 s polling must never trigger an
  // all-match Pinnacle detail scan. A throttled lightweight fixture/HKJC
  // refresh is allowed because it makes zero per-match detail requests.
  app.get("/api/dashboard", async (_req, res) => {
    void engine.refresh({ mode: "lightweight" }).catch(() => undefined);
    res.json(engine.dashboardData());
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
    res.json({ ...r, status: engine.dashboardData().status });
  });

  app.post("/api/refresh/match", async (req, res) => {
    const parsed = matchRefreshSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "matchId 格式不正確" });
    try {
      return res.json(await engine.refreshMatch(parsed.data.matchId));
    } catch (err) {
      const code = (err as Error).message;
      if (code === "MATCH_NOT_FOUND") return res.status(404).json({ message: "找不到指定賽事" });
      if (code === "MATCH_NOT_MAPPED") return res.status(409).json({ message: "此賽事尚未配對 Pinnacle，暫時無法單場刷新" });
      if (code === "MATCH_ALREADY_STARTED") return res.status(409).json({ message: "賽事已經開賽，賽前盤不再刷新" });
      console.error(JSON.stringify({ ts: new Date().toISOString(), scope: "radar", event: "match_refresh_error", error: code }));
      return res.status(502).json({ message: "單場刷新失敗，請稍後再試" });
    }
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

  app.get("/api/validation/pinnapi-corners", async (_req, res) => {
    const report = await readCornerValidationReport();
    if (!report) return res.status(404).json({ message: "尚未執行 PinnAPI 角球市場驗證" });
    return res.json(report);
  });

  app.post("/api/validation/pinnapi-corners", async (req, res) => {
    if (cornerValidationInFlight) {
      return res.status(409).json({ message: "角球市場驗證正在執行" });
    }
    const requested = Number(req.query.limit ?? 20);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(30, Math.floor(requested))) : 20;
    try {
      cornerValidationInFlight = runPinnapiCornerValidation(new PinnapiProvider(), { limit });
      const report = await cornerValidationInFlight;
      return res.json(report);
    } catch (err) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "pinnapi_corner_validation_error",
        error: (err as Error).message,
      }));
      return res.status(502).json({ message: "PinnAPI 角球市場驗證失敗，未啟用任何角球投注" });
    } finally {
      cornerValidationInFlight = null;
    }
  });

  app.get("/api/history", (req, res) => {
    const matchId = String(req.query.matchId ?? "");
    const market = String(req.query.market ?? "");
    const lineKey = String(req.query.lineKey ?? "");
    if (!matchId) return res.status(400).json({ message: "matchId required" });
    return res.json(storage.priceHistory(matchId, market, lineKey));
  });

  app.get("/api/research", (req, res) => {
    return res.json(researchDataset(parseResearchFilters(req.query as Record<string, unknown>)));
  });

  app.get("/api/ou-signals", (_req, res) => {
    return res.json(ouSignalDataset());
  });

  app.get("/api/research/export", (req, res) => {
    const kind = req.query.kind === "results" ? "results" : "timeline";
    const filters = parseResearchFilters(req.query as Record<string, unknown>);
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="odds-radar-${kind}-${date}.csv"`);
    return res.send(researchCsv(kind, filters));
  });

  return httpServer;
}
