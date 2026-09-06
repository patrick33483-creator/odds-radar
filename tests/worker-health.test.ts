import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  MILESTONE_HEARTBEAT_TIMEOUT_MS,
  milestoneHeartbeatExpired,
} from "../server/lib/worker-health";

describe("milestone worker health policy", () => {
  it("allows normal 30-second checkpoint cadence with headroom", () => {
    const lastCompletedAt = 1_000_000;
    expect(milestoneHeartbeatExpired(
      lastCompletedAt,
      lastCompletedAt + MILESTONE_HEARTBEAT_TIMEOUT_MS,
    )).toBe(false);
  });

  it("fails closed once the completion heartbeat exceeds the deadline", () => {
    const lastCompletedAt = 1_000_000;
    expect(milestoneHeartbeatExpired(
      lastCompletedAt,
      lastCompletedAt + MILESTONE_HEARTBEAT_TIMEOUT_MS + 1,
    )).toBe(true);
  });

  it("keeps the dedicated milestone scheduler referenced for the worker lifetime", () => {
    const routesSource = readFileSync(
      resolve(process.cwd(), "server/routes.ts"),
      "utf8",
    );
    const installer = routesSource.slice(
      routesSource.indexOf("function installResearchMilestoneCollection"),
      routesSource.indexOf("function installResearchLowerMilestoneCollection"),
    );
    expect(installer).not.toContain("researchMilestoneTimer.unref()");
    expect(installer).not.toContain("researchMilestoneStartupTimer.unref()");
  });

  it("requires a completed milestone tick in the production health gate", () => {
    const healthCheck = readFileSync(
      resolve(process.cwd(), "deploy/health-check.sh"),
      "utf8",
    );
    expect(healthCheck).toContain(
      'grep -q \'"event":"research_milestone"\'',
    );
    expect(healthCheck).toContain("Research milestone heartbeat stale");
    expect(healthCheck).toContain("Research milestone worker exited");
  });
});
