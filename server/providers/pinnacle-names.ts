/**
 * Robust Pinnacle (平博) bookmaker-row identification.
 *
 * titan007 / 球探網 MASKS bookmaker names in its odds tables ("平*", "Crow*",
 * "Interwet*"), so a row can only be identified by a *prefix* of its real name.
 * We therefore normalize the visible label and test it against a Pinnacle alias
 * list instead of hard-coding a numeric company id. A numeric id is only ever
 * used as a last-resort hint (PINNACLE_TITAN_COMPANY_ID, observed as 47 on
 * 2026-08-07), and the historical Crown id (3) is explicitly BLOCKED so Crown
 * prices can never be substituted for Pinnacle prices.
 */

/** Every spelling of Pinnacle we accept, already normalized. */
export const PINNACLE_ALIASES = [
  "pinnacle",
  "pinnaclesports",
  "pinnacle体育",
  "平博",
  "平博体育",
  "平博體育",
  "平臣",
] as const;

/** Company ids that must never be treated as Pinnacle (Crown / 皇冠 and Macau). */
export const BLOCKED_COMPANY_IDS = new Set(["3", "1", "545", "80"]);

/** Lowercase, drop the truncation marker, full-width punctuation and spaces. */
export function normalizeBookmakerName(raw: string): string {
  return raw
    .replace(/&nbsp;/g, " ")
    .replace(/\s*封\s*$/g, "") // Titan appends 封 after the masking star when closed
    .replace(/[\uFF0A*]+$/g, "") // trailing masking star (half or full width)
    .replace(/[\s\u3000._-]+/g, "")
    .toLowerCase()
    .trim();
}

/** True when `raw` is (a prefix of) a Pinnacle alias. */
export function isPinnacleName(raw: string): boolean {
  const masked = /[\uFF0A*](?:\s*封)?\s*$/.test(raw);
  const n = normalizeBookmakerName(raw);
  if (!n) return false;
  if (PINNACLE_ALIASES.some((a) => a === n)) return true;
  // Masked labels only expose a prefix, e.g. "平*" for 平博.
  if (masked) return PINNACLE_ALIASES.some((a) => a.startsWith(n));
  return false;
}

export interface BookmakerRow {
  companyId: string;
  rawName: string;
  html: string;
}

export interface RowSelection {
  row: BookmakerRow;
  matchedBy: "name" | "id-hint";
}

/** Numeric hint used only when no visible label matches. */
export function idHint(): string {
  return process.env.PINNACLE_TITAN_COMPANY_ID ?? "47";
}

/**
 * Choose the Pinnacle row. Name match wins; a same-prefix tie is broken by the
 * configured id hint; ambiguity without a hint match returns null (the caller
 * then reports degraded status rather than guessing).
 */
export function selectPinnacleRow(rows: BookmakerRow[]): RowSelection | null {
  const usable = rows.filter((r) => !BLOCKED_COMPANY_IDS.has(r.companyId));
  const byName = usable.filter((r) => isPinnacleName(r.rawName));
  if (byName.length === 1) return { row: byName[0], matchedBy: "name" };
  if (byName.length > 1) {
    const hinted = byName.find((r) => r.companyId === idHint());
    return hinted ? { row: hinted, matchedBy: "name" } : null;
  }
  const hinted = usable.find((r) => r.companyId === idHint());
  return hinted ? { row: hinted, matchedBy: "id-hint" } : null;
}
