/**
 * Corner results from titan007 / 球探網 match detail pages.
 *
 * Why this exists: HKJC's historic `matchResult` query returns
 * `ttlCornerResult = -1` on every row (verified across 700 fixtures), and an
 * ended fixture drops out of the pre-match `matchList` feed immediately, so
 * HKJC exposes no way to recover a past match's corner count. titan007 keeps a
 * per-match statistics page that stays readable for days after kickoff, and we
 * already store `matches.titan_id` for fixtures matched against titan, so past
 * corner counts are recoverable there.
 *
 * Page shape (UTF-8, despite most titan pages being gb18030):
 *
 *   var teamTvStatisticData = "0,5,1,83,17^2,2,4,33,67^4,12,10,55,45^...";
 *
 * Each `^` group is `code,home,away,homePct,awayPct`. Code 0 is 角球 (full-match
 * corners) — confirmed against the page's own rendered `teamTechDiv` list,
 * which labels the same pair as 角球. Percentages are share-of-total bar widths
 * and are ignored. Youth and minor fixtures often omit code 0 entirely; that is
 * reported as "no corner statistic", never as zero corners.
 *
 * This provider is read-only and derives nothing. Callers must keep its output
 * out of `research_results.corners_total`, because corner settlement requires
 * HKJC's own confirmed figure (see `canSettleCornerMarket`).
 */

import { fetchText } from "../lib/http";
import { PinnacleProvider, type PinnacleFixture } from "./pinnacle";
import { normalizeName } from "../lib/matching";
import { rawDb } from "../lib/store";

const DETAIL_BASE = process.env.TITAN_DETAIL_BASE ?? "https://live.titan007.com/detail";

/** Kickoff tolerance for name+date fallback. Titan schedule times occasionally
 *  drift by a few minutes from HKJC/Pinnacle; 30 min is safe against same-team
 *  double-headers in a day. */
const KICKOFF_TOL_MS = 30 * 60_000;

/** Full-match corner counts for one titan schedule id. */
export interface TitanCorners {
  titanId: string;
  homeCorners: number;
  awayCorners: number;
  cornersTotal: number;
}

const CORNER_STAT_CODE = "0";

/**
 * Pull 角球 out of a titan detail page body.
 *
 * Returns null when the page has no statistics block, or has one that omits the
 * corner code. Both are normal for youth and lower-tier fixtures.
 */
export function parseTitanCorners(html: string, titanId: string): TitanCorners | null {
  const block = /teamTvStatisticData\s*=\s*"([^"]*)"/.exec(html);
  if (!block) return null;

  for (const group of block[1].split("^")) {
    const parts = group.split(",");
    if (parts[0] !== CORNER_STAT_CODE) continue;
    // Number("") is 0, so an empty field would silently become a 0-0 corner
    // count. Require an explicit run of digits instead.
    const home = parts[1]?.trim() ?? "";
    const away = parts[2]?.trim() ?? "";
    if (!/^\d+$/.test(home) || !/^\d+$/.test(away)) return null;
    const homeCorners = Number(home);
    const awayCorners = Number(away);
    return { titanId, homeCorners, awayCorners, cornersTotal: homeCorners + awayCorners };
  }
  return null;
}

export interface TitanCornerFetchOpts {
  signal?: AbortSignal;
  timeoutMs?: number;
  retries?: number;
}

/** Fetch and parse one match's corner statistic. Null when unavailable. */
export async function fetchTitanCorners(
  titanId: string,
  opts: TitanCornerFetchOpts = {},
): Promise<TitanCorners | null> {
  if (!/^\d+$/.test(titanId)) throw new Error(`不合法的球探賽事編號: ${titanId}`);
  const html = await fetchText(`${DETAIL_BASE}/${titanId}cn.htm`, {
    headers: {
      referer: "https://live.titan007.com/",
      accept: "text/html",
      "accept-language": "zh-HK,zh-TW;q=0.9,en;q=0.8",
    },
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 15_000,
    retries: opts.retries ?? 1,
  });
  return parseTitanCorners(html, titanId);
}

