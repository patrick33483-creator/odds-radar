/**
 * 開賽前 30 分鐘密集掃描 — the ONLY automated scanning path.
 *
 * Policy (replaces the old all-match polling loop):
 *   - When triggered, fetch LIGHTWEIGHT fixture/mapping data only (HKJC's single
 *     pre-match GraphQL call + the cached titan007 fixture list).
 *   - Select ONLY pre-match events with 0 < minutes_to_kickoff <= window
 *     (default 30). Already-started / in-play / finished events are excluded.
 *   - If nothing is in the window: return NO_WINDOW immediately and make ZERO
 *     per-match Pinnacle detail calls.
 *   - Otherwise poll just those events densely, in-process, reusing the fixture
 *     and mapping data, and stop the moment a new arbitrage appears (ALERT).
 *   - Total runtime is bounded well below 300 s.
 *
 * NO SCHEDULE IS CREATED ANYWHERE IN THIS CODEBASE. The real frequency is still
 * undecided; the interval and total runtime are env-configurable so a scheduler
 * can be attached later:
 *
 *   RADAR_SCAN_WINDOW_MIN        default 30   (clamped 1..30)
 *   RADAR_SCAN_INTERVAL_SEC      default 30   (clamped 5..120)
 *   RADAR_SCAN_MAX_RUNTIME_SEC   default 240  (clamped 30..290, hard < 300)
 */

import type { ScanOutcome } from "@shared/types";

export const SCAN_HARD_LIMIT_SEC = 300;

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

/** Env-driven config, always bounded so a run can never approach 300 s. */
export function scanConfig(env: NodeJS.ProcessEnv = process.env): ScanConfig {
  const windowMinutes = clamp(Math.round(num(env.RADAR_SCAN_WINDOW_MIN, 30)), 1, 30);
  const intervalSec = clamp(Math.round(num(env.RADAR_SCAN_INTERVAL_SEC, 30)), 5, 120);
  const maxRuntimeSec = clamp(Math.round(num(env.RADAR_SCAN_MAX_RUNTIME_SEC, 240)), 30, SCAN_HARD_LIMIT_SEC - 10);
  return { windowMinutes, intervalSec, maxRuntimeSec };
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

export interface ScanDeps {
  now(): number;
  /** Lightweight fixtures + mapping. MUST NOT make per-match odds detail calls. */
  loadCandidates(): Promise<ScanCandidate[]>;
  /** One dense pass over the selected events. Returns detail-call count + new arb keys. */
  pollPass(events: ScanCandidate[]): Promise<{ detailCalls: number; newOpportunityKeys: string[] }>;
  sleep(ms: number): Promise<void>;
  config: ScanConfig;
}

/**
 * Run one bounded dense-scan session. Never scans outside the window and never
 * touches per-match detail endpoints when the window is empty.
 */
export async function runWindowScan(deps: ScanDeps): Promise<ScanOutcome> {
  const cfg = deps.config;
  const startedAt = deps.now();
  const deadline = startedAt + cfg.maxRuntimeSec * 1000;
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

  const selected = selectWindowEvents(candidates, deps.now(), cfg);
  if (selected.length === 0) {
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

  while (deps.now() < deadline) {
    // Drop anything that kicked off during the session.
    const live = selected.filter((e) => e.kickoffUtc - deps.now() > 0);
    if (live.length === 0) break;
    const pass = await deps.pollPass(live);
    passes++;
    detailCalls += pass.detailCalls;
    if (pass.newOpportunityKeys.length) {
      alertKeys = pass.newOpportunityKeys;
      break; // stop immediately on a new arb
    }
    const remaining = deadline - deps.now();
    if (remaining <= cfg.intervalSec * 1000) break;
    await deps.sleep(cfg.intervalSec * 1000);
  }

  const finishedAt = deps.now();
  const selectedInfo = selected.map((e) => ({
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
      ? `發現 ${alertKeys.length} 個新機會，已即時停止掃描。`
      : `已密集掃描 ${selectedInfo.length} 場（${passes} 輪），未發現新機會。`,
  };
}
