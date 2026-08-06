/**
 * Consistent, timestamped SQLite backups under backups/, retaining the newest 14.
 * Uses the SQLite online backup API (via VACUUM INTO) so the copy is consistent
 * even while WAL writes are in flight. No schedule is created here.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { rawDb } from "./store";

export const BACKUP_DIR = process.env.RADAR_BACKUP_DIR ?? "backups";
export const RETAIN = 14;

export interface BackupInfo {
  file: string;
  sizeBytes: number;
  createdAt: number;
}

export function createBackup(now = new Date()): BackupInfo {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
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
