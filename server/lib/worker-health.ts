export const MILESTONE_HEARTBEAT_TIMEOUT_MS = 120_000;

export function milestoneHeartbeatExpired(
  lastCompletedAt: number,
  now: number,
  timeoutMs = MILESTONE_HEARTBEAT_TIMEOUT_MS,
): boolean {
  return now - lastCompletedAt > timeoutMs;
}
