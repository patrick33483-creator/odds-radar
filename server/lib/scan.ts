/**
 * 開賽前 30 分鐘密集掃描 — the ONLY automated scanning path.
 *
 * Policy (replaces the old all-match polling loop):
 *   - When triggered, fetch LIGHTWEIGHT fixture/mapping data only (HKJC's single
 *     pre-match GraphQL call + cached PinnAPI fixture mapping).
 *   - Select ONLY pre-match events with 0 < minutes_to_kickoff <= window
 *     (default 30). Already-started / in-play / finished events are excluded.
 *   - If nothing is in the window: return NO_WINDOW immediately and make ZERO
 *     per-match Pinnacle detail calls.
 *   - Otherwise poll just those events densely, in-process, and stop when every
 *     selected event has kicked off or the moment a simulated bet is created.
 *   - Re-evaluate the loaded schedule on every pass so newly eligible events can
 *     join an already-running dense session.
 *
 * The server checks the already-loaded HKJC schedule every 30 seconds and calls
 * this scanner only when an eligible event is inside the window. The interval
 * inside each dense run remains env-configurable:
 *
 *   RADAR_SCAN_WINDOW_MIN        default 30   (clamped 1..30)
 *   RADAR_SCAN_INTERVAL_SEC      default 30   (clamped 5..120)
 */

import type { ScanOutcome } from "@shared/types";

export const SCAN_HARD_LIMIT_SEC = 30 * 60;
export const AUTO_SCAN_CHECK_MS = 30_000;

export function autoScanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RADAR_AUTO_SCAN !== "0";
}

