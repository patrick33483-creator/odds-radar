/**
 * Look up Chinese `home_team` / `away_team` / `league` strings for a Pinnacle-only
 * fixture (`fixture_source='pinnacle'`), whose PinnAPI feed only carries English
 * labels.  The result is persisted into `pinnacle_translations` and joined into
 * the research UI at read time; the underlying `matches` row is never rewritten.
 *
 * Sources are tried in order and the first non-empty match wins:
 *   1. titan007 schedule pages (Chinese by default; matched by kickoff time and
 *      fuzzy team-name comparison against normalised English strings).
 *   2. OpticOdds `/fixtures/active` (may carry a locale-tagged Chinese label; we
 *      currently only ever return English so this path tolerates full-null
 *      output but still records the attempt).
 *   3. Wikidata entity search + Traditional-Chinese labels, only when the first
 *      two sources return no Chinese field.
 *
 * If neither source resolves the fixture, the caller is expected to invoke
 * `markPinnacleTranslationAttempt` so retry backoff can suppress the next
 * scheduling tick.  Failures never propagate through the caller — this whole
 * module is a best-effort side effect.
 */

import type { PinnacleProvider, PinnacleFixture } from "../providers/pinnacle";
import type { OpticOddsProvider } from "../providers/opticodds";
import {
  WikidataLookupBudgetExhaustedError,
  type WikidataEntityLookup,
} from "./wikidataTranslation";

export interface TranslationResult {
  pinnapiId: string;
  zhHome: string | null;
  zhAway: string | null;
  zhLeague: string | null;
  source: "titan" | "optic" | "wikidata";
}

export interface TranslationInput {
  pinnapiId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  kickoffUtc: number;
}

export interface TranslationDeps {
  pinnacle: Pick<PinnacleProvider, "fetchTitanResearchFixtures">;
  /** Reuse one schedule fetch for a whole batch instead of five pages per fixture. */
  titanFixtures?: readonly PinnacleFixture[];
  optic?: { fetchFixtures: OpticOddsProvider["fetchFixtures"] };
  wikidata?: WikidataEntityLookup;
}

const KICKOFF_TOLERANCE_MS = 30 * 60_000;
const JARO_WINKLER_THRESHOLD = 0.8;

