/**
 * Event matching between HKJC (traditional Chinese) and titan007/Pinnacle
 * (simplified Chinese).
 *
 * Matching NEVER relies on names alone. A candidate must satisfy:
 *   1. kickoff within ±10 minutes
 *   2. league compatibility (alias/containment after normalization) OR a very
 *      strong name score, and
 *   3. normalized home AND away name similarity above the floor.
 * Confidence and, when unmatched, the reason are always recorded.
 */

import * as OpenCC from "opencc-js";

export const KICKOFF_TOLERANCE_MS = 10 * 60 * 1000;
export const NAME_FLOOR = 0.5;
export const ACCEPT_CONFIDENCE = 0.62;

const t2s = OpenCC.Converter({ from: "tw", to: "cn" });

const NOISE = /[\s\u3000·・.,'’`"()（）\[\]【】\-–—_/\\|]+/g;
const DROP_WORDS = [
  "足球俱乐部",
  "俱乐部",
  "足球会",
  "足球",
  "队",
  "fc",
  "sc",
  "cf",
  "afc",
  "ac",
  "cd",
  "u23",
  "u21",
  "u19",
];

/**
 * Reviewed competition aliases. These only improve the league component after
 * the hard kickoff window and both-team name floor have already passed.
 */
const LEAGUE_ALIAS_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ["女子南韓職業聯賽", "韩女联"],
  ["東南亞錦標賽", "东南锦"],
  ["芬蘭超級聯賽", "芬超"],
  ["挪威超級聯賽", "挪超"],
  ["荷蘭乙組聯賽", "荷乙"],
  ["比利時甲組聯賽", "比甲"],
  ["北美聯賽盃", "中北美杯"],
  ["澳洲全國聯賽 - 昆士蘭", "澳昆超"],
  ["澳洲全國聯賽 - 新南威爾斯", "澳威超"],
  ["日本職業聯賽", "日职联"],
  ["日本乙組聯賽", "日职乙"],
  ["荷蘭甲組聯賽", "荷甲"],
];

/** Provider-agnostic canonical key for a team or league name. */
export function normalizeName(raw: string): string {
  if (!raw) return "";
  let s = String(raw).trim().toLowerCase();
  s = t2s(s);
  s = s.replace(NOISE, "");
  for (const w of DROP_WORDS) s = s.split(w).join("");
  return s;
}

const LEAGUE_CANONICAL = new Map<string, string>();
for (const [canonical, ...aliases] of LEAGUE_ALIAS_GROUPS) {
  const key = normalizeName(canonical);
  LEAGUE_CANONICAL.set(key, key);
  for (const alias of aliases) LEAGUE_CANONICAL.set(normalizeName(alias), key);
}

export function leagueSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  const cx = LEAGUE_CANONICAL.get(x);
  const cy = LEAGUE_CANONICAL.get(y);
  return cx && cy && cx === cy ? 1 : similarity(a, b);
}

function bigrams(s: string): string[] {
  if (s.length <= 1) return s ? [s] : [];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice similarity on character bigrams, with containment boost. */
export function similarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) {
    return Math.max(0.82, Math.min(x.length, y.length) / Math.max(x.length, y.length));
  }
  const A = bigrams(x);
  const B = bigrams(y);
  if (!A.length || !B.length) return 0;
  const pool = new Map<string, number>();
  for (const g of B) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hits = 0;
  for (const g of A) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      hits++;
      pool.set(g, n - 1);
    }
  }
  return (2 * hits) / (A.length + B.length);
}

export interface CandidateEvent {
  id: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: number;
}

export interface MatchDecision {
  pinnacleMatchId: string | null;
  confidence: number;
  method: string;
  kickoffDeltaSec: number | null;
  unmatchedReason: string | null;
  /** Alias pairs worth persisting once a match is accepted. */
  learnedAliases: Array<{ canonical: string; alias: string; provider: "hkjc" | "pinnacle" }>;
}

export interface AliasIndex {
  /** provider alias -> canonical key */
  get(provider: "hkjc" | "pinnacle", alias: string): string | undefined;
}

