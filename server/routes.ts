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
  parseResearchFilters,
  researchCsv,
  researchDataset,
} from "./lib/research";
import { ouSignalDataset } from "./lib/ou-signals";
import {
  DISK_ALERT_STATE_KEY,
  diskTarget,
  parseDiskAlertState,
  readDiskUsage,
  runDiskCheck,
} from "./lib/disk-guard";
import { sendTelegramText } from "./lib/telegram";
import { getState, setState } from "./lib/store";
import { syncQuoteDirectionWatchObservations } from "./lib/quote-direction-watch";
import type { Market, Selection, SimulationBetDto, SimulationSummary, SimulationsResponse } from "@shared/types";

const clearSchema = z.object({ category: z.enum(["case1_arb", "case2_ev", "synth_arb", "all"]) });
const matchRefreshSchema = z.object({ matchId: z.string().min(1).max(120) });
let autoScanTimer: NodeJS.Timeout | null = null;
let autoScanStartupTimer: NodeJS.Timeout | null = null;
let researchTimelineTimer: NodeJS.Timeout | null = null;
let researchTimelineStartupTimer: NodeJS.Timeout | null = null;
let researchTimelineInFlight: ReturnType<typeof engine.runResearchTimelineTick> | null = null;
let researchMilestoneTimer: NodeJS.Timeout | null = null;
let researchMilestoneStartupTimer: NodeJS.Timeout | null = null;
let researchMilestoneInFlight: ReturnType<typeof engine.runResearchMilestoneTick> | null = null;
let researchLowerMilestoneTimer: NodeJS.Timeout | null = null;
let researchLowerMilestoneStartupTimer: NodeJS.Timeout | null = null;
let researchLowerMilestoneInFlight:
  ReturnType<typeof engine.runResearchLowerMilestoneTick> | null = null;
let hourlyPrewarmTimer: NodeJS.Timeout | null = null;
let hourlyPrewarmStartupTimer: NodeJS.Timeout | null = null;
let cornerValidationInFlight: Promise<unknown> | null = null;
let researchResultsTimer: NodeJS.Timeout | null = null;
let researchResultsStartupTimer: NodeJS.Timeout | null = null;
let researchResultsInFlight: Promise<{ candidates: number; collected: number }> | null = null;
let researchOpeningsTimer: NodeJS.Timeout | null = null;
let researchOpeningsStartupTimer: NodeJS.Timeout | null = null;
let researchOpeningsInFlight: Promise<Awaited<ReturnType<typeof collectResearchInitialSnapshots>>> | null = null;
let quoteDirectionWatchTimer: NodeJS.Timeout | null = null;
let quoteDirectionWatchStartupTimer: NodeJS.Timeout | null = null;
let quoteDirectionWatchInFlight: Promise<ReturnType<typeof syncQuoteDirectionWatchObservations>> | null = null;
let diskGuardTimer: NodeJS.Timeout | null = null;
let diskGuardStartupTimer: NodeJS.Timeout | null = null;
let diskGuardInFlight: Promise<unknown> | null = null;
let pinnacleTranslationBackfillTimer: NodeJS.Timeout | null = null;
let pinnacleTranslationBackfillStartupTimer: NodeJS.Timeout | null = null;
let pinnacleTranslationBackfillInFlight: Promise<{ scanned: number; translated: number; attempts: number }> | null = null;
const researchHkjc = new HkjcProvider();

export const DISK_GUARD_INTERVAL_MS = 30 * 60_000;

/**
 * Watch free space on the database volume. The 2026-09-05 outage filled the
 * disk to 100% with nothing alerting, and a full disk makes SQLite writes fail
 * while the dashboard only shows the affected checkpoints as missing.
 */
