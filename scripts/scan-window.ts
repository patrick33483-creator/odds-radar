/**
 * CLI: one dense pre-kickoff window scan (盤路雷達).
 *
 *   npm run scan            # or: tsx scripts/scan-window.ts
 *
 * Behaviour
 *   - Fetches lightweight fixtures/mapping, then selects ONLY pre-match events
 *     with 0 < minutes_to_kickoff <= RADAR_SCAN_WINDOW_MIN (default 30).
 *   - No match in window -> prints {"result":"NO_WINDOW"} and exits at once,
 *     having made ZERO per-match Pinnacle detail requests.
 *   - Otherwise polls those events densely in-process (interval
 *     RADAR_SCAN_INTERVAL_SEC, default 30 s) and stops the moment a new
 *     arbitrage appears (result ALERT). Total runtime is bounded by
 *     RADAR_SCAN_MAX_RUNTIME_SEC (default 240 s, hard ceiling < 300 s).
 *
 * Exit codes: 0 = NO_WINDOW / NO_ALERT, 10 = ALERT, 1 = ERROR.
 * NO SCHEDULE IS CREATED — attach this to a scheduler only when the desired
 * frequency has been decided.
 */
import "dotenv/config";
import { engine } from "../server/lib/engine";

const outcome = await engine.runScan();
console.log(JSON.stringify(outcome, null, 2));
process.exit(outcome.result === "ALERT" ? 10 : outcome.result === "ERROR" ? 1 : 0);
