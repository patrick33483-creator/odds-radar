/**
 * Execution-grade quote checks.
 *
 * `fetchedAt` only proves when this server downloaded a payload. HKJC's
 * `sourceUpdatedAt` proves when the quoted pool itself was last updated. Both
 * must be current; otherwise an old price repeatedly returned by the upstream
 * endpoint can masquerade as a fresh executable quote.
 */

export const EXECUTION_QUOTE_MAX_AGE_MS = 30_000;
export const EXECUTION_CLOCK_TOLERANCE_MS = 5_000;

export interface ExecutionQuoteClock {
  fetchedAt: number;
  sourceUpdatedAt?: number | null;
}

export function isHkjcExecutionQuoteFresh(
  quote: ExecutionQuoteClock,
  now: number,
  maxAgeMs = EXECUTION_QUOTE_MAX_AGE_MS,
): boolean {
  const sourceUpdatedAt = quote.sourceUpdatedAt;
  if (sourceUpdatedAt === null || sourceUpdatedAt === undefined) return false;
  if (!Number.isFinite(quote.fetchedAt) || !Number.isFinite(sourceUpdatedAt)) return false;
  if (quote.fetchedAt > now + EXECUTION_CLOCK_TOLERANCE_MS) return false;
  if (sourceUpdatedAt > now + EXECUTION_CLOCK_TOLERANCE_MS) return false;
  if (now - quote.fetchedAt > maxAgeMs) return false;
  if (now - sourceUpdatedAt > maxAgeMs) return false;
  return true;
}

/** Only opportunities present before and after the independent HKJC re-fetch survive. */
export function confirmedOpportunityKeys(
  initialKeys: Iterable<string>,
  verifiedKeys: Iterable<string>,
): Set<string> {
  const verified = new Set(verifiedKeys);
  return new Set([...initialKeys].filter((key) => verified.has(key)));
}