function installDiskGuard(): void {
  if (process.env.RADAR_DISK_GUARD === "0" || diskGuardTimer) return;
  const run = async () => {
    if (diskGuardInFlight) return;
    const check = runDiskCheck({
      usage: () => readDiskUsage(diskTarget(process.env.RADAR_DB ?? "data.db")),
      readState: () => parseDiskAlertState(getState(DISK_ALERT_STATE_KEY)),
      writeState: (state) => setState(DISK_ALERT_STATE_KEY, JSON.stringify(state)),
      send: (text) => sendTelegramText(text),
    });
    diskGuardInFlight = check;
    try {
      const outcome = await check;
      if (outcome.shouldAlert || outcome.level !== "ok") {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          scope: "radar",
          event: "disk_guard",
          level: outcome.level,
          freeBytes: outcome.freeBytes,
          totalBytes: outcome.totalBytes,
          freeRatio: Number(outcome.freeRatio.toFixed(4)),
          alerted: outcome.shouldAlert,
        }));
      }
    } catch (err) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "disk_guard_error",
        error: (err as Error).message,
      }));
    } finally {
      diskGuardInFlight = null;
    }
  };
  diskGuardStartupTimer = setTimeout(() => void run(), 60_000);
  diskGuardStartupTimer.unref();
  diskGuardTimer = setInterval(() => void run(), DISK_GUARD_INTERVAL_MS);
  diskGuardTimer.unref();
}

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

/**
 * Silent and bounded forward-watch collector. It reads research snapshots and
 * writes only quote_direction_watch_observations; it has no Telegram path.
 */
function installQuoteDirectionWatchCollection(): void {
  if (process.env.RADAR_QUOTE_DIRECTION_WATCHES === "0" || quoteDirectionWatchTimer) return;
  const configuredSeconds = Number(process.env.RADAR_QUOTE_DIRECTION_WATCH_INTERVAL_SECONDS ?? 60);
  const intervalMs = Math.max(30, Math.min(15 * 60, Number.isFinite(configuredSeconds) ? configuredSeconds : 60)) * 1_000;
  const run = async () => {
    if (quoteDirectionWatchInFlight) return;
    quoteDirectionWatchInFlight = Promise.resolve().then(() => syncQuoteDirectionWatchObservations());
    try {
      const outcome = await quoteDirectionWatchInFlight;
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "quote_direction_watch",
        ...outcome,
      }));
    } catch (err) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "quote_direction_watch_error",
        error: (err as Error).message,
      }));
    } finally {
      quoteDirectionWatchInFlight = null;
    }
  };
  quoteDirectionWatchStartupTimer = setTimeout(() => void run(), 120_000);
  quoteDirectionWatchStartupTimer.unref();
  quoteDirectionWatchTimer = setInterval(() => void run(), intervalMs);
  quoteDirectionWatchTimer.unref();
}

function installAutoWindowScan(): void {
  if (!autoScanEnabled() || autoScanTimer) return;
  const tickGate = createAutoScanTickGate();
  const tick = () => {
    void tickGate.run(async () => {
      try {
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

/**
 * Research checkpoints must not share the dense HKJC scan gate. A dense scan
 * can legitimately run for the full 30-minute window; coupling the two loops
 * would suppress every Crown/Pinnacle T30 tick during that period.
 */
function installResearchTimelineCollection(): void {
  if (!autoScanEnabled() || researchTimelineTimer) return;
  const run = async () => {
    if (researchTimelineInFlight) return;
    // Discovery/mapping/opening preparation only. The isolated milestone
    // worker is the sole automated T30/T15/T5 writer.
    researchTimelineInFlight = engine.runResearchTimelineTick({
      captureMilestones: false,
    });
    try {
      const research = await researchTimelineInFlight;
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "auto_research_timeline",
        selected: research.selected,
        detailCalls: research.detailCalls,
      }));
    } catch (err) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "auto_research_timeline_error",
        error: (err as Error).message,
      }));
    } finally {
      researchTimelineInFlight = null;
    }
  };
  researchTimelineStartupTimer = setTimeout(() => void run(), 30_000);
  researchTimelineStartupTimer.unref();
  researchTimelineTimer = setInterval(() => void run(), AUTO_SCAN_CHECK_MS);
  researchTimelineTimer.unref();
}

type ResearchMilestoneHooks = {
  beforeRun?: () => void | Promise<void>;
  afterRun?: () => void | Promise<void>;
};

function installResearchMilestoneCollection(hooks: ResearchMilestoneHooks = {}): void {
  if (!autoScanEnabled() || researchMilestoneTimer || researchMilestoneStartupTimer) return;
  const run = async () => {
    if (researchMilestoneInFlight) return;
    researchMilestoneInFlight = (async () => {
      await hooks.beforeRun?.();
      return engine.runResearchMilestoneTick();
    })();
    try {
      const outcome = await researchMilestoneInFlight;
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "research_milestone",
        ...outcome,
      }));
    } catch (err) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "research_milestone_error",
        error: (err as Error).message,
      }));
    } finally {
      researchMilestoneInFlight = null;
      try {
        await hooks.afterRun?.();
      } catch (err) {
        console.error(JSON.stringify({
          ts: new Date().toISOString(),
          scope: "radar",
          event: "research_milestone_after_run_error",
          error: (err as Error).message,
        }));
      }
    }
  };
  researchMilestoneStartupTimer = setTimeout(() => {
    void run();
    researchMilestoneTimer = setInterval(() => void run(), AUTO_SCAN_CHECK_MS);
    researchMilestoneTimer.unref();
  }, 5_000);
  researchMilestoneStartupTimer.unref();
}