/* ------------------------------------------------------------------ *
 * Name + date resolver
 *
 * Recovers a titan sId for a past fixture that has no matches.titan_id.
 * Uses Titan's Over_YYYYMMDD schedule pages (already loaded by pinnacle.ts
 * for research fixture matching) and confirms via kickoff proximity + a
 * normalized team-name match. Persisted team_aliases entries are consulted
 * so learned HKJC → Titan translations transfer automatically.
 * ------------------------------------------------------------------ */

let cachedProvider: PinnacleProvider | null = null;
function sharedProvider(): PinnacleProvider {
  if (!cachedProvider) cachedProvider = new PinnacleProvider();
  return cachedProvider;
}

function hktYmd(ms: number): string {
  const d = new Date(ms + 8 * 3600_000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Best-effort alias lookup: our own team_aliases table already stores
 *  HKJC ⇄ Pinnacle/Titan simplified-Chinese aliases. Return every known
 *  alias that maps to the same canonical key as `name`, so we can match a
 *  Titan schedule row whose team text may differ from HKJC's traditional form. */
function expandAliases(name: string): Set<string> {
  const canon = normalizeName(name);
  const out = new Set<string>([canon]);
  try {
    const rows = rawDb.prepare(
      `SELECT alias FROM team_aliases WHERE canonical = ?`,
    ).all(canon) as Array<{ alias: string }>;
    for (const r of rows) out.add(normalizeName(r.alias));
  } catch {
    /* team_aliases table may be absent in a stripped test db; canonical form alone still helps. */
  }
  return out;
}

export interface TitanResolveTarget {
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: number;
}

export interface TitanResolveResult {
  titanId: string;
  method: "name+date";
  candidateCount: number;
}

/** Return the Titan sId for a fixture identified by team names + kickoff.
 *  Null when: schedule fetch fails, no row within tolerance, or multiple
 *  ambiguous rows within tolerance (never guess). */
export async function resolveTitanIdByNameDate(
  target: TitanResolveTarget,
  opts: TitanCornerFetchOpts = {},
): Promise<TitanResolveResult | null> {
  const homeAliases = expandAliases(target.homeTeam);
  const awayAliases = expandAliases(target.awayTeam);

  // Compute day offsets relative to today so Titan's Next_/Over_ picker chooses
  // the right page. A past fixture uses Over_YYYYMMDD; kickoff-day math handles
  // fixtures that straddle midnight HKT.
  const nowUtc = Date.now();
  const targetYmd = hktYmd(target.kickoffUtc);
  const todayYmd = hktYmd(nowUtc);
  const targetDay = new Date(
    Number(targetYmd.slice(0, 4)),
    Number(targetYmd.slice(4, 6)) - 1,
    Number(targetYmd.slice(6, 8)),
  ).getTime();
  const todayDay = new Date(
    Number(todayYmd.slice(0, 4)),
    Number(todayYmd.slice(4, 6)) - 1,
    Number(todayYmd.slice(6, 8)),
  ).getTime();
  const offset = Math.round((targetDay - todayDay) / 86_400_000);

  let fixtures: PinnacleFixture[];
  try {
    fixtures = await sharedProvider().fetchTitanResearchFixtures([offset], {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 25_000,
      retries: opts.retries ?? 1,
    });
  } catch {
    return null;
  }

  const matches = fixtures.filter((f) => {
    if (Math.abs(f.kickoffUtc - target.kickoffUtc) > KICKOFF_TOL_MS) return false;
    const home = normalizeName(f.homeTeam);
    const away = normalizeName(f.awayTeam);
    return homeAliases.has(home) && awayAliases.has(away);
  });

  if (matches.length !== 1) return null;
  const titanId = matches[0].providerMatchId;
  if (!/^\d+$/.test(titanId)) return null;
  return { titanId, method: "name+date", candidateCount: matches.length };
}
