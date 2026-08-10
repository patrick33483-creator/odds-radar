/**
 * Fail-closed Crown execution policy.
 *
 * Historical Crown rows may remain available for prediction/observation, but
 * they are never executable. A match is execution-enabled only after a recent
 * non-empty Crown fetch for that exact match.
 */

export const CROWN_EXECUTION_OBSERVATION_MAX_AGE_MS = 45_000;

export interface CrownFeedObservation {
  observedAt: number;
  available: boolean;
  rowCount: number;
}

export interface CrownExecutionPolicy {
  phase: "pre_t10" | "t10_or_later";
  mode: "live" | "prediction_only";
  executionEnabled: boolean;
  predictionFallbackAllowed: boolean;
  reason:
    | "live_crown_snapshot"
    | "no_crown_observation"
    | "empty_crown_snapshot"
    | "stale_crown_observation";
}

export function crownExecutionPolicy(input: {
  now: number;
  kickoffUtc: number;
  observation?: CrownFeedObservation | null;
  hasHistoricalCrownRows: boolean;
  maxObservationAgeMs?: number;
}): CrownExecutionPolicy {
  const phase = input.kickoffUtc - input.now > 10 * 60_000 ? "pre_t10" : "t10_or_later";
  const maxAge = input.maxObservationAgeMs ?? CROWN_EXECUTION_OBSERVATION_MAX_AGE_MS;
  const observation = input.observation;

  if (!observation) {
    return {
      phase,
      mode: "prediction_only",
      executionEnabled: false,
      predictionFallbackAllowed: input.hasHistoricalCrownRows,
      reason: "no_crown_observation",
    };
  }
  if (!observation.available || observation.rowCount <= 0) {
    return {
      phase,
      mode: "prediction_only",
      executionEnabled: false,
      predictionFallbackAllowed: input.hasHistoricalCrownRows,
      reason: "empty_crown_snapshot",
    };
  }
  if (
    !Number.isFinite(observation.observedAt)
    || observation.observedAt > input.now
    || input.now - observation.observedAt > maxAge
  ) {
    return {
      phase,
      mode: "prediction_only",
      executionEnabled: false,
      predictionFallbackAllowed: input.hasHistoricalCrownRows,
      reason: "stale_crown_observation",
    };
  }
  return {
    phase,
    mode: "live",
    executionEnabled: true,
    predictionFallbackAllowed: false,
    reason: "live_crown_snapshot",
  };
}

export interface CrownExecutionSignals<TArb, TEv, TSynthetic> {
  arbs: TArb[];
  ev: TEv[];
  synthetics: TSynthetic[];
}

/**
 * Final defence-in-depth sanitizer. Calculation sites also skip work while the
 * policy is closed; this prevents any accidentally retained signal from
 * reaching opportunity state, simulated orders, or Telegram.
 */
export function enforceCrownExecutionGate<TArb, TEv, TSynthetic>(
  policy: CrownExecutionPolicy,
  signals: CrownExecutionSignals<TArb, TEv, TSynthetic>,
): CrownExecutionSignals<TArb, TEv, TSynthetic> {
  if (policy.executionEnabled) return signals;
  return { arbs: [], ev: [], synthetics: [] };
}