/**
 * Starts one bounded Pinnacle+Crown wave 25 seconds after the core milestone
 * worker. Production owns this timer in a separate worker thread, so its
 * provider calls, SQLite work and notification materialization cannot block
 * the latency-sensitive HKJC+Pinnacle event loop.
 */
function installResearchLowerMilestoneCollection(): void {
  if (
    !autoScanEnabled()
    || researchLowerMilestoneTimer
    || researchLowerMilestoneStartupTimer
  ) return;
  const run = async () => {
    if (researchLowerMilestoneInFlight) return;
    researchLowerMilestoneInFlight = engine.runResearchLowerMilestoneTick();
    try {
      const outcome = await researchLowerMilestoneInFlight;
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "research_milestone_lower_tier",
        ...outcome,
      }));
    } catch (err) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        scope: "radar",
        event: "research_milestone_lower_tier_error",
        error: (err as Error).message,
      }));
    } finally {
      researchLowerMilestoneInFlight = null;
    }
  };
  researchLowerMilestoneStartupTimer = setTimeout(() => {
    void run();
    researchLowerMilestoneTimer = setInterval(() => void run(), AUTO_SCAN_CHECK_MS);
    researchLowerMilestoneTimer.unref();
  }, 30_000);
  researchLowerMilestoneStartupTimer.unref();
}

/**
 * Independent, rate-limited backfill loop that fills Chinese labels in
 * `pinnacle_translations` so OU Telegram notifications can render Pinnacle-only
 * fixtures in Chinese. It is intentionally decoupled from the research
 * timeline: it never runs on the auto-scan tick and never blocks OU capture.
 * Enabled by default; set RADAR_PINNACLE_TRANSLATION_BACKFILL=0 to disable.
 * Default cadence: every minute, up to 100 fixtures per run. Upcoming fixtures
 * are prioritised by kickoff time so untranslated old rows cannot starve live
 * research coverage.
 */
function installPinnacleTranslationBackfill(): void {
  if (
    process.env.RADAR_PINNACLE_TRANSLATION_BACKFILL === "0" ||
    pinnacleTranslationBackfillTimer
  ) return;
  const configuredMinutes = Number(
    process.env.RADAR_PINNACLE_TRANSLATION_BACKFILL_INTERVAL_MINUTES ?? 1,
  );
  const intervalMs =
    Math.max(1, Math.min(6 * 60, Number.isFinite(configuredMinutes) ? configuredMinutes : 1)) *
    60_000;
  const configuredBatch = Number(
    process.env.RADAR_PINNACLE_TRANSLATION_BACKFILL_BATCH ?? 100,
  );
  const batchSize = Math.max(
    1,
    Math.min(200, Number.isFinite(configuredBatch) ? configuredBatch : 100),
  );
  const run = async () => {
    if (pinnacleTranslationBackfillInFlight) return;
    const now = Date.now();
    const targets = engine.listPinnacleTranslationBackfillTargets(batchSize * 2, now);
    pinnacleTranslationBackfillInFlight = engine.runPinnacleTranslationBackfillBatch(
      targets,
      now,
      { maxFixtures: batchSize },
    );
    try {
      const outcome = await pinnacleTranslationBackfillInFlight;
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          scope: "radar",
          event: "pinnacle_translation_backfill",
          ...outcome,
        }),
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          scope: "radar",
          event: "pinnacle_translation_backfill_error",
          error: (err as Error).message,
        }),
      );
    } finally {
      pinnacleTranslationBackfillInFlight = null;
    }
  };
  // Let auto-scan and prewarm land first before touching third-party feeds.
  pinnacleTranslationBackfillStartupTimer = setTimeout(() => void run(), 3 * 60_000);
  pinnacleTranslationBackfillStartupTimer.unref();
  pinnacleTranslationBackfillTimer = setInterval(() => void run(), intervalMs);
  pinnacleTranslationBackfillTimer.unref();
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