export function scoreCandidate(
  target: CandidateEvent,
  cand: CandidateEvent,
  aliases?: AliasIndex,
): { score: number; nameScore: number; leagueScore: number; timeScore: number } {
  const dt = Math.abs(target.kickoffUtc - cand.kickoffUtc);
  const timeScore = Math.max(0, 1 - dt / KICKOFF_TOLERANCE_MS);

  const canonTargetHome = aliases?.get("hkjc", normalizeName(target.homeTeam));
  const canonCandHome = aliases?.get("pinnacle", normalizeName(cand.homeTeam));
  const canonTargetAway = aliases?.get("hkjc", normalizeName(target.awayTeam));
  const canonCandAway = aliases?.get("pinnacle", normalizeName(cand.awayTeam));

  const homeAliasHit = !!canonTargetHome && canonTargetHome === canonCandHome;
  const awayAliasHit = !!canonTargetAway && canonTargetAway === canonCandAway;

  const home = homeAliasHit ? 1 : similarity(target.homeTeam, cand.homeTeam);
  const away = awayAliasHit ? 1 : similarity(target.awayTeam, cand.awayTeam);
  const nameScore = (home + away) / 2;
  const leagueScore = leagueSimilarity(target.league, cand.league);

  const score = 0.25 * timeScore + 0.6 * nameScore + 0.15 * leagueScore;
  return { score, nameScore, leagueScore, timeScore };
}

/**
 * Pick the best Pinnacle candidate for one HKJC match.
 * Names alone can never produce a match: the kickoff window is a hard gate.
 */
export function matchEvent(
  target: CandidateEvent,
  candidates: CandidateEvent[],
  aliases?: AliasIndex,
): MatchDecision {
  const inWindow = candidates.filter(
    (c) => Math.abs(c.kickoffUtc - target.kickoffUtc) <= KICKOFF_TOLERANCE_MS,
  );
  if (inWindow.length === 0) {
    return {
      pinnacleMatchId: null,
      confidence: 0,
      method: "time+league+alias",
      kickoffDeltaSec: null,
      unmatchedReason: "no_candidate_in_kickoff_window",
      learnedAliases: [],
    };
  }
  let best: { cand: CandidateEvent; parts: ReturnType<typeof scoreCandidate> } | null = null;
  for (const c of inWindow) {
    const parts = scoreCandidate(target, c, aliases);
    if (!best || parts.score > best.parts.score) best = { cand: c, parts };
  }
  if (!best) {
    return {
      pinnacleMatchId: null,
      confidence: 0,
      method: "time+league+alias",
      kickoffDeltaSec: null,
      unmatchedReason: "no_candidate_in_kickoff_window",
      learnedAliases: [],
    };
  }
  const { cand, parts } = best;
  const deltaSec = Math.round((cand.kickoffUtc - target.kickoffUtc) / 1000);

  if (parts.nameScore < NAME_FLOOR) {
    return {
      pinnacleMatchId: null,
      confidence: Math.round(parts.score * 1000) / 1000,
      method: "time+league+alias",
      kickoffDeltaSec: deltaSec,
      unmatchedReason: "team_name_similarity_below_floor",
      learnedAliases: [],
    };
  }
  if (parts.score < ACCEPT_CONFIDENCE) {
    return {
      pinnacleMatchId: null,
      confidence: Math.round(parts.score * 1000) / 1000,
      method: "time+league+alias",
      kickoffDeltaSec: deltaSec,
      unmatchedReason: "combined_confidence_below_threshold",
      learnedAliases: [],
    };
  }
  const canonHome = normalizeName(target.homeTeam);
  const canonAway = normalizeName(target.awayTeam);
  return {
    pinnacleMatchId: cand.id,
    confidence: Math.round(parts.score * 1000) / 1000,
    method: "time+league+alias",
    kickoffDeltaSec: deltaSec,
    unmatchedReason: null,
    learnedAliases: [
      { canonical: canonHome, alias: normalizeName(target.homeTeam), provider: "hkjc" },
      { canonical: canonHome, alias: normalizeName(cand.homeTeam), provider: "pinnacle" },
      { canonical: canonAway, alias: normalizeName(target.awayTeam), provider: "hkjc" },
      { canonical: canonAway, alias: normalizeName(cand.awayTeam), provider: "pinnacle" },
    ],
  };
}