/** Lowercase and drop everything except letters/digits/CJK for name comparison. */
export function normaliseName(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Standard Jaro-Winkler distance in [0, 1]. Implemented locally so the service
 * has no runtime dependency, and can be unit-tested in isolation.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  if (!a.length || !b.length) return 0;
  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(b.length - 1, i + matchWindow);
    for (let j = lo; j <= hi; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  // Winkler prefix boost up to 4 characters.
  let prefix = 0;
  const prefixLimit = Math.min(4, a.length, b.length);
  while (prefix < prefixLimit && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function containsCjk(value: string | null | undefined): boolean {
  if (!value) return false;
  return /[\u3400-\u9fff]/.test(value);
}

interface FuzzyCandidate {
  homeTeam: string;
  awayTeam: string;
  league?: string;
  kickoffUtc: number;
}

/**
 * Match `target` against candidates by kickoff proximity and Jaro-Winkler score
 * on normalised home+away names. Returns the candidate that scores highest with
 * both team scores at or above the 0.8 threshold, or null.
 */
export function findFuzzyMatch<T extends FuzzyCandidate>(
  target: TranslationInput,
  candidates: readonly T[],
): T | null {
  const targetHome = normaliseName(target.homeTeam);
  const targetAway = normaliseName(target.awayTeam);
  if (!targetHome || !targetAway) return null;
  let best: { candidate: T; score: number } | null = null;
  for (const candidate of candidates) {
    if (Math.abs(candidate.kickoffUtc - target.kickoffUtc) > KICKOFF_TOLERANCE_MS) continue;
    const candHome = normaliseName(candidate.homeTeam);
    const candAway = normaliseName(candidate.awayTeam);
    if (!candHome || !candAway) continue;
    const homeScore = jaroWinkler(targetHome, candHome);
    const awayScore = jaroWinkler(targetAway, candAway);
    if (homeScore < JARO_WINKLER_THRESHOLD || awayScore < JARO_WINKLER_THRESHOLD) continue;
    const combined = homeScore + awayScore;
    if (!best || combined > best.score) best = { candidate, score: combined };
  }
  return best?.candidate ?? null;
}

/**
 * Try titan007, then OpticOdds, then Wikidata. Return null when none yields at
 * least one non-empty Chinese field. The caller records the attempt separately so a
 * successful fetch that only carries `zh_league` still short-circuits future
 * retries once the row exists.
 */
export async function translatePinnacleFixture(
  fixture: TranslationInput,
  deps: TranslationDeps,
): Promise<TranslationResult | null> {
  // titan007's Next_/Over_ schedule pages are Chinese by default. The provider
  // already re-uses the caller-side rate limiter.
  try {
    const titan = deps.titanFixtures
      ?? await deps.pinnacle.fetchTitanResearchFixtures([0, 1, 2, 3, 4]);
    const candidate = findFuzzyMatch(fixture, titan);
    if (candidate) {
      const zhHome = containsCjk(candidate.homeTeam) ? candidate.homeTeam : null;
      const zhAway = containsCjk(candidate.awayTeam) ? candidate.awayTeam : null;
      const zhLeague = containsCjk(candidate.league) ? candidate.league : null;
      if (zhHome || zhAway || zhLeague) {
        return {
          pinnapiId: fixture.pinnapiId,
          zhHome,
          zhAway,
          zhLeague,
          source: "titan",
        };
      }
    }
  } catch {
    // titan is best-effort. Fall through to OpticOdds.
  }

  if (deps.optic) {
    try {
      const opticFixtures = await deps.optic.fetchFixtures();
      const candidate = findFuzzyMatch(fixture, opticFixtures);
      if (candidate) {
        const zhHome = containsCjk((candidate as PinnacleFixture).homeTeam) ? (candidate as PinnacleFixture).homeTeam : null;
        const zhAway = containsCjk((candidate as PinnacleFixture).awayTeam) ? (candidate as PinnacleFixture).awayTeam : null;
        const zhLeague = containsCjk((candidate as PinnacleFixture).league) ? (candidate as PinnacleFixture).league : null;
        if (zhHome || zhAway || zhLeague) {
          return {
            pinnapiId: fixture.pinnapiId,
            zhHome,
            zhAway,
            zhLeague,
            source: "optic",
          };
        }
      }
    } catch {
      // optic is also best-effort.
    }
  }

  if (deps.wikidata) {
    // Entity lookups are independent and the resolver enforces a process-wide
    // three-request semaphore plus a tick-scoped distinct-entity budget.
    const [home, away, league] = await Promise.all([
      deps.wikidata.lookup(fixture.homeTeam, "team"),
      deps.wikidata.lookup(fixture.awayTeam, "team"),
      deps.wikidata.lookup(fixture.league, "league"),
    ]);
    if (deps.wikidata.wasBudgetExhausted?.()) {
      // Do not turn a deliberate per-tick cap into a fixture-level failed
      // attempt/backoff. Cached successes remain available on the next tick.
      throw new WikidataLookupBudgetExhaustedError();
    }
    if (home || away || league) {
      return {
        pinnapiId: fixture.pinnapiId,
        zhHome: home?.label ?? null,
        zhAway: away?.label ?? null,
        zhLeague: league?.label ?? null,
        source: "wikidata",
      };
    }
  }

  return null;
}

/**
 * Decide whether to (re-)fetch a translation for a given PinnAPI id.  A missing
 * row is always fetched; a complete row is skipped; a partial row is retried
 * once every 4h up to three attempts.
 */
export function shouldFetchTranslation(
  existing: {
    zh_home: string | null;
    zh_away?: string | null;
    zh_league: string | null;
    attempted_at: number | null;
    attempt_count: number;
  } | null,
  now = Date.now(),
): boolean {
  if (!existing) return true;
  if (existing.zh_home && existing.zh_away && existing.zh_league) return false;
  if (existing.attempt_count >= 3) return false;
  if (existing.attempted_at === null) return true;
  return now - existing.attempted_at > 4 * 60 * 60_000;
}
