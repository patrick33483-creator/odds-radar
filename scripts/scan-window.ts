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
 *     RADAR_SCAN_INTERVAL_SEC, default 30 s) until their kickoff. It stops
 *     early only when a simulated bet is created (result ALERT).
 *   - RADAR_SIM_TARGET=30 (or any positive cap) makes a run at the completed
 *     total return TARGET_REACHED without any fixture or price request.
 *
 * Exit codes: 0 = NO_WINDOW / NO_ALERT / TARGET_REACHED, 10 = ALERT, 1 = ERROR.
 * This CLI creates no external schedule.
 */
import "dotenv/config";
import { engine } from "../server/lib/engine";

const outcome = await engine.runScan();
console.log(JSON.stringify(outcome, null, 2));
process.exit(outcome.result === "ALERT" ? 10 : outcome.result === "ERROR" ? 1 : 0);
