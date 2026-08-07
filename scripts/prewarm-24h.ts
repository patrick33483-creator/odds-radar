/**
 * Hourly data pre-warm.
 *
 * Refreshes HKJC prices, Pinnacle fixture mapping and Pinnacle odds detail for
 * mapped events starting within the next 24 hours. This path never calls the
 * simulation purchase routine; simulated bets remain exclusive to the manual
 * dense scan in the final 30 minutes.
 */
import "dotenv/config";
import { engine } from "../server/lib/engine";

const result = await engine.refresh({ force: true, mode: "prewarm24h" });
const status = engine.buildDashboardData().status;

console.log(
  JSON.stringify(
    {
      ...result,
      matches: status.counts.matches,
      matched: status.counts.matched,
      pinnacleFixtures: status.providers.find((p) => p.provider === "pinnacle")?.itemCount ?? 0,
      refreshedAt: status.lastRefreshAt,
    },
    null,
    2,
  ),
);
