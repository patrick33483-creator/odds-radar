/**
 * Consistent, timestamped SQLite backups under backups/, retaining the newest 3.
 * Uses the SQLite online backup API (via VACUUM INTO) so the copy is consistent
 * even while WAL writes are in flight. No schedule is created here.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { readDiskUsage } from "./disk-guard";
import path from "node:path";
import { rawDb } from "./store";

export const BACKUP_DIR = process.env.RADAR_BACKUP_DIR ?? "backups";
// The database passed 4.5G while each copy is a full-size VACUUM INTO, so a
// deep retention window is what fills the disk rather than what protects it.
export const RETAIN = 3;
/** Refuse to write a copy unless the volume can hold it with room to spare. */
export const FREE_SPACE_HEADROOM = 1.3;

export interface BackupInfo {
  file: string;
  sizeBytes: number;
  createdAt: number;
}

export function createBackup(now = new Date()): BackupInfo {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  assertSpaceForBackup();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const file = path.join(BACKUP_DIR, `data-${stamp}.db`);
  rawDb.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  rawDb.prepare(`VACUUM INTO ?`).run(file);
  pruneBackups();
  const st = statSync(file);
  return { file, sizeBytes: st.size, createdAt: st.mtimeMs };
}

export function listBackups(): BackupInfo[] {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("data-") && f.endsWith(".db"))
    .map((f) => {
      const p = path.join(BACKUP_DIR, f);
      const st = statSync(p);
      return { file: p, sizeBytes: st.size, createdAt: st.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function pruneBackups(retain = RETAIN): string[] {
  const all = listBackups();
  const drop = all.slice(retain);
  for (const b of drop) rmSync(b.file, { force: true });
  return drop.map((b) => b.file);
}

/**
 * A VACUUM INTO of a multi-gigabyte database on a nearly full volume is how the
 * disk gets pushed to 100%, which then breaks live writes. Fail the backup
 * instead, before anything is written.
 */
export function assertSpaceForBackup(): void {
  const dbPath = process.env.RADAR_DB;
  if (!dbPath || !existsSync(dbPath)) return;
  const required = statSync(dbPath).size * FREE_SPACE_HEADROOM;
  const { freeBytes } = readDiskUsage(BACKUP_DIR);
  if (freeBytes < required) {
    const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)}G`;
    throw new Error(
      `Refusing to back up: needs about ${gb(required)} free but only ${gb(freeBytes)} available on ${BACKUP_DIR}`,
    );
  }
}
