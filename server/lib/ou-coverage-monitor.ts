/**
 * OU three-stage coverage watchdog.
 *
 * The OU signal is only computable when ONE provider holds all three
 * checkpoints — initial, T30 and T5 — for the same fixture. Miss any single
 * stage and the fixture silently produces no signal at all: nothing errors,
 * nothing is logged as a failure, the alert simply never arrives. That silence
 * is the dangerous part, because a throughput regression in the collector looks
 * exactly like "no qualifying signals today".
 *
 * This module makes that silence audible: once a fixture has kicked off and its
 * stage windows are closed for good, any fixture that captured SOME stages but
 * not all three is reported to Telegram as a coverage gap.
 *
 * Design constraints:
 *   - Only fixtures with partial coverage are reported. A fixture with zero
 *     stages was never in scope (no board, no mapping) and would drown the
 *     signal in noise; a fixture with all three is healthy.
 *   - One alert per fixture, ever. Dedupe lives in its own table created with
 *     CREATE TABLE IF NOT EXISTS, so no migration is required.
 *   - Reports are grouped into a single message per run, and the run is capped,
 *     so a bad day cannot turn into a Telegram flood.
 */

import { rawDb } from "./store";

/** Stages the OU signal path requires from a single provider. */
const REQUIRED_STAGES = ["initial", "T30", "T5"] as const;
/** Wait past kickoff before judging: a late T5 write must not be called a gap. */
const SETTLE_AFTER_KICKOFF_MS = 10 * 60_000;
/** Do not re-litigate old history on every boot. */
const LOOKBACK_MS = 24 * 60 * 60_000;
/** Hard cap on fixtures named in one alert. */
const MAX_REPORTED = 12;

export interface OuCoverageGap {
  matchId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: number;
  fixtureSource: string;
  provider: string;
  capturedStages: string[];
  missingStages: string[];
}

function ensureDedupeTable(): void {
  rawDb.exec(
    `CREATE TABLE IF NOT EXISTS notified_ou_coverage_gaps(
       unique_key TEXT PRIMARY KEY,
       match_id TEXT NOT NULL,
       provider TEXT NOT NULL,
       missing_stages TEXT NOT NULL,
       kickoff_utc INTEGER NOT NULL,
       notified_at INTEGER NOT NULL
     )`,
  );
}

/**
 * Fixtures whose stage windows have closed with incomplete OU coverage.
 *
 * "Coverage" is measured exactly the way the signal path consumes it: the same
 * provider must hold both sides (O and U) of one OU line at a stage for that
 * stage to count. A half-written stage is a gap, not a capture.
 */
export function findOuCoverageGaps(now: number): OuCoverageGap[] {
  const until = now - SETTLE_AFTER_KICKOFF_MS;
  const since = now - LOOKBACK_MS;
  const rows = rawDb.prepare(
    `SELECT m.id, m.league, m.home_team, m.away_team, m.kickoff_utc, m.fixture_source,
            s.provider, s.stage
       FROM research_timeline_snapshots s
       JOIN matches m ON m.id = s.match_id
      WHERE m.kickoff_utc BETWEEN ? AND ?
        AND s.market = 'OU'
        AND s.stage IN ('initial','T30','T5')
        AND s.selection IN ('O','U')
      GROUP BY s.match_id, s.provider, s.stage, s.line_key
     HAVING COUNT(DISTINCT s.selection) >= 2`,
  ).all(since, until) as Array<{
    id: string;
    league: string;
    home_team: string;
    away_team: string;
    kickoff_utc: number;
    fixture_source: string;
    provider: string;
    stage: string;
  }>;

  const grouped = new Map<string, { row: (typeof rows)[number]; stages: Set<string> }>();
  for (const row of rows) {
    const key = `${row.id}|${row.provider}`;
    const entry = grouped.get(key) ?? { row, stages: new Set<string>() };
    entry.stages.add(row.stage);
    grouped.set(key, entry);
  }

  // A fixture is healthy when ANY provider is complete, so evaluate per fixture
  // and only report the best-covered provider — the one closest to a signal.
  const byMatch = new Map<string, Array<{ row: (typeof rows)[number]; stages: Set<string> }>>();
  for (const entry of grouped.values()) {
    byMatch.set(entry.row.id, [...(byMatch.get(entry.row.id) ?? []), entry]);
  }

  const gaps: OuCoverageGap[] = [];
  for (const entries of byMatch.values()) {
    if (entries.some((entry) => REQUIRED_STAGES.every((stage) => entry.stages.has(stage)))) continue;
    const best = entries.reduce((a, b) => (b.stages.size > a.stages.size ? b : a));
    const captured = REQUIRED_STAGES.filter((stage) => best.stages.has(stage));
    if (!captured.length) continue;
    gaps.push({
      matchId: best.row.id,
      league: best.row.league,
      homeTeam: best.row.home_team,
      awayTeam: best.row.away_team,
      kickoffUtc: best.row.kickoff_utc,
      fixtureSource: best.row.fixture_source,
      provider: best.row.provider,
      capturedStages: captured,
      missingStages: REQUIRED_STAGES.filter((stage) => !best.stages.has(stage)),
    });
  }
  return gaps.sort((a, b) => a.kickoffUtc - b.kickoffUtc);
}