export interface ScanConfig {
  windowMinutes: number;
  intervalSec: number;
  maxRuntimeSec: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Env-driven config. maxRuntimeSec is informational: one full scan window. */
export function scanConfig(env: NodeJS.ProcessEnv = process.env): ScanConfig {
  const windowMinutes = clamp(Math.round(num(env.RADAR_SCAN_WINDOW_MIN, 30)), 1, 30);
  const intervalSec = clamp(Math.round(num(env.RADAR_SCAN_INTERVAL_SEC, 30)), 5, 120);
  const maxRuntimeSec = windowMinutes * 60;
  return { windowMinutes, intervalSec, maxRuntimeSec };
}

/**
 * Strict optional simulation cap for controlled test runs. Zero retains the
 * existing unlimited behavior; positive values are whole-bet limits.
 */
export function simulationTarget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.RADAR_SIM_TARGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export function simulationTargetReached(count: number, target = simulationTarget()): boolean {
  return target > 0 && count >= target;
}

/** Number of inserts still permitted; Infinity means the default unlimited mode. */
export function remainingSimulationCapacity(count: number, target = simulationTarget()): number {
  return target > 0 ? Math.max(0, target - count) : Number.POSITIVE_INFINITY;
}

export interface ScanCandidate {
  matchId: string;
  matchLabel: string;
  kickoffUtc: number;
  inplay: boolean;
  status: string;
  /** Pinnacle-side id; unmapped events cannot be compared and are skipped. */
  pinnacleMatchId: string | null;
}

const STARTED_STATUS = /INPLAY|LIVE|FINISHED|ENDED|ABANDON|CANCEL|POSTPONE|RESULT/i;

/**
 * Pure selector: strictly 0 < minutes_to_kickoff <= window, pre-match only,
 * Pinnacle-mapped only. Kickoff exactly now (or in the past) is excluded.
 */
export function selectWindowEvents(
  candidates: ScanCandidate[],
  now: number,
  cfg: ScanConfig,
): Array<ScanCandidate & { minutesToKickoff: number }> {
  const windowMs = cfg.windowMinutes * 60_000;
  return candidates
    .filter((c) => !c.inplay)
    .filter((c) => !STARTED_STATUS.test(c.status ?? ""))
    .filter((c) => !!c.pinnacleMatchId)
    .map((c) => ({ ...c, minutesToKickoff: (c.kickoffUtc - now) / 60_000 }))
    .filter((c) => c.kickoffUtc - now > 0 && c.kickoffUtc - now <= windowMs)
    .sort((a, b) => a.kickoffUtc - b.kickoffUtc);
}

/**
 * Final safety gate for simulated purchases. A simulation may only be created
 * after an opportunity is observed while the match is strictly inside the
 * pre-kickoff scan window.
 */
export function isSimulationPurchaseWindow(
  kickoffUtc: number,
  now: number,
  windowMinutes = 30,
): boolean {
  const remaining = kickoffUtc - now;
  return remaining > 0 && remaining <= windowMinutes * 60_000;
}

/** Hourly pre-warm scope: future, mapped events within the next 24 hours. */
export function isPrewarmWindow(kickoffUtc: number, now: number, horizonHours = 24): boolean {
  const remaining = kickoffUtc - now;
  return remaining > 0 && remaining <= horizonHours * 60 * 60_000;
}

export interface ScanDeps {
  now(): number;
  /** Lightweight fixtures + mapping. MUST NOT make per-match odds detail calls. */
  loadCandidates(): Promise<ScanCandidate[]>;
  /**
   * One dense pass over the selected events. `bet|...` keys signal that a
   * simulation was inserted; other opportunity keys are informational only and
   * must not end the T-30 polling session.
   */
  pollPass(events: ScanCandidate[]): Promise<{ detailCalls: number; newOpportunityKeys: string[] }>;
  sleep(ms: number): Promise<void>;
  config: ScanConfig;
}

/**
 * Run one continuous dense-scan session. Never scans outside the window and
 * never touches per-match detail endpoints when the window is empty.
 */
export async function runWindowScan(deps: ScanDeps): Promise<ScanOutcome> {
  const cfg = deps.config;
  const startedAt = deps.now();
  const base = {
    startedAt,
    windowMinutes: cfg.windowMinutes,
    intervalSec: cfg.intervalSec,
    maxRuntimeSec: cfg.maxRuntimeSec,
  };

  let candidates: ScanCandidate[];
  try {
    candidates = await deps.loadCandidates();
  } catch (err) {
    const finishedAt = deps.now();
    return {
      ...base,
      result: "ERROR",
      finishedAt,
      runtimeMs: finishedAt - startedAt,
      selected: [],
      passes: 0,
      detailCalls: 0,
      newOpportunityKeys: [],
      message: `固定賽程資料讀取失敗：${(err as Error).message}`,
    };
  }

  const initial = selectWindowEvents(candidates, deps.now(), cfg);
  if (initial.length === 0) {
    const finishedAt = deps.now();
    return {
      ...base,
      result: "NO_WINDOW",
      finishedAt,
      runtimeMs: finishedAt - startedAt,
      selected: [],
      passes: 0,
      detailCalls: 0,
      newOpportunityKeys: [],
      message: `未來 ${cfg.windowMinutes} 分鐘內沒有即將開賽的場次，未進行任何賠率明細請求。`,
    };
  }

  let passes = 0;
  let detailCalls = 0;
  let alertKeys: string[] = [];
  const selectedById = new Map(
    initial.map((e) => [e.matchId, e] as const),
  );

  while (true) {
    try {
      candidates = await deps.loadCandidates();
    } catch {
      candidates = [...selectedById.values()];
    }
    const live = selectWindowEvents(candidates, deps.now(), cfg);
    for (const event of live) selectedById.set(event.matchId, event);
    if (live.length === 0) break;
    const pass = await deps.pollPass(live);
    passes++;
    detailCalls += pass.detailCalls;
    const betKeys = pass.newOpportunityKeys.filter((key) => key.startsWith("bet|"));
    if (betKeys.length) {
      alertKeys = betKeys;
      break; // stop immediately after a simulated bet is produced
    }
    await deps.sleep(cfg.intervalSec * 1000);
  }

  const finishedAt = deps.now();
  const selectedInfo = [...selectedById.values()].map((e) => ({
    matchId: e.matchId,
    matchLabel: e.matchLabel,
    minutesToKickoff: Math.round(e.minutesToKickoff * 10) / 10,
  }));
  return {
    ...base,
    result: alertKeys.length ? "ALERT" : "NO_ALERT",
    finishedAt,
    runtimeMs: finishedAt - startedAt,
    selected: selectedInfo,
    passes,
    detailCalls,
    newOpportunityKeys: alertKeys,
    message: alertKeys.length
      ? `已建立 ${alertKeys.length} 筆模擬注單，已即時停止掃描。`
      : `已連續密集掃描 ${selectedInfo.length} 場至開賽（${passes} 輪），沒有建立模擬注單。`,
  };
}
