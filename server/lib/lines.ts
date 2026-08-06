/**
 * Line normalization.
 *
 * Internal convention (single source of truth):
 *  - Asian handicap is stored as `homeHandicap`: the goal adjustment applied to the
 *    HOME team. Negative = home gives (主讓). Positive = home receives (受讓).
 *    HKJC's `HDC.condition` already uses this convention ("0.0/-0.5" => -0.25).
 *    titan007/Pinnacle's `goals` attribute uses the OPPOSITE sign (positive = home
 *    gives), so Pinnacle values must be negated on ingest.
 *  - Totals are stored as a positive `total`.
 *  - Both are snapped to quarter (0.25) increments. Anything that does not land on
 *    a quarter increment is rejected rather than silently rounded away.
 *  - Home/away direction is NEVER flipped after ingest.
 */

export const QUARTER = 0.25;

export function isQuarterStep(v: number): boolean {
  return Number.isFinite(v) && Math.abs(v * 4 - Math.round(v * 4)) < 1e-9;
}

export function snapToQuarter(v: number): number {
  return Math.round(v * 4) / 4;
}

/** Parse an HKJC HDC condition string into a normalized home handicap. */
export function parseHkjcHandicap(condition: string): number | null {
  if (!condition) return null;
  const parts = condition
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = Number(p.replace(/^\+/, ""));
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  // "0.0/+0.5" and "0.0/-0.5": the pair is the two halves of a quarter line.
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (nums.length === 2 && Math.abs(Math.abs(nums[0] - nums[1]) - 0.5) > 1e-9) return null;
  const snapped = snapToQuarter(avg);
  if (!isQuarterStep(snapped) || Math.abs(snapped - avg) > 1e-9) return null;
  return snapped;
}

/** Parse an HKJC HIL condition string into a normalized total. */
export function parseHkjcTotal(condition: string): number | null {
  if (!condition) return null;
  const parts = condition
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  if (nums.length === 2 && Math.abs(Math.abs(nums[0] - nums[1]) - 0.5) > 1e-9) return null;
  const snapped = snapToQuarter(avg);
  if (Math.abs(snapped - avg) > 1e-9) return null;
  return snapped;
}

/**
 * Pinnacle/titan007 `goals` attribute -> normalized home handicap.
 * titan007: positive = home gives. Ours: negative = home gives.
 */
export function parsePinnacleHandicap(goals: string | number): number | null {
  const n = typeof goals === "number" ? goals : Number(String(goals).trim());
  if (!Number.isFinite(n)) return null;
  const v = snapToQuarter(-n) || 0; // normalize -0 to 0
  if (!isQuarterStep(v) || Math.abs(v + n) > 1e-9) return null;
  return v;
}

export function parsePinnacleTotal(goals: string | number): number | null {
  const n = typeof goals === "number" ? goals : Number(String(goals).trim());
  if (!Number.isFinite(n) || n < 0) return null;
  const v = snapToQuarter(n);
  if (Math.abs(v - n) > 1e-9) return null;
  return v;
}

/** Canonical, comparison-safe key for a normalized line. */
export function lineKeyOf(market: "1X2" | "AH" | "OU", value: number | null): string {
  if (market === "1X2") return "";
  if (value === null || !Number.isFinite(value)) return "";
  return value.toFixed(2);
}

function fmt(n: number): string {
  const s = n.toFixed(2).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

/** Human display for a handicap, e.g. -0.25 -> "0/-0.5", -0.75 -> "-0.5/-1". */
export function formatHandicap(h: number): string {
  if (!isQuarterStep(h)) return String(h);
  const isHalfStep = Math.abs(h * 2 - Math.round(h * 2)) < 1e-9;
  if (isHalfStep) return h > 0 ? `+${fmt(h)}` : fmt(h);
  const lo = h - QUARTER;
  const hi = h + QUARTER;
  // Keep the "closer to zero first" reading used by HK books: 0/-0.5, -0.5/-1
  const [a, b] = h < 0 ? [hi, lo] : [lo, hi];
  const p = (v: number) => (v > 0 ? `+${fmt(v)}` : fmt(v));
  return `${p(a)}/${p(b)}`;
}

/** Human display for a total, e.g. 2.75 -> "2.5/3". */
export function formatTotal(t: number): string {
  if (!isQuarterStep(t)) return String(t);
  const isHalfStep = Math.abs(t * 2 - Math.round(t * 2)) < 1e-9;
  if (isHalfStep) return fmt(t);
  return `${fmt(t - QUARTER)}/${fmt(t + QUARTER)}`;
}

export function formatLine(market: "1X2" | "AH" | "OU", value: number | null): string {
  if (market === "1X2" || value === null) return "—";
  return market === "AH" ? formatHandicap(value) : formatTotal(value);
}

/** Split a quarter line into its two half-lines. Non-quarter lines return one. */
export function splitLine(value: number): number[] {
  const isHalfStep = Math.abs(value * 2 - Math.round(value * 2)) < 1e-9;
  if (isHalfStep) return [value];
  return [value - QUARTER, value + QUARTER];
}

/** Hong Kong odds -> decimal odds. */
export function hkToDecimal(hk: number): number {
  return Math.round((hk + 1) * 1000) / 1000;
}
