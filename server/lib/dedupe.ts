/**
 * Opportunity dedupe state.
 *
 * A narrow-window scan must NEVER overwrite the whole state — that was the bug
 * that caused duplicate alerts in the previous build. State is MERGED: existing
 * entries keep their `firstSeen`, newly seen entries are inserted, and entries
 * are only dropped once they have not been seen for 7 days.
 */

export const DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DedupeEntry {
  key: string;
  firstSeen: number;
  lastSeen: number;
  notified: boolean;
  metric: number;
  payload?: string;
}

export interface MergeResult {
  state: Map<string, DedupeEntry>;
  fresh: DedupeEntry[]; // entries seen for the first time in this scan
  expired: string[];
}

export function mergeOpportunityState(
  existing: Iterable<DedupeEntry>,
  seen: Array<{ key: string; metric: number; payload?: string }>,
  now: number,
  ttlMs = DEDUPE_TTL_MS,
): MergeResult {
  const state = new Map<string, DedupeEntry>();
  for (const e of existing) state.set(e.key, { ...e });

  const fresh: DedupeEntry[] = [];
  for (const s of seen) {
    const prev = state.get(s.key);
    if (prev) {
      prev.lastSeen = now;
      prev.metric = s.metric;
      if (s.payload !== undefined) prev.payload = s.payload;
    } else {
      const entry: DedupeEntry = {
        key: s.key,
        firstSeen: now,
        lastSeen: now,
        notified: false,
        metric: s.metric,
        payload: s.payload,
      };
      state.set(s.key, entry);
      fresh.push(entry);
    }
  }

  const expired: string[] = [];
  for (const [key, e] of state) {
    if (now - e.lastSeen > ttlMs) {
      expired.push(key);
      state.delete(key);
    }
  }
  return { state, fresh, expired };
}
