#!/usr/bin/env node
import { backfillOuSignalObservations, type OuSignalBackfillPair } from "../server/lib/ou-signals";
import { rawDb } from "../server/lib/store";

const REQUIRED_CONFIRMATION = "BACKFILL_CONFIRMED_T5_20260905";
if (process.env.OU_T5_BACKFILL_CONFIRMATION !== REQUIRED_CONFIRMATION) {
  throw new Error(`Refusing backfill without ${REQUIRED_CONFIRMATION}`);
}
if (process.env.RADAR_DB !== "/app/data/data.db") {
  throw new Error(`Refusing unexpected database path: ${process.env.RADAR_DB ?? "(unset)"}`);
}

const pairs = [
  ["hkjc:50074295", "pinnacle-ouu-t5-selected-180-190-over-watch"],
  ["hkjc:50074592", "pinnacle-ouu-t5-selected-180-190-over-watch"],
  ["hkjc:50074706", "pinnacle-ouu-t5-selected-180-190-over-watch"],
  ["hkjc:50075104", "hkjc-ooo-t5-selected-le-180-under-watch"],
  ["hkjc:50074704", "hkjc-ooo-t5-selected-le-180-under-watch"],
  ["hkjc:50074555", "pinnacle-ouu-t5-selected-180-190-over-watch"],
  ["crown:3012499", "pinnacle-ouu-t5-selected-180-190-over-watch"],
  ["hkjc:50074636", "pinnacle-ouu-t5-selected-180-190-over-watch"],
  ["hkjc:50075021", "hkjc-ooo-flat-wide-reverse"],
  ["hkjc:50074864", "hkjc-ooo-t5-selected-le-180-under-watch"],
  ["hkjc:50074840", "hkjc-ooo-t5-selected-le-180-under-watch"],
  ["hkjc:50074717", "hkjc-ooo-t5-selected-le-180-under-watch"],
] as const satisfies ReadonlyArray<readonly [string, string]>;

const approved: OuSignalBackfillPair[] = pairs.map(([matchId, ruleId]) => ({ matchId, ruleId }));
const pairWhere = pairs.map(() => "(match_id=? AND rule_id=?)").join(" OR ");
const pairParams = pairs.flatMap(([matchId, ruleId]) => [matchId, ruleId]);
const selectApproved = rawDb.prepare(
  `SELECT match_id,rule_id,backfilled_at,notified_at
     FROM ou_signal_observations
    WHERE ${pairWhere}
    ORDER BY match_id,rule_id`,
);

const before = selectApproved.all(...pairParams) as Array<{
  match_id: string;
  rule_id: string;
  backfilled_at: number | null;
  notified_at: number | null;
}>;
const existingSentBefore = before.filter((row) => row.notified_at !== null).length;
const existingBackfilledBefore = before.filter((row) => row.backfilled_at !== null).length;
const existingUnsentBefore = before.filter(
  (row) => row.notified_at === null && row.backfilled_at === null,
).length;
const existingSentPairs = before
  .filter((row) => row.notified_at !== null)
  .map((row) => `${row.match_id}|${row.rule_id}`);
const adoptedUnsentPairs = before
  .filter((row) => row.notified_at === null && row.backfilled_at === null)
  .map((row) => `${row.match_id}|${row.rule_id}`);

const backfilledAt = Date.now();
const inserted = backfillOuSignalObservations(approved, backfilledAt);
const after = selectApproved.all(...pairParams) as typeof before;
const actualPairs = new Set(after.map((row) => `${row.match_id}|${row.rule_id}`));
const missing = pairs
  .map(([matchId, ruleId]) => `${matchId}|${ruleId}`)
  .filter((key) => !actualPairs.has(key));
if (missing.length > 0 || after.length !== pairs.length) {
  throw new Error(`Backfill verification failed; missing=${missing.join(",") || "none"} total=${after.length}`);
}
if (after.some((row) => row.backfilled_at === null && row.notified_at === null)) {
  throw new Error("Backfill verification failed; an approved row remains pending");
}

const pending = rawDb.prepare(
  `SELECT COUNT(*) AS count
     FROM ou_signal_observations
    WHERE (${pairWhere})
      AND notified_at IS NULL
      AND backfilled_at IS NULL`,
).get(...pairParams) as { count: number };
if (pending.count !== 0) {
  throw new Error(`Backfill verification failed; ${pending.count} approved rows entered the Telegram queue`);
}

const counts = rawDb.prepare(
  `SELECT rule_id,COUNT(*) AS count
     FROM ou_signal_observations
    WHERE ${pairWhere}
    GROUP BY rule_id
    ORDER BY rule_id`,
).all(...pairParams);
const expectedCounts = new Map([
  ["pinnacle-ouu-t5-selected-180-190-over-watch", 6],
  ["hkjc-ooo-t5-selected-le-180-under-watch", 5],
  ["hkjc-ooo-flat-wide-reverse", 1],
]);
for (const row of counts as Array<{ rule_id: string; count: number }>) {
  if (expectedCounts.get(row.rule_id) !== row.count) {
    throw new Error(`Backfill count mismatch for ${row.rule_id}: ${row.count}`);
  }
  expectedCounts.delete(row.rule_id);
}
if (expectedCounts.size > 0) {
  throw new Error(`Backfill count verification missing rules: ${[...expectedCounts.keys()].join(",")}`);
}

console.log(JSON.stringify({
  batch: "confirmed-t5-20260905",
  requested: pairs.length,
  existingBefore: before.length,
  existingSentBefore,
  existingBackfilledBefore,
  existingUnsentBefore,
  existingSentPairs,
  inserted,
  adoptedUnsent: existingUnsentBefore,
  adoptedUnsentPairs,
  totalAfter: after.length,
  telegramPending: pending.count,
  counts,
}, null, 2));
rawDb.close();
