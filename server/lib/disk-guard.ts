/**
 * Disk pressure watchdog for the database volume.
 *
 * On 2026-09-05 the droplet's root filesystem reached 100% with 892K free. A
 * full disk makes SQLite writes fail with SQLITE_FULL, so odds snapshots are
 * lost while the dashboard only shows the affected checkpoints as missing —
 * indistinguishable from a collector or upstream problem. Nothing alerted; the
 * condition was only found by hand days later.
 *
 * This module measures free space on the volume holding the database and
 * reports a level. Escalations alert immediately, a sustained bad level
 * re-alerts at most once per REPEAT_MS, and recovery is reported once.
 */

import { statfsSync } from "node:fs";
import path from "node:path";

export type DiskLevel = "ok" | "warn" | "critical";

/** Alert when free space drops below this share of the volume. */
export const WARN_FREE_RATIO = 0.15;
/** Escalate when free space drops below this share of the volume. */
export const CRITICAL_FREE_RATIO = 0.07;
/** Only report recovery once free space is comfortably back, to avoid flapping. */
export const RECOVER_FREE_RATIO = 0.2;
/** Minimum gap between repeat alerts for an unchanged bad level. */
export const REPEAT_MS = 6 * 60 * 60_000;

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
}

export interface DiskAlertState {
  level: DiskLevel;
  at: number;
}

export interface DiskCheckOutcome {
  level: DiskLevel;
  freeBytes: number;
  totalBytes: number;
  freeRatio: number;
  shouldAlert: boolean;
  message: string | null;
}

export function readDiskUsage(target: string): DiskUsage {
  const stats = statfsSync(target);
  const blockSize = Number(stats.bsize);
  return {
    totalBytes: Number(stats.blocks) * blockSize,
    // bavail is what an unprivileged writer can actually use, which is what
    // the database process is bound by.
    freeBytes: Number(stats.bavail) * blockSize,
  };
}

export function diskTarget(dbPath: string): string {
  return path.dirname(path.resolve(dbPath));
}

export function classify(usage: DiskUsage): { level: DiskLevel; freeRatio: number } {
  if (!usage.totalBytes) return { level: "ok", freeRatio: 1 };
  const freeRatio = usage.freeBytes / usage.totalBytes;
  if (freeRatio < CRITICAL_FREE_RATIO) return { level: "critical", freeRatio };
  if (freeRatio < WARN_FREE_RATIO) return { level: "warn", freeRatio };
  return { level: "ok", freeRatio };
}

const SEVERITY: Record<DiskLevel, number> = { ok: 0, warn: 1, critical: 2 };

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}

/**
 * Decide whether this reading deserves an alert, given the last reported one.
 * Pure so the escalation and throttling rules are testable without a disk.
 */
export function evaluateDisk(
  usage: DiskUsage,
  previous: DiskAlertState | null,
  now: number,
): DiskCheckOutcome {
  const { level, freeRatio } = classify(usage);
  const base = {
    level,
    freeBytes: usage.freeBytes,
    totalBytes: usage.totalBytes,
    freeRatio,
  };
  const pct = (freeRatio * 100).toFixed(1);
  const size = `${formatGb(usage.freeBytes)} / ${formatGb(usage.totalBytes)}`;
  const previousLevel = previous?.level ?? "ok";

  if (level === "ok") {
    // Only announce recovery once, and only with real headroom back.
    if (previousLevel !== "ok" && freeRatio >= RECOVER_FREE_RATIO) {
      return {
        ...base,
        shouldAlert: true,
        message: [
          "磁碟空間已回復",
          `可用：${size}（${pct}%）`,
          "資料庫寫入風險解除。",
        ].join("\n"),
      };
    }
    return { ...base, shouldAlert: false, message: null };
  }

  const escalated = SEVERITY[level] > SEVERITY[previousLevel];
  const stale = previous ? now - previous.at >= REPEAT_MS : true;
  if (!escalated && !stale) return { ...base, shouldAlert: false, message: null };

  const head = level === "critical" ? "磁碟空間嚴重不足" : "磁碟空間偏低";
  const tail =
    level === "critical"
      ? "磁碟滿之後 SQLite 寫入會直接失敗，賠率快照會靜靜咁掉，dashboard 只會顯示缺失。請即刻清理備份或擴容。"
      : "請清理舊備份或擴容，唔好等到寫入失敗才處理。";
  return {
    ...base,
    shouldAlert: true,
    message: [head, `可用：${size}（${pct}%）`, tail].join("\n"),
  };
}

export interface DiskGuardDeps {
  usage: () => DiskUsage;
  readState: () => DiskAlertState | null;
  writeState: (state: DiskAlertState) => void;
  send: (text: string) => Promise<unknown>;
  now?: () => number;
}

/**
 * Run one check and alert if warranted. The alert state only advances after a
 * successful send, so a Telegram outage does not silently swallow the warning.
 */
export async function runDiskCheck(deps: DiskGuardDeps): Promise<DiskCheckOutcome> {
  const now = deps.now?.() ?? Date.now();
  const outcome = evaluateDisk(deps.usage(), deps.readState(), now);
  if (!outcome.shouldAlert || !outcome.message) return outcome;
  await deps.send(outcome.message);
  deps.writeState({ level: outcome.level, at: now });
  return outcome;
}

export const DISK_ALERT_STATE_KEY = "disk_alert_state";

export function parseDiskAlertState(raw: string | null): DiskAlertState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DiskAlertState>;
    if (parsed.level !== "ok" && parsed.level !== "warn" && parsed.level !== "critical") return null;
    if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) return null;
    return { level: parsed.level, at: parsed.at };
  } catch {
    return null;
  }
}