/**
 * Start every recurring collector in one process. Production runs this in a
 * worker thread so long provider/matching/database passes cannot block the
 * Express event loop and make nginx return 504.
 */
export function startBackgroundCollectors(): void {
  installQuoteDirectionWatchCollection();
  installDiskGuard();
}

/** Run only the latency-sensitive T30/T15/T5 collector in its own worker. */
export function startResearchMilestoneCollector(hooks: ResearchMilestoneHooks = {}): void {
  installResearchMilestoneCollection(hooks);
}

/** Run only the bounded Pinnacle+Crown checkpoint wave in its own worker. */
export function startResearchLowerMilestoneCollector(): void {
  installResearchLowerMilestoneCollection();
}

/**
 * One preemptible lower-priority cycle. Production runs this in a disposable
 * worker owned by the core milestone scheduler, never from the general
 * background collector.
 */
export async function runResearchLowerCycleOnce(
  dispatchOffset?: number,
  onMilestone?: (
    outcome: Awaited<ReturnType<typeof engine.runResearchLowerMilestoneTick>>,
  ) => void | Promise<void>,
) {
  const milestone = await engine.runResearchLowerMilestoneTick(dispatchOffset);
  await onMilestone?.(milestone);
  const timeline = await engine.runResearchTimelineTick({ captureMilestones: false });
  const now = Date.now();
  const runIfDue = async <T>(
    stateKey: string,
    intervalMs: number,
    task: () => Promise<T>,
  ): Promise<T | null> => {
    const lastRun = Number(getState(stateKey) ?? 0);
    if (Number.isFinite(lastRun) && now - lastRun < intervalMs) return null;
    const outcome = await task();
    setState(stateKey, String(Date.now()));
    return outcome;
  };
  const openings = process.env.RADAR_RESEARCH_OPENINGS === "0"
    ? null
    : await runIfDue(
        "research_lower_openings_last_run",
        Math.max(
          5,
          Math.min(
            24 * 60,
            Number(process.env.RADAR_RESEARCH_OPENING_INTERVAL_MINUTES ?? 30) || 30,
          ),
        ) * 60_000,
        () => collectResearchInitialSnapshots(),
      );
  const results = process.env.RADAR_RESEARCH_RESULTS === "0"
    ? null
    : await runIfDue(
        "research_lower_results_last_run",
        60 * 60_000,
        () => collectResearchResults(researchHkjc),
      );
  const prewarm = process.env.RADAR_HOURLY_PREWARM === "0"
    ? null
    : await runIfDue(
        "research_lower_prewarm_last_run",
        60 * 60_000,
        () => engine.refresh({ force: true, mode: "prewarm24h" }),
      );
  // Dense scanning is intentionally last. It may remain active for a long
  // live window and will be killed at the next core tick; fixture preparation
  // and checkpoint statistics must never sit behind it.
  let scan: Awaited<ReturnType<typeof engine.runScan>> | null = null;
  if (engine.windowPreview().length) {
    scan = await engine.runScan();
  }
  return {
    milestone,
    scan: scan
      ? {
          result: scan.result,
          selected: scan.selected.length,
          passes: scan.passes,
          detailCalls: scan.detailCalls,
        }
      : null,
    timeline,
    openings,
    results,
    prewarm: prewarm
      ? {
          started: prewarm.started,
          throttled: prewarm.throttled,
          mode: prewarm.mode,
        }
      : null,
  };
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  app.get("/api/status", (_req, res) => {
    const dash = engine.dashboardData();
    res.json(dash.status);
  });

  // Strictly read-only: the dashboard polls every 20 seconds. Refresh work is
  // owned by the background schedulers and explicit POST endpoints; starting
  // it here can block the Node event loop long enough for nginx to return 504.
  app.get("/api/dashboard", (_req, res) => {
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

  app.post("/api/research/results/collect", async (_req, res) => {
    try {
      if (researchResultsInFlight) {
        const outcome = await researchResultsInFlight;
        return res.json({ ok: true, reused_in_flight: true, ...outcome });
      }
      researchResultsInFlight = collectResearchResults(researchHkjc);
      const outcome = await researchResultsInFlight;
      researchResultsInFlight = null;
      return res.json({ ok: true, ...outcome });
    } catch (err) {
      researchResultsInFlight = null;
      return res.status(500).json({ ok: false, error: (err as Error).message });
    }
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
