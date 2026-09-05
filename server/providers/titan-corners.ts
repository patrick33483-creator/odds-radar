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

const DETAIL_BASE = process.env.TITAN_DETAIL_BASE ?? "https://live.titan007.com/detail";

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