/** Gaps not yet announced, newest kickoff last, capped for one message. */
export function unnotifiedOuCoverageGaps(now: number): OuCoverageGap[] {
  ensureDedupeTable();
  const seen = rawDb.prepare("SELECT unique_key FROM notified_ou_coverage_gaps");
  const known = new Set((seen.all() as Array<{ unique_key: string }>).map((row) => row.unique_key));
  return findOuCoverageGaps(now)
    .filter((gap) => !known.has(coverageGapKey(gap)))
    .slice(0, MAX_REPORTED);
}

export function coverageGapKey(gap: OuCoverageGap): string {
  return `${gap.matchId}|${gap.provider}`;
}

export function markOuCoverageGapNotified(gap: OuCoverageGap, now: number): void {
  ensureDedupeTable();
  rawDb.prepare(
    `INSERT OR IGNORE INTO notified_ou_coverage_gaps(
       unique_key, match_id, provider, missing_stages, kickoff_utc, notified_at
     ) VALUES(?,?,?,?,?,?)`,
  ).run(
    coverageGapKey(gap),
    gap.matchId,
    gap.provider,
    gap.missingStages.join(","),
    gap.kickoffUtc,
    now,
  );
}

function hkt(ms: number): string {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
}

export function buildOuCoverageGapMessage(gaps: OuCoverageGap[]): string {
  const lines = [
    "盤路雷達：OU 三段覆蓋缺口警報",
    `過去 24 小時有 ${gaps.length} 場開賽後仍然三段唔齊，呢啲場係計唔到 OU 訊號。`,
    "",
  ];
  for (const gap of gaps) {
    lines.push(
      `${hkt(gap.kickoffUtc)} HKT｜${gap.league}｜${gap.homeTeam} vs ${gap.awayTeam}`,
      `　來源 ${gap.fixtureSource}｜${gap.provider}｜已有 ${gap.capturedStages.join("/")}｜缺 ${gap.missingStages.join("/")}`,
    );
  }
  lines.push("", "如果持續出現，多數係採集吞吐量唔夠或者盤源臨時消失，要睇返 crown_stage_rescue 日誌。");
  return lines.join("\n");
}

/**
 * Send one grouped coverage-gap alert and record every fixture it named.
 *
 * Returns the number of fixtures reported (0 when Telegram is unconfigured or
 * there is nothing new), mirroring the other notify* helpers.
 */
export async function notifyOuSignalCoverageGap(now = Date.now()): Promise<number> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  const gaps = unnotifiedOuCoverageGaps(now);
  if (!gaps.length) return 0;
  if (!token || !chatId) return 0;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: buildOuCoverageGapMessage(gaps),
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram OU coverage alert failed: ${payload.description ?? response.status}`);
  }
  for (const gap of gaps) markOuCoverageGapNotified(gap, now);
  return gaps.length;
}
