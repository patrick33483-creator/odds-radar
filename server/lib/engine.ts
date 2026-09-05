/**
 * Refresh orchestration, opportunity detection and simulation placement.
 *
 * SCAN POLICY (latest correction)
 *   - The only automated scanning path is the dense pre-kickoff window scan in
 *     lib/scan.ts: events with 0 < minutes_to_kickoff <= 30 only.
 *   - The hourly pre-warm path refreshes fixtures/mapping and Pinnacle detail
 *     only for mapped matches starting within 24 hours. It never places bets.
 *   - A full all-match detail scan exists only as an explicit human action
 *     (POST /api/refresh?scope=full) and is never used by any recurring path.
 *   - No external schedule / cron is created. The optional in-process window
 *     checker is controlled by RADAR_AUTO_SCAN.
 *
 * Freshness policy
 *   frontend poll                    20 s   (client, read-only)
 *   backend lightweight throttle     30 s
 *   titan007 fixture-list cache      10 min
 *   Pinnacle detail cache            <=1h -> 60 s | 1-3h -> 180 s | >3h -> 600 s
 *                                    (bypassed inside the dense window)
 *
 * Last-good data is always retained; a provider failure never clears the
 * previous snapshot, never invents prices, and never substitutes another
 * bookmaker for Pinnacle.
 */

import { PinnacleProvider } from "../providers/pinnacle";
import { OpticOddsProvider } from "../providers/opticodds";
import { PinnapiProvider, type PinnapiFixture } from "../providers/pinnapi";
import { HkjcProvider } from "../providers/hkjc";
import type { ProviderPrice } from "../providers/types";
import { formatLine, isSameHandicapRoad, lineKeyOf } from "./lines";
import { matchEvent, normalizeName, type AliasIndex, type CandidateEvent } from "./matching";
import { CROWN_FIXED_STAKE, findThreeWayArb, findTwoWayArb, isArbitrageTotal } from "./arb";
import { evaluateEv, EV_THRESHOLD, HKJC_FIXED_STAKE, isSafe, MIN_MAPPING_CONFIDENCE, selectBestEv, STALE_MS } from "./ev";
import { confirmedOpportunityKeys, isHkjcExecutionQuoteFresh } from "./execution-guard";
import {
  crownExecutionPolicy,
  enforceCrownExecutionGate,
  type CrownFeedObservation,
} from "./crown-outage-guard";
import { buildSynthetic, EV_SYNTHETIC_TARGETS, SYNTHETIC_TARGETS, syntheticCoversCrown, type SynSide } from "./synthetic";
import { mergeOpportunityState, type DedupeEntry } from "./dedupe";
import { teamAliasSeedRows } from "./team-alias-seeds";
import { notifyOuPrealerts, notifyOuSignals, notifySimulationBets } from "./telegram";
import {
  captureResearchTimelinePrices,
  researchStageFor,
  savePinnacleResearchInitialSnapshots,
} from "./research";
import { unsentOuPrealerts, unsentOuSignals } from "./ou-signals";
import { shouldFetchTranslation, translatePinnacleFixture } from "./pinnacleTranslation";
import {
  createWikidataEntityLookup,
  WikidataLookupBudgetExhaustedError,
} from "./wikidataTranslation";
import {
  isSimulationPurchaseWindow,
  isPrewarmWindow,
  autoScanEnabled,
  crownLegsWithinLimit,
  matchCategoryEligible,
  runWindowScan,
  scanConfig,
  selectWindowEvents,
  remainingSimulationCapacity,
  simulationTarget,
  simulationTargetReached,
  t30AlertEnabled,
  type ScanCandidate,
  type ScanConfig,
} from "./scan";
import {
  aggregateBetStatus,
  canSettleCornerMarket,
  chooseSettlementSource,
  isSettleEligible,
  legReturn,
  matchFinalResult,
  round2,
  settleCornerTotal,
  settleLeg,
  type LegStatus,
} from "./settlement";
import {
  countSnapshots,
  db,
  eq,
  inArray,
  getState,
  marketLines,
  matchMapping,
  matches,
  oddsLatest,
  oddsSnapshots,
  opportunities,
  providerHealth,
  pruneSnapshots,
  rawDb,
  setState,
  simulationBets,
  simulationLegs,
  teamAliases,
  getPinnacleTranslation,
  upsertPinnacleTranslation,
  markPinnacleTranslationAttempt,
} from "./store";
import { DEMO_FIXTURE } from "./demo-data";
import type {
  ArbOpportunity,
  ScanOutcome,
  DashboardResponse,
  EvOpportunity,
  LineRow,
  Market,
  MatchRow,
  MatchRefreshResponse,
  PriceCell,
  ProviderStatus,
  Selection,
  StatusResponse,
  SyntheticOpportunity,
} from "@shared/types";

export const REFRESH_THROTTLE_MS = 30_000;
export const FIXTURE_CACHE_MS = 10 * 60_000;
/** Any dense helper loop must stay under this budget (hard ceiling < 300 s). */
export const MAX_LOOP_MS = 290_000;
/**
 * The Pinnacle-only collector shares a 30-second scheduler with milestone
 * capture. It must yield well before the next tick or the overlap gate will
 * discard every callback during the five-minute T5 window.
 */
export const PINNACLE_RESEARCH_LOOP_MS = 20_000;
/** Keep the primary HKJC checkpoint pass bounded below the 30-second scheduler cadence. */
export const RESEARCH_TIMELINE_DETAIL_LOOP_MS = 20_000;
const MAX_RESEARCH_TIMELINE_DETAIL_TARGETS = 100;
const PINNACLE_OPENING_RECOVERY_LOOKBACK_MS = 6 * 60 * 60_000;
const STARTED_MATCH_STATUS = /INPLAY|LIVE|FINISHED|ENDED|ABANDON|CANCEL|POSTPONE|RESULT/i;

export type PinnacleResearchTarget = {
  matchId: string;
  eventId: string;
  kickoffUtc: number;
  league: string;
  homeTeam: string;
  awayTeam: string;
  leagueEn?: string | null;
  homeTeamEn?: string | null;
  awayTeamEn?: string | null;
};

type PendingPinnacleResearchTarget = PinnacleResearchTarget & {
  stage: "initial" | "T30" | "T15" | "T5";
};

/**
 * Retry a name-safe match with PinnAPI's occasionally shifted kickoff time.
 * The wider window is accepted only when the ordinary matcher reaches very
 * high confidence after time is neutralised.
 */
export function matchWithVerifiedTimeFallback(
  target: CandidateEvent,
  candidates: CandidateEvent[],
  sourceAliases?: AliasIndex,
) {
  const direct = matchEvent(target, candidates, sourceAliases);
  if (direct.pinnacleMatchId) return direct;
  const nearby = candidates.filter((c) => Math.abs(c.kickoffUtc - target.kickoffUtc) <= 35 * 60_000);
  if (!nearby.length) return direct;
  const originalTimes = new Map(nearby.map((c) => [c.id, c.kickoffUtc]));
  const retry = matchEvent(
    target,
    nearby.map((c) => ({ ...c, kickoffUtc: target.kickoffUtc })),
    sourceAliases,
  );
  if (!retry.pinnacleMatchId || retry.confidence < 0.9) return direct;
  const original = originalTimes.get(retry.pinnacleMatchId) ?? target.kickoffUtc;
  return {
    ...retry,
    method: "extended-time+league+verified-alias",
    kickoffDeltaSec: Math.round((original - target.kickoffUtc) / 1000),
  };
}

/**
 * Only return fixtures whose current OU checkpoint is still missing.
 * Milestones nearest kickoff are processed first so a large fixture slate
 * cannot starve T5/T15 behind opening-price work.
 */
export function prioritizePendingPinnacleResearchTargets(
  targets: PinnacleResearchTarget[],
  capturedOuStages: ReadonlySet<string>,
  now: number,
): PendingPinnacleResearchTarget[] {
  const priority = { T5: 0, T15: 1, T30: 2, initial: 3 } as const;
  return targets
    .flatMap((target): PendingPinnacleResearchTarget[] => {
      const untilKickoff = target.kickoffUtc - now;
      if (
        untilKickoff < -PINNACLE_OPENING_RECOVERY_LOOKBACK_MS
        || untilKickoff > 24 * 60 * 60_000
      ) return [];
      const milestone = researchStageFor(target.kickoffUtc, now);
      if (milestone && !capturedOuStages.has(`${target.matchId}:${milestone}`)) {
        return [{ ...target, stage: milestone }];
      }
      // Opening is fetched from Titan's explicit bookmaker history and remains
      // recoverable after T-30. A captured live milestone must not prevent an
      // older first-seen "initial" row from being repaired.
      if (!capturedOuStages.has(`${target.matchId}:initial`)) {
        return [{ ...target, stage: "initial" }];
      }
      return [];
    })
    .sort((a, b) => priority[a.stage] - priority[b.stage] || a.kickoffUtc - b.kickoffUtc);
}

/** Merge a Crown-first alias into the later HKJC canonical fixture atomically. */
export function reconcileCrownFixtureIntoHkjc(hkjcId: string, titanId: string): boolean {
  return rawDb.transaction(() => {
    const claimed = rawDb.prepare(
      "SELECT id,fixture_source FROM matches WHERE titan_id=? AND id<>?",
    ).get(titanId, hkjcId) as { id: string; fixture_source: "hkjc" | "pinnacle" | "crown" } | undefined;
    // Never let a fuzzy fixture match steal a Titan identity already owned by
    // another HKJC row. Legacy duplicates are repaired during migration.
    if (claimed?.fixture_source === "hkjc") return false;
    const crown = claimed?.fixture_source === "crown" ? claimed : undefined;
    if (!crown) {
      rawDb.prepare("UPDATE matches SET titan_id=? WHERE id=? AND fixture_source='hkjc'").run(titanId, hkjcId);
      return false;
    }
    const sourceRows = rawDb.prepare(
      `SELECT provider,market,stage,line_key,selection,decimal_odds,is_main,source_updated_at,
              captured_at,target_at,status,origin,source_name,source_match_id,source_url
         FROM research_timeline_snapshots WHERE match_id=?`,
    ).all(crown.id) as Array<Record<string, unknown>>;
    const mergeSnapshot = rawDb.prepare(
      `INSERT INTO research_timeline_snapshots(
        match_id,provider,market,stage,line_key,selection,decimal_odds,is_main,
        source_updated_at,captured_at,target_at,status,origin,source_name,source_match_id,source_url
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(match_id,provider,market,stage,line_key,selection) DO UPDATE SET
        decimal_odds=CASE WHEN excluded.captured_at<captured_at THEN excluded.decimal_odds ELSE decimal_odds END,
        is_main=CASE WHEN excluded.captured_at<captured_at THEN excluded.is_main ELSE is_main END,
        source_updated_at=CASE WHEN excluded.captured_at<captured_at THEN excluded.source_updated_at ELSE source_updated_at END,
        target_at=CASE WHEN excluded.captured_at<captured_at THEN excluded.target_at ELSE target_at END,
        status=CASE WHEN excluded.captured_at<captured_at THEN excluded.status ELSE status END,
        origin=CASE WHEN excluded.captured_at<captured_at THEN excluded.origin ELSE origin END,
        source_name=CASE WHEN excluded.captured_at<captured_at THEN excluded.source_name ELSE source_name END,
        source_match_id=CASE WHEN excluded.captured_at<captured_at THEN excluded.source_match_id ELSE source_match_id END,
        source_url=CASE WHEN excluded.captured_at<captured_at THEN excluded.source_url ELSE source_url END,
        captured_at=MIN(captured_at,excluded.captured_at)`,
    );
    for (const row of sourceRows) {
      mergeSnapshot.run(
        hkjcId, row.provider, row.market, row.stage, row.line_key, row.selection,
        row.decimal_odds, row.is_main, row.source_updated_at, row.captured_at,
        row.target_at, row.status, row.origin, row.source_name, row.source_match_id, row.source_url,
      );
    }
    const sourcePoints = rawDb.prepare(
      "SELECT * FROM research_timeline_points WHERE match_id=?",
    ).all(crown.id) as Array<Record<string, unknown>>;
    const mergePoint = rawDb.prepare(
      `INSERT INTO research_timeline_points(
        match_id,stage,target_at,first_captured_at,last_retry_at,captured_at,status,note,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(match_id,stage) DO UPDATE SET
        target_at=COALESCE(target_at,excluded.target_at),
        first_captured_at=CASE
          WHEN first_captured_at IS NULL THEN excluded.first_captured_at
          WHEN excluded.first_captured_at IS NULL THEN first_captured_at
          ELSE MIN(first_captured_at,excluded.first_captured_at) END,
        captured_at=CASE
          WHEN captured_at IS NULL THEN excluded.captured_at
          WHEN excluded.captured_at IS NULL THEN captured_at
          ELSE MIN(captured_at,excluded.captured_at) END,
        last_retry_at=CASE
          WHEN last_retry_at IS NULL THEN excluded.last_retry_at
          WHEN excluded.last_retry_at IS NULL THEN last_retry_at
          ELSE MAX(last_retry_at,excluded.last_retry_at) END,
        status=CASE WHEN status='captured' OR excluded.status='captured' THEN 'captured'
                    WHEN status='partial' OR excluded.status='partial' THEN 'partial' ELSE status END,
        note=COALESCE(note,excluded.note),created_at=MIN(created_at,excluded.created_at),
        updated_at=MAX(updated_at,excluded.updated_at)`,
    );
    for (const point of sourcePoints) {
      mergePoint.run(
        hkjcId, point.stage, point.target_at, point.first_captured_at, point.last_retry_at,
        point.captured_at, point.status, point.note, point.created_at, point.updated_at,
      );
    }
    rawDb.prepare(
      `INSERT OR IGNORE INTO research_results(
        match_id,hkjc_id,home_score,away_score,corners_total,source,result_source,source_match_id,fetched_at
      )
      SELECT ?,NULL,home_score,away_score,corners_total,source,result_source,source_match_id,fetched_at
        FROM research_results WHERE match_id=?`,
    ).run(hkjcId, crown.id);
    rawDb.prepare("DELETE FROM research_timeline_snapshots WHERE match_id=?").run(crown.id);
    rawDb.prepare("DELETE FROM research_timeline_points WHERE match_id=?").run(crown.id);
    rawDb.prepare("DELETE FROM research_results WHERE match_id=?").run(crown.id);
    rawDb.prepare("DELETE FROM pinnacle_source_map WHERE match_id=?").run(crown.id);
    rawDb.prepare("DELETE FROM match_mapping WHERE match_id=?").run(crown.id);
    rawDb.prepare("DELETE FROM matches WHERE id=?").run(crown.id);
    rawDb.prepare("UPDATE matches SET titan_id=? WHERE id=? AND fixture_source='hkjc'").run(titanId, hkjcId);
    const points = rawDb.prepare(
      "SELECT stage FROM research_timeline_points WHERE match_id=?",
    ).all(hkjcId) as Array<{ stage: string }>;
    for (const point of points) {
      const complete = (rawDb.prepare(
        `SELECT COUNT(*) count FROM (
          SELECT provider,market FROM research_timeline_snapshots
           WHERE match_id=? AND stage=?
           GROUP BY provider,market HAVING COUNT(DISTINCT selection)>=2
        )`,
      ).get(hkjcId, point.stage) as { count: number }).count;
      const expected = point.stage === "initial" ? 7 : 8;
      rawDb.prepare(
        "UPDATE research_timeline_points SET status=?,note=? WHERE match_id=? AND stage=?",
      ).run(
        complete >= expected ? "captured" : "partial",
        complete >= expected ? null : `${complete}/${expected} provider-market pairs complete`,
        hkjcId,
        point.stage,
      );
    }
    return true;
  })();
}

export type PinnapiResearchReconciliation = "none" | "merged" | "unsafe";

/**
 * Relink a legacy standalone `pinnacle:<eventId>` research row to the
 * Titan-canonical fixture.
 *
 * Identity must already have been established by either the persisted
 * Titan/PinnAPI source map or the ordinary name/alias/translation matcher.
 * This function deliberately does not infer identity from kickoff alone.
 */
export function reconcileStandalonePinnapiResearch(
  canonicalMatchId: string,
  titanId: string,
  pinnapiId: string,
  reversed: boolean,
  now = Date.now(),
): PinnapiResearchReconciliation {
  return rawDb.transaction(() => {
    const canonical = rawDb.prepare(
      `SELECT id,fixture_source,titan_id,kickoff_utc
         FROM matches WHERE id=?`,
    ).get(canonicalMatchId) as {
      id: string;
      fixture_source: "hkjc" | "pinnacle" | "crown";
      titan_id: string | null;
      kickoff_utc: number;
    } | undefined;
    if (
      !canonical
      || canonical.fixture_source !== "pinnacle"
      || canonical.titan_id !== titanId
    ) return "unsafe";

    const ownerRows = rawDb.prepare(
      `SELECT DISTINCT match_id
         FROM pinnacle_source_map
        WHERE pinnapi_id=? AND match_id<>?`,
    ).all(pinnapiId, canonicalMatchId) as Array<{ match_id: string }>;
    const directId = `pinnacle:${pinnapiId}`;
    const direct = rawDb.prepare(
      "SELECT id FROM matches WHERE id=? AND id<>?",
    ).get(directId, canonicalMatchId) as { id: string } | undefined;
    const donorIds = new Set(ownerRows.map((row) => row.match_id));
    if (direct) donorIds.add(direct.id);
    if (!donorIds.size) return "none";
    // More than one existing owner is itself an ambiguity. Do not guess which
    // row contains the authoritative history.
    if (donorIds.size !== 1) return "unsafe";

    const donorId = [...donorIds][0];
    const donor = rawDb.prepare(
      `SELECT id,hkjc_id,fixture_source,titan_id,pinnacle_match_id,kickoff_utc
         FROM matches WHERE id=?`,
    ).get(donorId) as {
      id: string;
      hkjc_id: string | null;
      fixture_source: "hkjc" | "pinnacle" | "crown";
      titan_id: string | null;
      pinnacle_match_id: string | null;
      kickoff_utc: number;
    } | undefined;
    const providerIdCompatible = !donor?.pinnacle_match_id
      || donor.pinnacle_match_id === `pinnapi:${pinnapiId}`;
    if (
      !donor
      || donor.fixture_source !== "pinnacle"
      || donor.hkjc_id !== null
      || donor.titan_id !== null
      || !providerIdCompatible
      || Math.abs(donor.kickoff_utc - canonical.kickoff_utc) > 35 * 60_000
    ) return "unsafe";

    // Research-only rows must never have execution ownership. Refuse to merge
    // if a legacy row somehow escaped that invariant.
    const executionOwned = rawDb.prepare(
      `SELECT EXISTS(SELECT 1 FROM simulation_bets WHERE match_id=?)
           OR EXISTS(SELECT 1 FROM opportunities WHERE match_id=?) owned`,
    ).get(donorId, donorId) as { owned: number };
    if (executionOwned.owned) return "unsafe";

    // Preserve already-frozen canonical cells. Missing cells are relinked with
    // their original stage, timestamp and provenance; nothing is backdated or
    // promoted to an opening during reconciliation.
    rawDb.prepare(
      `INSERT OR IGNORE INTO research_timeline_snapshots(
         match_id,provider,market,stage,line_key,selection,decimal_odds,is_main,
         source_updated_at,captured_at,target_at,status,origin,source_name,
         source_match_id,source_url
       )
       SELECT ?,provider,market,stage,line_key,selection,decimal_odds,is_main,
              source_updated_at,captured_at,target_at,status,origin,source_name,
              source_match_id,source_url
         FROM research_timeline_snapshots
        WHERE match_id=? AND provider='pinnacle'`,
    ).run(canonicalMatchId, donorId);
    rawDb.prepare(
      `INSERT OR IGNORE INTO research_timeline_points(
         match_id,stage,target_at,first_captured_at,last_retry_at,captured_at,
         status,note,created_at,updated_at
       )
       SELECT ?,stage,target_at,first_captured_at,last_retry_at,captured_at,
              status,note,created_at,updated_at
         FROM research_timeline_points WHERE match_id=?`,
    ).run(canonicalMatchId, donorId);
    rawDb.prepare(
      `INSERT OR IGNORE INTO research_results(
         match_id,hkjc_id,home_score,away_score,corners_total,source,
         result_source,source_match_id,fetched_at
       )
       SELECT ?,NULL,home_score,away_score,corners_total,source,
              result_source,source_match_id,fetched_at
         FROM research_results WHERE match_id=?`,
    ).run(canonicalMatchId, donorId);
    rawDb.prepare(
      `INSERT OR IGNORE INTO results(
         match_id,pinnacle_match_id,home_score,away_score,corners_total,
         half_home,half_away,source,fetched_at
       )
       SELECT ?,pinnacle_match_id,home_score,away_score,corners_total,
              half_home,half_away,source,fetched_at
         FROM results WHERE match_id=?`,
    ).run(canonicalMatchId, donorId);
    rawDb.prepare(
      "UPDATE pinnapi_live_scores SET match_id=? WHERE match_id=?",
    ).run(canonicalMatchId, donorId);

    // Derived alerts are safe to regenerate from the canonical snapshots.
    for (const table of [
      "ou_signal_observations",
      "ou_signal_prealerts",
      "quote_direction_watch_observations",
    ]) {
      rawDb.prepare(`DELETE FROM ${table} WHERE match_id=?`).run(donorId);
    }
    for (const table of [
      "research_timeline_snapshots",
      "research_timeline_points",
      "research_results",
      "results",
      "market_lines",
      "odds_snapshots",
      "odds_latest",
    ]) {
      rawDb.prepare(`DELETE FROM ${table} WHERE match_id=?`).run(donorId);
    }
    rawDb.prepare("DELETE FROM match_mapping WHERE match_id=?").run(donorId);
    rawDb.prepare("DELETE FROM pinnacle_source_map WHERE match_id=?").run(donorId);
    rawDb.prepare("DELETE FROM matches WHERE id=?").run(donorId);

    rawDb.prepare(
      `INSERT INTO pinnacle_source_map(
         match_id,pinnapi_id,pinnapi_reversed,titan_id,titan_reversed,
         active_source,updated_at
       ) VALUES(?,?,?,?,0,'titan007',?)
       ON CONFLICT(match_id) DO UPDATE SET
         pinnapi_id=excluded.pinnapi_id,
         pinnapi_reversed=excluded.pinnapi_reversed,
         titan_id=excluded.titan_id,
         updated_at=excluded.updated_at`,
    ).run(canonicalMatchId, pinnapiId, reversed ? 1 : 0, titanId, now);

    // Recompute point completeness from real relinked rows only.
    const stages = rawDb.prepare(
      "SELECT stage FROM research_timeline_points WHERE match_id=?",
    ).all(canonicalMatchId) as Array<{ stage: string }>;
    for (const { stage } of stages) {
      const complete = (rawDb.prepare(
        `SELECT COUNT(*) count FROM (
           SELECT provider,market FROM research_timeline_snapshots
            WHERE match_id=? AND stage=? AND provider IN ('hkjc','pinnacle')
            GROUP BY provider,market HAVING COUNT(DISTINCT selection)>=2
         )`,
      ).get(canonicalMatchId, stage) as { count: number }).count;
      rawDb.prepare(
        `UPDATE research_timeline_points
            SET status=?,note=?,updated_at=MAX(updated_at,?)
          WHERE match_id=? AND stage=?`,
      ).run(
        complete >= 2 ? "captured" : complete > 0 ? "partial" : "pending",
        complete >= 2 ? null : complete > 0 ? `${complete}/2 provider-market pairs complete` : "等待平博收集",
        now,
        canonicalMatchId,
        stage,
      );
    }
    return "merged";
  })();
}

export function executionVerificationNote(verifiedAt: number): string {
  return [
    "execution_recheck=two_pass",
    `verified_at=${new Date(verifiedAt).toISOString()}`,
    "hkjc_quote_max_age=30s",
    "economic_key=confirmed",
  ].join(";");
}

/** lightweight = fixtures + HKJC prices only; prewarm24h = future 24 h detail
 *  refresh without bets; window = manual dense pre-kickoff detail refresh;
 *  full = explicit manual all-match detail scan. */
export type RefreshMode = "lightweight" | "prewarm24h" | "window" | "full";

const DEMO = process.env.RADAR_DEMO === "1";

function log(event: string, fields: Record<string, unknown> = {}): void {
  const payload = { ts: new Date().toISOString(), scope: "radar", event, ...fields };
  console.log(JSON.stringify(payload));
}

function pinnacleCacheTtl(minutesToKickoff: number): number {
  if (minutesToKickoff <= 60) return 60_000;
  if (minutesToKickoff <= 180) return 180_000;
  return 600_000;
}

interface PinnacleDetailCacheEntry {
  at: number;
  prices: ProviderPrice[];
}

interface HealthPatch {
  ok: boolean;
  latencyMs?: number;
  itemCount?: number;
  error?: string | null;
  mode?: "live" | "degraded" | "demo";
}

export class RadarEngine {
  private readonly crownFeedByMatch = new Map<string, CrownFeedObservation>();
  private readonly hkjc = new HkjcProvider();
  private readonly pinnapi = new PinnapiProvider();
  private readonly pinnacle = new PinnacleProvider();
  private readonly optic = new OpticOddsProvider();

  private refreshing = false;
  private inflight: Promise<void> | null = null;
  private hkjcInflight: Promise<boolean> | null = null;
  private lastRefreshAt: number | null = null;
  private lastGoodAt: number | null = null;
  private coldStartStage: StatusResponse["coldStartStage"] = "idle";
  private degradedReason: string | null = null;

  private fixtureCache: {
    at: number;
    pinnapi: PinnapiFixture[];
    optic: Awaited<ReturnType<OpticOddsProvider["fetchFixtures"]>>;
    titan: Awaited<ReturnType<PinnacleProvider["fetchFixtures"]>>;
  } | null = null;
  private lastTitanLiveFixtureIds = new Set<string>();
  private pinnacleDetail = new Map<string, PinnacleDetailCacheEntry>();
  private crownDetail = new Map<string, PinnacleDetailCacheEntry>();
  private pinnacleRowsSeen = 0;
  private lastScan: ScanOutcome | null = null;
  private scanning = false;
  private matchRefreshes = new Map<string, Promise<MatchRefreshResponse>>();
  private pinnacleTranslationRefreshRunning = false;
  // The board is a read-only projection.  Build it after a refresh and reuse
  // that immutable object for API polls so a busy provider/scan cannot make a
  // client request synchronously rebuild every market calculation.
  private dashboardCache: DashboardResponse | null = null;

  constructor() {
    const stored = getState("lastGoodAt");
    if (stored) this.lastGoodAt = Number(stored);
    if (this.lastGoodAt) this.coldStartStage = "done";
    const scan = getState("lastScan");
    if (scan) {
      try {
        this.lastScan = JSON.parse(scan) as ScanOutcome;
      } catch {
        this.lastScan = null;
      }
    }
  }

  /* ------------------------------- refresh ------------------------------- */

  isColdStart(): boolean {
    return this.lastGoodAt === null;
  }

  nextRefreshEligibleAt(): number {
    return (this.lastRefreshAt ?? 0) + REFRESH_THROTTLE_MS;
  }

  /**
   * Single-flight refresh. Concurrent callers await the in-flight run instead of
   * starting a second upstream storm. Returns immediately when throttled.
   *
   * `mode` defaults to "lightweight": no per-match Pinnacle detail calls, so the
   * dashboard's automated polling can never trigger an all-match detail scan.
   */
  async refresh(
    opts: { force?: boolean; mode?: RefreshMode } = {},
  ): Promise<{ started: boolean; throttled: boolean; mode: RefreshMode }> {
    const mode = opts.mode ?? "lightweight";
    if (this.inflight) {
      await this.inflight;
      return { started: false, throttled: false, mode };
    }
    const now = Date.now();
    if (!opts.force && this.lastRefreshAt && now - this.lastRefreshAt < REFRESH_THROTTLE_MS) {
      return { started: false, throttled: true, mode };
    }
    const cold = this.isColdStart();
    this.refreshing = true;
    if (cold) this.coldStartStage = "quick";
    this.inflight = this.runRefresh(mode)
      .catch((err) => log("refresh_failed", { error: (err as Error).message, mode }))
      .finally(() => {
        this.refreshing = false;
        this.inflight = null;
        this.lastRefreshAt = Date.now();
        this.coldStartStage = "done";
      });
    await this.inflight;
    return { started: true, throttled: false, mode };
  }

  /**
   * Explicit human-only refresh for one mapped match. It refreshes the HKJC
   * card once, then bypasses the Pinnacle/Crown detail caches for this match.
   * It never records a simulation or triggers a full-card detail scan.
   */
  async refreshMatch(matchId: string): Promise<MatchRefreshResponse> {
    const active = this.matchRefreshes.get(matchId);
    if (active) return active;

    const task = this.runMatchRefresh(matchId).finally(() => {
      this.matchRefreshes.delete(matchId);
    });
    this.matchRefreshes.set(matchId, task);
    return task;
  }

  private async runMatchRefresh(matchId: string): Promise<MatchRefreshResponse> {
    if (this.inflight) await this.inflight;

    const startedAt = Date.now();
    const initial = db.select().from(matches).where(eq(matches.id, matchId)).get();
    if (!initial) throw new Error("MATCH_NOT_FOUND");
    if (initial.fixtureSource !== "hkjc") throw new Error("MATCH_NOT_FOUND");
    if (!initial.pinnacleMatchId) throw new Error("MATCH_NOT_MAPPED");
    if (initial.kickoffUtc <= startedAt) throw new Error("MATCH_ALREADY_STARTED");

    const hkjcOk = await this.refreshHkjc();
    const current = db.select().from(matches).where(eq(matches.id, matchId)).get() ?? initial;
    const detail = await this.pollPinnacleDetail(
      [{ id: current.id, pinnacleMatchId: current.pinnacleMatchId, kickoffUtc: current.kickoffUtc }],
      Date.now() + 60_000,
      true,
    );

    const fresh = db
      .select()
      .from(oddsLatest)
      .where(eq(oddsLatest.matchId, matchId))
      .all()
      .filter((row) => row.fetchedAt >= startedAt);
    const hkjcPrices = fresh.filter((row) => row.provider === "hkjc").length;
    const pinnaclePrices = fresh.filter((row) => row.provider === "pinnacle").length;
    const crownPrices = fresh.filter((row) => row.provider === "crown").length;
    const ok = hkjcOk && detail.failed === 0 && pinnaclePrices > 0;
    const matchLabel = `${current.homeTeam} vs ${current.awayTeam}`;

    if (hkjcOk) {
      this.lastGoodAt = Date.now();
      setState("lastGoodAt", String(this.lastGoodAt));
    }
    this.recomputeDegradedReason();
    log("match_refresh", {
      matchId,
      matchLabel,
      ok,
      hkjcPrices,
      pinnaclePrices,
      crownPrices,
    });

    return {
      ok,
      matchId,
      matchLabel,
      refreshedAt: Date.now(),
      hkjcPrices,
      pinnaclePrices,
      crownPrices,
      message: ok
        ? `已更新：馬會 ${hkjcPrices}、Pinnacle ${pinnaclePrices}、皇冠 ${crownPrices} 個報價`
        : `更新未完整：馬會 ${hkjcPrices}、Pinnacle ${pinnaclePrices}、皇冠 ${crownPrices} 個報價`,
    };
  }

  private setHealth(provider: "hkjc" | "pinnacle", patch: HealthPatch): void {
    const now = Date.now();
    const prev = db.select().from(providerHealth).where(eq(providerHealth.provider, provider)).get();
    const failures = patch.ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1;
    rawDb
      .prepare(
        `INSERT INTO provider_health(provider, ok, last_success_at, last_attempt_at, last_error_at, last_error, consecutive_failures, last_latency_ms, item_count, mode)
         VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(provider) DO UPDATE SET ok=excluded.ok, last_success_at=excluded.last_success_at,
           last_attempt_at=excluded.last_attempt_at, last_error_at=excluded.last_error_at,
           last_error=excluded.last_error, consecutive_failures=excluded.consecutive_failures,
           last_latency_ms=excluded.last_latency_ms, item_count=excluded.item_count, mode=excluded.mode`,
      )
      .run(
        provider,
        patch.ok ? 1 : 0,
        patch.ok ? now : (prev?.lastSuccessAt ?? null),
        now,
        patch.ok ? (prev?.lastErrorAt ?? null) : now,
        patch.ok ? null : (patch.error ?? "unknown error"),
        failures,
        patch.latencyMs ?? prev?.lastLatencyMs ?? null,
        patch.itemCount ?? prev?.itemCount ?? 0,
        patch.mode ?? (DEMO ? "demo" : patch.ok ? "live" : "degraded"),
      );
  }

  private aliasIndex(): AliasIndex {
    const rows = db.select().from(teamAliases).all();
    const map = new Map<string, string>();
    for (const r of rows) map.set(`${r.provider}:${r.alias}`, r.canonical);
    return { get: (provider, alias) => map.get(`${provider}:${alias}`) };
  }

  /** Persist reviewed aliases without overwriting aliases learned from live matches. */
  private seedTeamAliases(now: number): void {
    const stmt = rawDb.prepare(
      "INSERT OR IGNORE INTO team_aliases(canonical,alias,provider,confirmed_at) VALUES(?,?,?,?)",
    );
    const tx = rawDb.transaction(() => {
      for (const seed of teamAliasSeedRows()) {
        stmt.run(seed.canonical, seed.hkjcAlias, "hkjc", now);
        stmt.run(seed.canonical, seed.pinnacleAlias, "pinnacle", now);
      }
    });
    tx();
  }

  /* --------------------------- refresh stages --------------------------- */

  /** HKJC pre-match snapshot. ONE upstream GraphQL call for every match. */
  private async refreshHkjc(): Promise<boolean> {
    if (this.hkjcInflight) return this.hkjcInflight;
    const task = this.performHkjcRefresh().finally(() => {
      if (this.hkjcInflight === task) this.hkjcInflight = null;
    });
    this.hkjcInflight = task;
    return task;
  }

  private async performHkjcRefresh(): Promise<boolean> {
    const now = Date.now();
    try {
      const res = DEMO
        ? { events: DEMO_FIXTURE.hkjc, latencyMs: 1, partial: false, warnings: ["DEMO"] }
        : await this.hkjc.fetchPreMatch({});
      this.setHealth("hkjc", { ok: true, latencyMs: res.latencyMs, itemCount: res.events.length, mode: DEMO ? "demo" : "live" });
      const persistBatch = rawDb.transaction((events: typeof res.events) => {
        const clearLatest = rawDb.prepare(
          "DELETE FROM odds_latest WHERE match_id=? AND provider='hkjc'",
        );
        const upsertMatch = rawDb.prepare(
          `INSERT INTO matches(id,hkjc_id,pinnacle_match_id,league,league_en,home_team,away_team,home_team_en,away_team_en,kickoff_utc,status,inplay,updated_at)
           VALUES(?,?,NULL,?,?,?,?,?,?,?,?,0,?)
           ON CONFLICT(id) DO UPDATE SET league=excluded.league, league_en=excluded.league_en,
             home_team=excluded.home_team, away_team=excluded.away_team, kickoff_utc=excluded.kickoff_utc,
             status=excluded.status, inplay=0, updated_at=excluded.updated_at`,
        );
        for (const ev of events) {
          const id = `hkjc:${ev.providerMatchId}`;
          upsertMatch.run(
            id,
            ev.providerMatchId,
            ev.league,
            ev.leagueEn ?? null,
            ev.homeTeam,
            ev.awayTeam,
            ev.homeTeamEn ?? null,
            ev.awayTeamEn ?? null,
            ev.kickoffUtc,
            ev.status,
            now,
          );
          // This endpoint is a complete pre-match snapshot for each returned
          // event. Remove lines that disappeared or became suspended before
          // inserting the currently tradable set, otherwise odds_latest can
          // keep an unexecutable old line alive until its local TTL expires.
          clearLatest.run(id);
          this.persistPrices(id, "hkjc", ev.prices, now, ev.kickoffUtc);
        }
      });
      // better-sqlite3 is synchronous. A full HKJC card can contain enough
      // rows to monopolise Node's only event loop and make every HTTP request
      // hit nginx's timeout. Keep each atomic section bounded and let pending
      // dashboard/status requests run between batches.
      const batchSize = 20;
      for (let offset = 0; offset < res.events.length; offset += batchSize) {
        persistBatch(res.events.slice(offset, offset + batchSize));
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      log("hkjc_refresh", { matches: res.events.length, latencyMs: res.latencyMs });
      return true;
    } catch (err) {
      const message = (err as Error).message;
      this.setHealth("hkjc", { ok: false, error: message });
      log("hkjc_error", { error: message });
      return false;
    }
  }

  /**
   * Fixture mapping with HKJC as the canonical card. PinnAPI Edge is the first
   * matching candidate and its event_id is persisted for dense price polling.
   * OpticOdds and titan007 stay fallback candidates for events PinnAPI does not
   * map; titan007 is also retained independently for Crown lock-price lookups.
   */
  private async refreshPinnacleFixtures(): Promise<number> {
    const now = Date.now();
    if (!this.fixtureCache || Date.now() - this.fixtureCache.at > FIXTURE_CACHE_MS) {
      if (DEMO) {
        this.fixtureCache = {
          at: Date.now(),
          pinnapi: DEMO_FIXTURE.pinnacleFixtures.map((f) => ({
            providerMatchId: f.providerMatchId,
            league: f.league,
            homeTeam: f.homeTeam,
            awayTeam: f.awayTeam,
            kickoffUtc: f.kickoffUtc,
            inplay: false,
            status: f.statusText || "scheduled",
            parentId: null,
          })),
          optic: [],
          titan: [],
        };
      } else {
        let pinnapi: PinnapiFixture[] = [];
        if (this.pinnapi.status().configured) {
          try {
            pinnapi = await this.pinnapi.fetchFixtures();
          } catch (err) {
            log("pinnapi_fixtures_error", { error: (err as Error).message });
          }
        }
        let optic: Awaited<ReturnType<OpticOddsProvider["fetchFixtures"]>> = [];
        try {
          optic = await this.optic.fetchFixtures();
        } catch (err) {
          log("optic_fixtures_error", { error: (err as Error).message });
        }
        let titan: Awaited<ReturnType<PinnacleProvider["fetchFixtures"]>> = [];
        try {
          titan = await this.pinnacle.fetchTitanResearchFixtures([0, 1, 2, 3, 4]);
        } catch (err) {
          // Crown/titan007 is deliberately non-primary. Its fixture endpoint
          // must not prevent PinnAPI EV mapping or Optic's unmapped fallback.
          log("titan_fixtures_error", { error: (err as Error).message });
        }
        this.fixtureCache = { at: Date.now(), pinnapi, optic, titan };
      }
    }
    const pinnapiFixtures = this.fixtureCache.pinnapi;
    const opticFixtures = this.fixtureCache.optic;
    const titanFixtures = this.fixtureCache.titan;
    this.seedTeamAliases(now);
    const aliases = this.aliasIndex();
    const toCandidates = (fixtures: Array<{ providerMatchId: string; league: string; homeTeam: string; awayTeam: string; kickoffUtc: number }>): CandidateEvent[] => fixtures.map((f) => ({
      id: f.providerMatchId,
      league: f.league,
      homeTeam: f.homeTeam,
      awayTeam: f.awayTeam,
      kickoffUtc: f.kickoffUtc,
    }));
    const pinnapiCandidates = toCandidates(pinnapiFixtures);
    const opticCandidates = toCandidates(opticFixtures);
    const titanCandidates = toCandidates(titanFixtures);

    const pending = db.select().from(matches).all().filter(
      (m) => m.fixtureSource === "hkjc" && m.kickoffUtc > now - 5 * 60_000,
    );
    let mapped = 0;
    const mapTx = rawDb.transaction(() => {
      for (const m of pending) {
        const target = { id: m.id, league: m.league, homeTeam: m.homeTeam, awayTeam: m.awayTeam, kickoffUtc: m.kickoffUtc };
        const englishTarget = {
          ...target,
          league: m.leagueEn || m.league,
          homeTeam: m.homeTeamEn || m.homeTeam,
          awayTeam: m.awayTeamEn || m.awayTeam,
        };
        const pinnapiDecision = matchWithVerifiedTimeFallback(englishTarget, pinnapiCandidates);
        // Fallback candidate maps are considered only when the primary PinnAPI
        // fixture set did not yield a safe match.
        const opticDecision = pinnapiDecision.pinnacleMatchId
          ? null
          : matchWithVerifiedTimeFallback(englishTarget, opticCandidates);
        const titanDecision = matchWithVerifiedTimeFallback(target, titanCandidates, aliases);
        if (titanDecision.pinnacleMatchId) {
          reconcileCrownFixtureIntoHkjc(m.id, titanDecision.pinnacleMatchId);
        }
        const decision = pinnapiDecision.pinnacleMatchId
          ? pinnapiDecision
          : opticDecision?.pinnacleMatchId
            ? opticDecision
            : titanDecision;
        const previous = this.sourceMap(m.id);
        let activeSource: "pinnapi" | "opticodds" | "titan007" | null = pinnapiDecision.pinnacleMatchId
          ? "pinnapi"
          : opticDecision?.pinnacleMatchId
            ? "opticodds"
            : titanDecision.pinnacleMatchId
              ? "titan007"
              : null;
        let activeId = decision.pinnacleMatchId
          ? `${activeSource === "pinnapi" ? "pinnapi" : activeSource === "opticodds" ? "optic" : "titan"}:${decision.pinnacleMatchId}`
          : null;
        if (!activeId && m.pinnacleMatchId) {
          activeId = m.pinnacleMatchId;
          activeSource = m.pinnacleMatchId.startsWith("pinnapi:")
            ? "pinnapi"
            : m.pinnacleMatchId.startsWith("optic:")
              ? "opticodds"
              : "titan007";
        }
        if (activeId) mapped++;
        const savedDecision = activeId && !decision.pinnacleMatchId
          ? {
              confidence: db.select().from(matchMapping).where(eq(matchMapping.matchId, m.id)).get()?.confidence ?? 0.62,
              method: "preserved-confirmed",
              kickoffDeltaSec: null,
              unmatchedReason: null,
            }
          : decision;
        rawDb
          .prepare(
            `INSERT INTO match_mapping(match_id,pinnacle_match_id,confidence,method,kickoff_delta_sec,unmatched_reason,updated_at)
             VALUES(?,?,?,?,?,?,?)
             ON CONFLICT(match_id) DO UPDATE SET pinnacle_match_id=excluded.pinnacle_match_id,
               confidence=excluded.confidence, method=excluded.method,
               kickoff_delta_sec=excluded.kickoff_delta_sec, unmatched_reason=excluded.unmatched_reason,
               updated_at=excluded.updated_at`,
          )
          .run(m.id, activeId, savedDecision.confidence, `${activeSource ?? "unmapped"}:${savedDecision.method}`, savedDecision.kickoffDeltaSec, savedDecision.unmatchedReason, now);
        rawDb
          .prepare(
            `INSERT INTO pinnacle_source_map(match_id,pinnapi_id,pinnapi_reversed,optic_id,optic_reversed,titan_id,titan_reversed,active_source,updated_at)
             VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET pinnapi_id=excluded.pinnapi_id,
             pinnapi_reversed=excluded.pinnapi_reversed,optic_id=excluded.optic_id,
             optic_reversed=excluded.optic_reversed,titan_id=excluded.titan_id,titan_reversed=excluded.titan_reversed,
             active_source=excluded.active_source,updated_at=excluded.updated_at`,
          )
          .run(
            m.id,
            pinnapiDecision.pinnacleMatchId ?? previous?.pinnapi_id ?? (m.pinnacleMatchId?.startsWith("pinnapi:") ? m.pinnacleMatchId.slice(8) : null),
            pinnapiDecision.pinnacleMatchId ? (pinnapiDecision.reversed ? 1 : 0) : (previous?.pinnapi_reversed ?? 0),
            opticDecision?.pinnacleMatchId ?? previous?.optic_id ?? null,
            opticDecision?.pinnacleMatchId ? (opticDecision.reversed ? 1 : 0) : (previous?.optic_reversed ?? 0),
            titanDecision.pinnacleMatchId ?? previous?.titan_id ?? (m.pinnacleMatchId?.startsWith("titan:") ? m.pinnacleMatchId.slice(6) : null),
            titanDecision.pinnacleMatchId ? (titanDecision.reversed ? 1 : 0) : (previous?.titan_reversed ?? 0),
            activeSource,
            now,
          );
        rawDb.prepare("UPDATE matches SET pinnacle_match_id=?,titan_id=COALESCE(?,titan_id) WHERE id=?")
          .run(activeId, titanDecision.pinnacleMatchId, m.id);
        for (const a of [...pinnapiDecision.learnedAliases, ...(opticDecision?.learnedAliases ?? []), ...titanDecision.learnedAliases]) {
          if (!a.alias) continue;
          rawDb
            .prepare(
              "INSERT INTO team_aliases(canonical,alias,provider,confirmed_at) VALUES(?,?,?,?) ON CONFLICT(provider,alias) DO UPDATE SET canonical=excluded.canonical, confirmed_at=excluded.confirmed_at",
            )
            .run(a.canonical, a.alias, a.provider, now);
        }
      }
    });
    mapTx();
    log("pinnacle_fixtures", {
      pinnapiFixtures: pinnapiFixtures.length,
      opticFixtures: opticFixtures.length,
      titanFixtures: titanFixtures.length,
      hkjcMatches: pending.length,
      mapped,
    });
    return pinnapiFixtures.length + opticFixtures.length + titanFixtures.length;
  }

  /**
   * Isolated Pinnacle-only research ingestion. Titan007's Chinese schedule is
   * the fixture/name source and its stable sId is used to fetch the Pinnacle
   * row from Titan's odds pages. PinnAPI is not allowed to gate Titan fixtures;
   * none of its English labels are persisted.
   *
   * This method NEVER touches `odds_latest`, `market_lines`, `opportunities`,
   * `simulation_bets`, Crown detail, HKJC execution, or the T-30 window
   * scanner.  It only writes research-timeline rows so the Pinnacle-only OU
   * signal path (rule provider='pinnacle', >1.70 gate) can evaluate them.
   */
  async refreshPinnacleOnlyResearch(now = Date.now()): Promise<{ fixtures: number; fetched: number; failed: number; rows: number }> {
    const refreshStartedAt = Date.now();
    // Requires the caller to have already populated fixtureCache via
    // refreshPinnacleFixtures().  We do not re-invoke it so unit tests that
    // mock refreshPinnacleFixtures can still assert exact call counts, and so
    // the runResearchTimelineTick order-of-operations stays deterministic.
    // Crown-opened fixtures define this research universe. Pinnacle prices
    // are then collected against the same stable Titan sId.
    const titan = (this.fixtureCache?.titan ?? []).filter(
      (fixture) => fixture.handicapVal !== null || fixture.totalVal !== null,
    );
    if (!titan.length) return { fixtures: 0, fetched: 0, failed: 0, rows: 0 };

    // Skip Titan ids already mapped to an HKJC-linked match, so we do not
    // shadow the HKJC canonical row.
    const mapped = new Set(
      (rawDb.prepare(
        "SELECT titan_id FROM matches WHERE fixture_source='hkjc' AND titan_id IS NOT NULL",
      ).all() as Array<{ titan_id: string | null }>).map((row) => row.titan_id).filter((v): v is string => !!v),
    );
    const ownerByTitan = new Map(
      (rawDb.prepare(
        `SELECT id,titan_id,fixture_source,league_en,home_team_en,away_team_en FROM matches
          WHERE titan_id IS NOT NULL`,
      ).all() as Array<{
        id: string;
        titan_id: string;
        fixture_source: "hkjc" | "pinnacle" | "crown";
        league_en: string | null;
        home_team_en: string | null;
        away_team_en: string | null;
      }>).map((row) => [row.titan_id, row]),
    );
    const upsertFixture = rawDb.prepare(
      `INSERT INTO matches(
        id,hkjc_id,fixture_source,titan_id,pinnacle_match_id,league,league_en,
        home_team,away_team,home_team_en,away_team_en,kickoff_utc,status,inplay,updated_at
      ) VALUES(?,NULL,'pinnacle',?,?,?,NULL,?,?,NULL,NULL,?,?,0,?)
       ON CONFLICT(id) DO UPDATE SET league=excluded.league,home_team=excluded.home_team,
         away_team=excluded.away_team,kickoff_utc=excluded.kickoff_utc,
         status=excluded.status,titan_id=excluded.titan_id,
         pinnacle_match_id=excluded.pinnacle_match_id,updated_at=excluded.updated_at
         WHERE matches.fixture_source='pinnacle'`,
    );

    const targets: PinnacleResearchTarget[] = [];
    const upsertTx = rawDb.transaction(() => {
      for (const fixture of titan) {
        if (mapped.has(fixture.providerMatchId)) continue;
        // Only fixtures still in the future or just kicked off are useful for
        // research; historical rows may still be settled later by a separate job.
        if (fixture.kickoffUtc < now - PINNACLE_OPENING_RECOVERY_LOOKBACK_MS) continue;
        const owner = ownerByTitan.get(fixture.providerMatchId);
        if (owner?.fixture_source === "hkjc") continue;
        const matchId = owner?.id ?? `pinnacle:titan:${fixture.providerMatchId}`;
        if (owner?.fixture_source === "crown") {
          // Older Crown-driven ingestion used the same unique Titan id. Convert
          // that canonical fixture in place: Crown remains only the selection
          // criterion and its price rows must not enter the research dataset.
          rawDb.prepare(
            `UPDATE matches
                SET fixture_source='pinnacle',pinnacle_match_id=?,updated_at=?
              WHERE id=? AND fixture_source='crown'`,
          ).run(`titan:${fixture.providerMatchId}`, now, matchId);
          rawDb.prepare(
            "DELETE FROM research_timeline_snapshots WHERE match_id=? AND provider='crown'",
          ).run(matchId);
          rawDb.prepare(
            `UPDATE research_timeline_points
                SET status=CASE WHEN EXISTS(
                      SELECT 1 FROM research_timeline_snapshots q
                       WHERE q.match_id=research_timeline_points.match_id
                         AND q.stage=research_timeline_points.stage
                         AND q.provider IN ('hkjc','pinnacle')
                    ) THEN 'partial' ELSE 'pending' END,
                    captured_at=NULL,note='等待馬會／平博收集',updated_at=?
              WHERE match_id=?`,
          ).run(now, matchId);
        }
        upsertFixture.run(
          matchId,
          fixture.providerMatchId,
          `titan:${fixture.providerMatchId}`,
          fixture.league,
          fixture.homeTeam,
          fixture.awayTeam,
          fixture.kickoffUtc,
          fixture.statusText || "PREEVENT",
          now,
        );
        targets.push({
          matchId,
          eventId: fixture.providerMatchId,
          kickoffUtc: fixture.kickoffUtc,
          league: fixture.league,
          homeTeam: fixture.homeTeam,
          awayTeam: fixture.awayTeam,
          leagueEn: owner?.league_en ?? null,
          homeTeamEn: owner?.home_team_en ?? null,
          awayTeamEn: owner?.away_team_en ?? null,
        });
      }
    });
    upsertTx();

    if (!targets.length) return { fixtures: 0, fetched: 0, failed: 0, rows: 0 };

    // Map the Titan-canonical research rows to cached PinnAPI fixtures once,
    // then retain that provider id for later collector cycles. Existing
    // mappings win, and a newly selected PinnAPI id cannot be claimed by a
    // second fixture in the same database.
    this.seedTeamAliases(now);
    const aliases = this.aliasIndex();
    const pinnapiCandidates: CandidateEvent[] = (this.fixtureCache?.pinnapi ?? []).map((fixture) => ({
      id: fixture.providerMatchId,
      league: fixture.league,
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam,
      kickoffUtc: fixture.kickoffUtc,
    }));
    const mappedPinnapi = new Map<string, { eventId: string; reversed: boolean }>();
    const claimedPinnapi = new Map(
      (rawDb.prepare(
        "SELECT match_id,pinnapi_id FROM pinnacle_source_map WHERE pinnapi_id IS NOT NULL ORDER BY updated_at DESC",
      ).all() as Array<{ match_id: string; pinnapi_id: string }>).map((row) => [row.pinnapi_id, row.match_id]),
    );
    const stablePinnapiByTitan = new Map<string, Array<{ matchId: string; eventId: string; reversed: boolean }>>();
    for (const row of rawDb.prepare(
      `SELECT match_id,titan_id,pinnapi_id,pinnapi_reversed
         FROM pinnacle_source_map
        WHERE titan_id IS NOT NULL AND pinnapi_id IS NOT NULL`,
    ).all() as Array<{
      match_id: string;
      titan_id: string;
      pinnapi_id: string;
      pinnapi_reversed: number;
    }>) {
      const entries = stablePinnapiByTitan.get(row.titan_id) ?? [];
      entries.push({
        matchId: row.match_id,
        eventId: row.pinnapi_id,
        reversed: !!row.pinnapi_reversed,
      });
      stablePinnapiByTitan.set(row.titan_id, entries);
    }
    const saveResearchSource = rawDb.prepare(
      `INSERT INTO pinnacle_source_map(
         match_id,pinnapi_id,pinnapi_reversed,titan_id,titan_reversed,active_source,updated_at
       ) VALUES(?,?,?,?,0,'titan007',?)
       ON CONFLICT(match_id) DO UPDATE SET
         pinnapi_id=excluded.pinnapi_id,
         pinnapi_reversed=excluded.pinnapi_reversed,
         titan_id=COALESCE(pinnacle_source_map.titan_id,excluded.titan_id),
         active_source=COALESCE(pinnacle_source_map.active_source,excluded.active_source),
         updated_at=excluded.updated_at`,
    );
    for (const target of targets) {
      const previous = this.sourceMap(target.matchId);
      if (
        previous?.pinnapi_id
        && (!claimedPinnapi.has(previous.pinnapi_id) || claimedPinnapi.get(previous.pinnapi_id) === target.matchId)
      ) {
        mappedPinnapi.set(target.matchId, {
          eventId: previous.pinnapi_id,
          reversed: !!previous.pinnapi_reversed,
        });
        continue;
      }
      // A legacy standalone PinnAPI row may already carry the exact Titan sId
      // in the provider source map. That persisted cross-provider identity is
      // stronger than another name pass and safely migrates collected history.
      const stable = stablePinnapiByTitan.get(target.eventId) ?? [];
      const stableIds = new Set(stable.map((entry) => entry.eventId));
      if (stableIds.size === 1) {
        const entry = stable.find((candidate) => candidate.eventId === [...stableIds][0])!;
        const reconciled = reconcileStandalonePinnapiResearch(
          target.matchId,
          target.eventId,
          entry.eventId,
          entry.reversed,
          now,
        );
        if (reconciled !== "unsafe") {
          claimedPinnapi.set(entry.eventId, target.matchId);
          mappedPinnapi.set(target.matchId, {
            eventId: entry.eventId,
            reversed: entry.reversed,
          });
          if (reconciled === "none") {
            saveResearchSource.run(
              target.matchId,
              entry.eventId,
              entry.reversed ? 1 : 0,
              target.eventId,
              now,
            );
          }
          continue;
        }
      }
      const available = pinnapiCandidates.filter(
        (candidate) => {
          const ownerId = claimedPinnapi.get(candidate.id);
          if (!ownerId || ownerId === target.matchId) return true;
          const owner = rawDb.prepare(
            `SELECT fixture_source,hkjc_id,titan_id FROM matches WHERE id=?`,
          ).get(ownerId) as {
            fixture_source: "hkjc" | "pinnacle" | "crown";
            hkjc_id: string | null;
            titan_id: string | null;
          } | undefined;
          // Let the normal identity matcher consider a research-only legacy
          // owner. It is transferred atomically after a successful match.
          return owner?.fixture_source === "pinnacle"
            && owner.hkjc_id === null
            && owner.titan_id === null;
        },
      );
      if (!available.length) continue;
      const canonicalTarget: CandidateEvent = {
        id: target.matchId,
        league: target.league,
        homeTeam: target.homeTeam,
        awayTeam: target.awayTeam,
        kickoffUtc: target.kickoffUtc,
      };
      const englishTarget: CandidateEvent = {
        ...canonicalTarget,
        league: target.leagueEn || target.league,
        homeTeam: target.homeTeamEn || target.homeTeam,
        awayTeam: target.awayTeamEn || target.awayTeam,
      };
      let decision = matchWithVerifiedTimeFallback(englishTarget, available, aliases);
      if (!decision.pinnacleMatchId) {
        // A prior translation lookup may provide the Chinese side of a
        // PinnAPI fixture. Use it only for identity matching; never write the
        // PinnAPI English labels or translated labels into the Titan row.
        const translated = available.map((candidate) => {
          const translation = getPinnacleTranslation(candidate.id);
          return translation?.zh_home && translation.zh_away
            ? {
                ...candidate,
                league: translation.zh_league || candidate.league,
                homeTeam: translation.zh_home,
                awayTeam: translation.zh_away,
              }
            : candidate;
        });
        decision = matchWithVerifiedTimeFallback(canonicalTarget, translated, aliases);
      }
      if (!decision.pinnacleMatchId) continue;
      const reconciled = reconcileStandalonePinnapiResearch(
        target.matchId,
        target.eventId,
        decision.pinnacleMatchId,
        decision.reversed,
        now,
      );
      if (reconciled === "unsafe") continue;
      claimedPinnapi.set(decision.pinnacleMatchId, target.matchId);
      mappedPinnapi.set(target.matchId, {
        eventId: decision.pinnacleMatchId,
        reversed: decision.reversed,
      });
      if (reconciled === "none") {
        saveResearchSource.run(
          target.matchId,
          decision.pinnacleMatchId,
          decision.reversed ? 1 : 0,
          target.eventId,
          now,
        );
      }
    }

    // Do not spend provider calls on an OU checkpoint already frozen in the
    // timeline. A single query avoids one DB lookup per fixture.
    const capturedOuStages = new Set(
      (rawDb.prepare(
        `SELECT DISTINCT match_id,stage
           FROM research_timeline_snapshots
          WHERE provider='pinnacle' AND market='OU'
            AND (stage<>'initial' OR origin='external_opening')`,
      ).all() as Array<{ match_id: string; stage: "initial" | "T30" | "T15" | "T5" }>)
        .map((row) => `${row.match_id}:${row.stage}`),
    );
    const eligible = prioritizePendingPinnacleResearchTargets(targets, capturedOuStages, now);
    // Fixture reconciliation can be expensive on a busy slate. The provider
    // budget must start only after that preparation has finished; otherwise
    // pre-processing can consume the whole window and no Titan detail request
    // is attempted for an entire T30 batch.
    const collectorStartedAt = Date.now();
    const deadline = collectorStartedAt + PINNACLE_RESEARCH_LOOP_MS;
    let fetched = 0;
    let failed = 0;
    let rows = 0;
    // Fetch a bounded number in parallel. The old sequential loop let one slow
    // detail page consume the whole 20-second budget and starve later fixtures
    // in a busy kickoff slate. Priority order is still T5, T15, T30, initial.
    let nextTarget = 0;
    const worker = async (): Promise<void> => {
      while (Date.now() <= deadline) {
        const target = eligible[nextTarget++];
        if (!target) return;
        let providerSucceeded = false;
        try {
          let researchPrices: {
            opening: ProviderPrice[];
            current: ProviderPrice[];
            sourceUrls: { AH: string; OU: string };
          } = { opening: [], current: [], sourceUrls: { AH: "", OU: "" } };
          try {
            researchPrices = DEMO
              ? {
                  opening: DEMO_FIXTURE.pinnaclePrices[`titan:${target.eventId}`] ?? [],
                  current: DEMO_FIXTURE.pinnaclePrices[`titan:${target.eventId}`] ?? [],
                  sourceUrls: { AH: "demo:pinnacle:AH", OU: "demo:pinnacle:OU" },
                }
              : await this.pinnacle.fetchPinnacleResearchPrices(target.eventId);
            providerSucceeded = true;
          } catch (err) {
            log("pinnacle_only_titan_detail_error", {
              eventId: target.eventId,
              error: (err as Error).message,
            });
          }
          const capturedAt = now;
          if (researchPrices.opening.length) {
            const inserted = savePinnacleResearchInitialSnapshots(
              target.matchId,
              target.eventId,
              researchPrices.opening,
              researchPrices.sourceUrls,
              capturedAt,
            );
            if (inserted) rows++;
          }
          let current = researchPrices.current;
          let currentSourceName = "titan007-pinnacle";
          let currentSourceMatchId = target.eventId;
          const pinnapiMapping = mappedPinnapi.get(target.matchId);
          if (
            !current.length
            && target.stage !== "initial"
            && pinnapiMapping
          ) {
            try {
              current = await this.pinnapi.fetchMatchPrices(pinnapiMapping.eventId);
              if (pinnapiMapping.reversed) current = this.reversePinnaclePrices(current);
              currentSourceName = "pinnapi";
              currentSourceMatchId = pinnapiMapping.eventId;
              providerSucceeded = true;
            } catch (err) {
              log("pinnacle_only_pinnapi_detail_error", {
                eventId: target.eventId,
                pinnapiEventId: pinnapiMapping.eventId,
                error: (err as Error).message,
              });
            }
          }
          // Current quotes are checkpoint observations only. In particular, a
          // first-seen PinnAPI quote outside T30/T15/T5 must never become an
          // opening or retroactively fill a missed milestone.
          if (current.length && researchStageFor(target.kickoffUtc, capturedAt)) {
            const inserted = captureResearchTimelinePrices(
              target.matchId,
              "pinnacle",
              current,
              target.kickoffUtc,
              capturedAt,
              {
                sourceName: currentSourceName,
                sourceMatchId: currentSourceMatchId,
              },
            );
            if (inserted) rows++;
          }
          if (providerSucceeded) fetched++;
          else failed++;
        } catch (err) {
          failed++;
          log("pinnacle_only_detail_error", { eventId: target.eventId, error: (err as Error).message });
        }
      }
    };
    const workerCount = Math.min(12, eligible.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    // Pinnacle-only fixtures can qualify for the OU signal path via the
    // existing prealert/observation sync (rule provider='pinnacle' only).
    try {
      const prealerts = unsentOuPrealerts(targets.map((t) => t.matchId));
      const sent = await notifyOuPrealerts(prealerts);
      if (sent) log("telegram_ou_t30_prealerts_pinnacle_only", { detected: prealerts.length, sent });
    } catch (err) {
      log("telegram_ou_t30_prealert_pinnacle_only_error", { error: (err as Error).message });
    }
    try {
      const signals = unsentOuSignals(targets.map((t) => t.matchId));
      const sent = await notifyOuSignals(signals);
      if (sent) log("telegram_ou_signals_pinnacle_only", { detected: signals.length, sent });
    } catch (err) {
      log("telegram_ou_signal_pinnacle_only_error", { error: (err as Error).message });
    }

    log("pinnacle_only_research", {
      fixtures: targets.length,
      pendingMilestones: eligible.length,
      fetched,
      failed,
      rows,
      preparationMs: collectorStartedAt - refreshStartedAt,
      collectionMs: Date.now() - collectorStartedAt,
    });
    return { fixtures: targets.length, fetched, failed, rows };
  }

  /**
   * Run one bounded translation backfill batch against the given fixtures.
   * Intended to be invoked from an independent low-frequency scheduler — NOT
   * from the research timeline. Respects a per-run `maxFixtures` cap so a
   * slow provider cannot monopolise the worker loop.
   */
  async runPinnacleTranslationBackfillBatch(
    targets: Array<{
      eventId: string;
      kickoffUtc: number;
      league: string;
      homeTeam: string;
      awayTeam: string;
    }>,
    now: number = Date.now(),
    options: { maxFixtures?: number } = {},
  ): Promise<{ scanned: number; translated: number; attempts: number }> {
    if (this.pinnacleTranslationRefreshRunning) {
      return { scanned: 0, translated: 0, attempts: 0 };
    }
    const cap = Math.max(1, Math.min(200, options.maxFixtures ?? 25));
    const limited = targets.slice(0, cap);
    let translated = 0;
    let attempts = 0;
    this.pinnacleTranslationRefreshRunning = true;
    try {
      let titanFixtures: Awaited<ReturnType<PinnacleProvider["fetchTitanResearchFixtures"]>> = [];
      try {
        titanFixtures = await this.pinnacle.fetchTitanResearchFixtures([0, 1, 2, 3, 4]);
      } catch (error) {
        log("pinnacle_translation_titan_schedule_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const wikidata = process.env.NODE_ENV === "test"
        ? undefined
        : createWikidataEntityLookup({ maxDistinct: 300 });
      for (const target of limited) {
        const existing = getPinnacleTranslation(target.eventId);
        if (!shouldFetchTranslation(existing, now)) continue;
        attempts++;
        try {
          const translation = await translatePinnacleFixture(
            {
              pinnapiId: target.eventId,
              homeTeam: target.homeTeam,
              awayTeam: target.awayTeam,
              league: target.league,
              kickoffUtc: target.kickoffUtc,
            },
            { pinnacle: this.pinnacle, titanFixtures, optic: this.optic, wikidata },
          );
          if (translation) {
            upsertPinnacleTranslation(translation, Date.now());
            translated++;
          } else {
            markPinnacleTranslationAttempt(target.eventId, null, Date.now());
          }
        } catch (error) {
          if (error instanceof WikidataLookupBudgetExhaustedError) break;
          const message = error instanceof Error ? error.message : String(error);
          markPinnacleTranslationAttempt(target.eventId, message, Date.now());
          log("pinnacle_translation_error", {
            pinnapiId: target.eventId,
            error: message,
          });
        }
      }
    } finally {
      this.pinnacleTranslationRefreshRunning = false;
    }
    return { scanned: limited.length, translated, attempts };
  }

  /**
   * Return recent Pinnacle-only fixtures that still need Chinese labels. The
   * query is bounded so the backfill worker never spans the entire matches
   * table.
   */
  listPinnacleTranslationBackfillTargets(
    limit: number = 200,
    now: number = Date.now(),
  ): Array<{
    eventId: string;
    kickoffUtc: number;
    league: string;
    homeTeam: string;
    awayTeam: string;
  }> {
    const clampedLimit = Math.max(1, Math.min(500, limit));
    const kickoffFromMs = now - 24 * 60 * 60_000;
    const kickoffToMs = now + 7 * 24 * 60 * 60_000;
    const rows = rawDb
      .prepare(
        `SELECT SUBSTR(m.id, 10) AS event_id,
                m.kickoff_utc AS kickoff_utc,
                m.league AS league,
                m.home_team AS home_team,
                m.away_team AS away_team
           FROM matches m
           LEFT JOIN pinnacle_translations pt ON pt.pinnapi_id = SUBSTR(m.id, 10)
          WHERE m.fixture_source = 'pinnacle'
            AND m.kickoff_utc BETWEEN ? AND ?
            AND (
              pt.pinnapi_id IS NULL
              OR (
                (pt.zh_home IS NULL OR pt.zh_away IS NULL OR pt.zh_league IS NULL)
                AND (pt.attempt_count IS NULL OR pt.attempt_count < 3)
                AND (pt.attempted_at IS NULL OR pt.attempted_at < ?)
              )
            )
          ORDER BY CASE WHEN m.kickoff_utc>=? THEN 0 ELSE 1 END,
                   ABS(m.kickoff_utc-?) ASC
          LIMIT ?`,
      )
      .all(kickoffFromMs, kickoffToMs, now - 4 * 60 * 60_000, now, now, clampedLimit) as Array<{
        event_id: string;
        kickoff_utc: number;
        league: string;
        home_team: string;
        away_team: string;
      }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      kickoffUtc: row.kickoff_utc,
      league: row.league,
      homeTeam: row.home_team,
      awayTeam: row.away_team,
    }));
  }

  private async translatePinnacleOnlyTargets(
    targets: Array<{
      eventId: string;
      kickoffUtc: number;
      league: string;
      homeTeam: string;
      awayTeam: string;
    }>,
    now: number,
  ): Promise<void> {
    if (this.pinnacleTranslationRefreshRunning) return;
    this.pinnacleTranslationRefreshRunning = true;
    // Resolver tests inject deterministic responses. Keep unrelated engine
    // tests hermetic while production gets a fresh 60-entity budget per tick.
    const wikidata = process.env.NODE_ENV === "test"
      ? undefined
      : createWikidataEntityLookup({ maxDistinct: 60 });
    try {
      for (const target of targets) {
        const existing = getPinnacleTranslation(target.eventId);
        if (!shouldFetchTranslation(existing, now)) continue;
        try {
          const translation = await translatePinnacleFixture(
            {
              pinnapiId: target.eventId,
              homeTeam: target.homeTeam,
              awayTeam: target.awayTeam,
              league: target.league,
              kickoffUtc: target.kickoffUtc,
            },
            { pinnacle: this.pinnacle, optic: this.optic, wikidata },
          );
          if (translation) {
            upsertPinnacleTranslation(translation, Date.now());
          } else {
            markPinnacleTranslationAttempt(target.eventId, null, Date.now());
          }
        } catch (error) {
          if (error instanceof WikidataLookupBudgetExhaustedError) break;
          const message = error instanceof Error ? error.message : String(error);
          markPinnacleTranslationAttempt(target.eventId, message, Date.now());
          log("pinnacle_translation_error", {
            pinnapiId: target.eventId,
            error: message,
          });
        }
      }
    } finally {
      this.pinnacleTranslationRefreshRunning = false;
    }
  }

  private sourceMap(matchId: string): {
    pinnapi_id: string | null;
    pinnapi_reversed: number;
    optic_id: string | null;
    optic_reversed: number;
    titan_id: string | null;
    titan_reversed: number;
  } | null {
    return (rawDb
      .prepare("SELECT pinnapi_id,pinnapi_reversed,optic_id,optic_reversed,titan_id,titan_reversed FROM pinnacle_source_map WHERE match_id=?")
      .get(matchId) as {
      pinnapi_id: string | null;
      pinnapi_reversed: number;
      optic_id: string | null;
      optic_reversed: number;
      titan_id: string | null;
      titan_reversed: number;
    } | undefined) ?? null;
  }

  /**
   * After kickoff, update all open PinnAPI-mapped simulations from exactly one
   * bounded all-live-markets request. The payload is filtered to tracked IDs
   * locally; this path never issues an event-by-event score request.
   */
  private async refreshTrackedPinnapiLiveScores(now: number): Promise<void> {
    if (DEMO || !this.pinnapi.status().configured) return;
    const matchesById = new Map(db.select().from(matches).all().map((match) => [match.id, match]));
    const tracked = new Map<string, { eventId: string; matchId: string; reversed: boolean }>();
    for (const bet of db.select().from(simulationBets).where(eq(simulationBets.excludedFromStats, 0)).all()) {
      // COU never uses a live score as a settlement source, including as a
      // liveness/end signal. Only HKJC's official ttlCornerResult may settle.
      if (bet.market === "COU" || bet.settledAt || bet.kickoffUtc > now) continue;
      const match = matchesById.get(bet.matchId);
      if (!match) continue;
      const source = this.sourceMap(match.id);
      const eventId =
        source?.pinnapi_id ??
        (match.pinnacleMatchId?.startsWith("pinnapi:") ? match.pinnacleMatchId.slice("pinnapi:".length) : null);
      if (eventId) tracked.set(eventId, { eventId, matchId: match.id, reversed: !!source?.pinnapi_reversed });
    }
    if (!tracked.size) return;

    try {
      const snapshot = await this.pinnapi.fetchLiveScoreSnapshot();
      const scoreByEvent = new Map(snapshot.scores.map((score) => [score.eventId, score]));
      const liveEventIds = new Set(snapshot.liveEventIds);
      const upsert = rawDb.prepare(
        `INSERT INTO pinnapi_live_scores(event_id,match_id,home_score,away_score,match_minutes,match_state,first_seen,last_seen,seen_live,no_longer_live,ended_candidate_at)
         VALUES(?,?,?,?,?,?,?,?,1,0,NULL)
         ON CONFLICT(event_id) DO UPDATE SET match_id=excluded.match_id,home_score=excluded.home_score,
         away_score=excluded.away_score,match_minutes=excluded.match_minutes,match_state=excluded.match_state,
         last_seen=excluded.last_seen,seen_live=1,no_longer_live=0,ended_candidate_at=NULL`,
      );
      const retainLive = rawDb.prepare(
        `UPDATE pinnapi_live_scores SET match_id=?,last_seen=?,match_state=COALESCE(match_state,'live_score_unavailable'),
         seen_live=1,no_longer_live=0,ended_candidate_at=NULL WHERE event_id=?`,
      );
      const markEnded = rawDb.prepare(
        `UPDATE pinnapi_live_scores SET no_longer_live=1,match_state='no_longer_live',
         ended_candidate_at=COALESCE(ended_candidate_at,?) WHERE event_id=? AND seen_live=1`,
      );
      const tx = rawDb.transaction(() => {
        for (const trackedEvent of tracked.values()) {
          const score = scoreByEvent.get(trackedEvent.eventId);
          if (score) {
            const homeScore = trackedEvent.reversed ? score.awayScore : score.homeScore;
            const awayScore = trackedEvent.reversed ? score.homeScore : score.awayScore;
            upsert.run(
              trackedEvent.eventId,
              trackedEvent.matchId,
              homeScore,
              awayScore,
              score.minutes,
              score.state,
              score.observedAt,
              score.observedAt,
            );
          } else if (liveEventIds.has(trackedEvent.eventId)) {
            // An incomplete score row is still proof the event remains live;
            // do not turn it into an end candidate.
            retainLive.run(trackedEvent.matchId, snapshot.observedAt, trackedEvent.eventId);
          } else {
            // Disappearance matters only after a real score/live observation.
            markEnded.run(snapshot.observedAt, trackedEvent.eventId);
          }
        }
      });
      tx();
      log("pinnapi_live_scores", { tracked: tracked.size, scored: scoreByEvent.size });
    } catch (err) {
      log("pinnapi_live_scores_error", { error: (err as Error).message, tracked: tracked.size });
    }
  }

  /** Re-orient a fallback or PinnAPI quote when its fixture was matched reversed. */
  private reversePinnaclePrices(prices: ProviderPrice[]): ProviderPrice[] {
    return prices.map((p) =>
      p.market === "AH"
        ? {
            ...p,
            lineValue: p.lineValue === null ? null : -p.lineValue,
            selection: p.selection === "H" ? "A" : p.selection === "A" ? "H" : p.selection,
          }
        : p.market === "1X2"
          ? { ...p, selection: p.selection === "H" ? "A" : p.selection === "A" ? "H" : p.selection }
          : p,
    );
  }

  /**
   * Per-match Pinnacle odds detail for an EXPLICIT list of matches only.
   * `bypassCache` is used by the dense pre-kickoff window scan.
   */
  private async pollPinnacleDetail(
    targets: Array<{ id: string; pinnacleMatchId: string | null; kickoffUtc: number }>,
    deadline: number,
    bypassCache = false,
  ): Promise<{ fetched: number; failed: number; rows: number }> {
    let fetched = 0;
    let failed = 0;
    let rows = 0;
    const queue = [...targets];
    const workers = Array.from({ length: 4 }, async () => {
      while (queue.length) {
        if (Date.now() > deadline) return;
        const m = queue.shift();
        if (!m?.pinnacleMatchId) continue;
        const minutes = (m.kickoffUtc - Date.now()) / 60_000;
        const ttl = bypassCache ? 0 : pinnacleCacheTtl(minutes);
        const source = this.sourceMap(m.id);
        const cached = this.pinnacleDetail.get(m.pinnacleMatchId);
        let prices = !bypassCache && cached && Date.now() - cached.at < ttl ? cached.prices : null;
        if (!prices) {
          try {
            if (DEMO) {
              prices = DEMO_FIXTURE.pinnaclePrices[m.pinnacleMatchId] ?? [];
            } else {
              // PinnAPI is the EV reference whenever the primary HKJC mapping
              // has a PinnAPI event_id. Price failures deliberately do not
              // substitute another bookmaker/source for that mapped event.
              if (m.pinnacleMatchId.startsWith("pinnapi:") && source?.pinnapi_id) {
                const normalPrices = await this.pinnapi.fetchMatchPrices(source.pinnapi_id);
                // Corner specials are an independent child-event response.
                // A missing/ambiguous child is fail-closed for COU only and
                // must never suppress valid 1X2/AH/OU snapshots.
                let cornerPrices: ProviderPrice[] = [];
                try {
                  cornerPrices = (await this.pinnapi.fetchEventCornerLines(source.pinnapi_id)).prices;
                } catch (cornerError) {
                  log("pinnapi_corner_detail_unavailable", {
                    pinnacleMatchId: m.pinnacleMatchId,
                    error: (cornerError as Error).message,
                  });
                }
                prices = [...normalPrices, ...cornerPrices];
                if (source.pinnapi_reversed) prices = this.reversePinnaclePrices(prices);
              } else if (m.pinnacleMatchId.startsWith("optic:") && source?.optic_id) {
                // Only a PinnAPI-unmapped event may use the OpticOdds fallback.
                prices = await this.optic.fetchMatchPrices(source.optic_id, !!source.optic_reversed);
              } else if (m.pinnacleMatchId.startsWith("titan:") && source?.titan_id) {
                // Last-resort fallback for a PinnAPI/OpticOdds-unmapped event.
                prices = await this.pinnacle.fetchMatchPrices(source.titan_id);
                if (source.titan_reversed) prices = this.reversePinnaclePrices(prices);
              } else {
                prices = [];
              }
            }
            this.pinnacleDetail.set(m.pinnacleMatchId, { at: Date.now(), prices });
            fetched++;
          } catch (err) {
            failed++;
            log("pinnacle_detail_error", { pinnacleMatchId: m.pinnacleMatchId, error: (err as Error).message });
            prices = [];
          }
        }
        if (prices.length) {
          rows++;
          rawDb.prepare("DELETE FROM odds_latest WHERE match_id=? AND provider='pinnacle'").run(m.id);
          this.persistPrices(m.id, "pinnacle", prices, Date.now(), m.kickoffUtc);
        }

        if (!DEMO && source?.titan_id) {
          const cachedCrown = this.crownDetail.get(source.titan_id);
          let crownPrices =
            !bypassCache && cachedCrown && Date.now() - cachedCrown.at < ttl ? cachedCrown.prices : null;
          let crownObservedNow = false;
          if (!crownPrices) {
            crownObservedNow = true;
            try {
              crownPrices = await this.pinnacle.fetchCrownMatchPrices(source.titan_id);
              if (source.titan_reversed) {
                crownPrices = crownPrices.map((p) =>
                  p.market === "AH"
                    ? {
                        ...p,
                        lineValue: p.lineValue === null ? null : -p.lineValue,
                        selection: p.selection === "H" ? "A" : p.selection === "A" ? "H" : p.selection,
                      }
                    : p.market === "1X2"
                      ? { ...p, selection: p.selection === "H" ? "A" : p.selection === "A" ? "H" : p.selection }
                      : p,
                );
              }
              this.crownDetail.set(source.titan_id, { at: Date.now(), prices: crownPrices });
            } catch (err) {
              log("crown_detail_error", { titanId: source.titan_id, error: (err as Error).message });
              crownPrices = [];
            }
          }
          // A cache hit is not evidence that the upstream Crown stream is
          // currently reachable. Only a real request may open/close the gate.
          if (crownObservedNow) {
            this.crownFeedByMatch.set(m.id, {
              observedAt: Date.now(),
              available: crownPrices.length > 0,
              rowCount: crownPrices.length,
            });
          }
          if (crownPrices.length) {
            rawDb.prepare("DELETE FROM odds_latest WHERE match_id=? AND provider='crown'").run(m.id);
            this.persistPrices(m.id, "crown", crownPrices, Date.now());
          }
        }
      }
    });
    await Promise.all(workers);
    this.pinnacleRowsSeen = rows;
    try {
      const prealerts = unsentOuPrealerts(targets.map((target) => target.id));
      const sent = await notifyOuPrealerts(prealerts);
      if (sent) log("telegram_ou_t30_prealerts", { detected: prealerts.length, sent });
    } catch (err) {
      log("telegram_ou_t30_prealert_error", { error: (err as Error).message });
    }
    try {
      const signals = unsentOuSignals(targets.map((target) => target.id));
      const sent = await notifyOuSignals(signals);
      if (sent) log("telegram_ou_signals", { detected: signals.length, sent });
    } catch (err) {
      log("telegram_ou_signal_error", { error: (err as Error).message });
    }
    return { fetched, failed, rows };
  }

  /** Matches eligible for detail polling in the given mode. */
  private detailTargets(mode: RefreshMode, cfg: ScanConfig) {
    const now = Date.now();
    const all = db
      .select()
      .from(matches)
      .all()
      .filter((m) => m.fixtureSource === "hkjc" && m.pinnacleMatchId && m.kickoffUtc > now)
      .sort((a, b) => a.kickoffUtc - b.kickoffUtc);
    if (mode === "full") return all;
    if (mode === "prewarm24h") return all.filter((m) => isPrewarmWindow(m.kickoffUtc, now));
    if (mode === "window") return all.filter((m) => m.kickoffUtc - now <= cfg.windowMinutes * 60_000);
    return [];
  }

  private async runRefresh(mode: RefreshMode): Promise<void> {
    const deadline = Date.now() + MAX_LOOP_MS;
    const now = Date.now();
    const cfg = scanConfig();

    const hkjcOk = await this.refreshHkjc();

    let fixtures = 0;
    let pinnacleOk = false;
    let failed = 0;
    try {
      fixtures = await this.refreshPinnacleFixtures();
      pinnacleOk = fixtures > 0;
      if (mode !== "lightweight") {
        const targets = this.detailTargets(mode, cfg);
        const res = await this.pollPinnacleDetail(targets, deadline, mode === "window");
        failed = res.failed;
        pinnacleOk = pinnacleOk && (targets.length === 0 || res.rows > 0);
        log("pinnacle_detail_scan", { mode, targets: targets.length, ...res });
      }
      this.setHealth("pinnacle", {
        ok: pinnacleOk,
        itemCount: fixtures,
        error: pinnacleOk
          ? null
          : `未能從 Pinnacle 來源取得資料（賽程 ${fixtures} 場、明細失敗 ${failed} 次）`,
        mode: DEMO ? "demo" : pinnacleOk ? "live" : "degraded",
      });
    } catch (err) {
      const message = (err as Error).message;
      this.setHealth("pinnacle", { ok: false, error: message });
      log("pinnacle_error", { error: message });
    }

    const dash = this.rememberDashboard(this.buildDashboardData());
    this.recordOpportunities(dash, now);
    await this.settleDue(false);
    pruneSnapshots(now);

    if (hkjcOk) {
      this.lastGoodAt = Date.now();
      setState("lastGoodAt", String(this.lastGoodAt));
    }
    this.recomputeDegradedReason();
  }

  private recomputeDegradedReason(): void {
    const health = db.select().from(providerHealth).all();
    const bad = health.filter((h) => !h.ok);
    const src = this.pinnacleSourceStatus();
    const srcNote = src.warnings.length ? `（Pinnacle 來源提示：${src.warnings[src.warnings.length - 1]}）` : "";
    this.degradedReason = DEMO
      ? "示範資料模式（DEMO）：畫面數字為樣本，並非真實賠率。"
      : bad.length
        ? `${bad.map((b) => (b.provider === "hkjc" ? "馬會" : "平博（Pinnacle）")).join("、")} 資料來源暫時無法連接（${bad[0].lastError ?? "未知錯誤"}），現時顯示最後一次成功取得的快照。${srcNote}`
        : null;
  }

  /* ------------------------ dense pre-kickoff scan ---------------------- */

  scanConfigInfo(): StatusResponse["scan"] {
    const cfg = scanConfig();
    const target = simulationTarget();
    const simulationBetCount = db
      .select()
      .from(simulationBets)
      .where(eq(simulationBets.excludedFromStats, 0))
      .all().length;
    return {
      ...cfg,
      scheduleConfigured: autoScanEnabled(),
      simulationTarget: target,
      simulationBets: simulationBetCount,
      simulationTargetReached: simulationTargetReached(simulationBetCount, target),
      lastScan: this.lastScan,
    };
  }

  /** Lightweight candidate list for the window scan: fixtures + mapping only. */
  private async loadScanCandidates(): Promise<ScanCandidate[]> {
    await this.refreshHkjc();
    await this.refreshPinnacleFixtures();
    return this.scanCandidates();
  }

  /**
   * Keep in-window matches available after a simulation. EV placement still
   * enforces one bet per match, while direct/synthetic locks may add distinct
   * structures subject to the per-Crown-selection HK$5,000 exposure limit.
   */
  private scanCandidates(): ScanCandidate[] {
    return db
      .select()
      .from(matches)
      .all()
      .filter((m) => m.fixtureSource === "hkjc")
      .map((m) => ({
        matchId: m.id,
        matchLabel: `${m.homeTeam} vs ${m.awayTeam}`,
        kickoffUtc: m.kickoffUtc,
        inplay: !!m.inplay,
        status: m.status,
        pinnacleMatchId: m.pinnacleMatchId,
      }));
  }

  /** One dense pass: refresh HKJC (1 call) + Pinnacle detail for the window only. */
  private async densePass(events: ScanCandidate[]): Promise<{ detailCalls: number; newOpportunityKeys: string[] }> {
    await this.refreshHkjc();
    const res = await this.pollPinnacleDetail(
      events.map((e) => ({ id: e.matchId, pinnacleMatchId: e.pinnacleMatchId, kickoffUtc: e.kickoffUtc })),
      Date.now() + MAX_LOOP_MS,
      true,
    );
    const scannedMatchIds = new Set(events.map((e) => e.matchId));
    const initialAt = Date.now();
    this.dashboardCache = null;
    const initialDash = this.rememberDashboard(this.buildDashboardData());
    const initialKeys = this.simulationCandidateKeys(initialDash, initialAt, scannedMatchIds);

    // A first-pass signal is never executable. Re-fetch HKJC independently,
    // rebuild every calculation from the replacement snapshot, and retain only
    // identical economic opportunities that still qualify.
    let verifiedDash = initialDash;
    let allowedKeys = new Set<string>();
    if (initialKeys.size) {
      const hkjcVerified = await this.refreshHkjc();
      if (hkjcVerified) {
        const verifiedAt = Date.now();
        verifiedDash = this.rememberDashboard(this.buildDashboardData());
        const secondKeys = this.simulationCandidateKeys(verifiedDash, verifiedAt, scannedMatchIds);
        allowedKeys = confirmedOpportunityKeys(initialKeys, secondKeys);
        log("execution_recheck", {
          initial: initialKeys.size,
          verified: allowedKeys.size,
          rejected: initialKeys.size - allowedKeys.size,
        });
      } else {
        log("execution_recheck", {
          initial: initialKeys.size,
          verified: 0,
          rejected: initialKeys.size,
          reason: "hkjc_refresh_failed",
        });
      }
    }
    const now = Date.now();
    this.recordOpportunities(verifiedDash, now);
    // Simulation purchases are exclusive to this dense-scan path and to the
    // events selected for this pass. General/manual refreshes never buy.
    this.placeSimulations(verifiedDash, now, scannedMatchIds, allowedKeys);
    this.recomputeDegradedReason();
    // Only a newly created simulation ends the session. Newly detected
    // opportunities without an insert must continue to be re-checked every
    // 30 seconds until kickoff. Future ticks may revisit a match to find a
    // distinct direct/synthetic lock structure.
    const eventIds = new Set(events.map((e) => e.matchId));
    const newBetKeys = db
      .select()
      .from(simulationBets)
      .where(eq(simulationBets.excludedFromStats, 0))
      .all()
      .filter((b) => eventIds.has(b.matchId) && b.placedAt >= now)
      .map((b) => `bet|${b.uniqueKey}`);
    return { detailCalls: res.fetched, newOpportunityKeys: [...new Set(newBetKeys)] };
  }

  /**
   * HKJC-canonical fixtures whose current pre-kickoff milestone still lacks a
   * complete Pinnacle AH or OU pair. Missing/partial checkpoints remain
   * eligible on later ticks; already frozen pairs and post-kickoff fixtures do
   * not consume detail-call budget.
   */
  private researchTimelinePinnacleTargets(now: number): Array<{
    id: string;
    pinnacleMatchId: string;
    kickoffUtc: number;
  }> {
    const completePairs = new Set(
      (rawDb.prepare(
        `SELECT DISTINCT match_id,stage,market
           FROM (
             SELECT match_id,stage,market,line_key
               FROM research_timeline_snapshots
              WHERE provider='pinnacle' AND market IN ('AH','OU')
              GROUP BY match_id,stage,market,line_key
             HAVING COUNT(DISTINCT selection)>=2
           )`,
      ).all() as Array<{ match_id: string; stage: string; market: "AH" | "OU" }>)
        .map((row) => `${row.match_id}:${row.stage}:${row.market}`),
    );
    const priority = { T5: 0, T15: 1, T30: 2 } as const;
    return db
      .select()
      .from(matches)
      .all()
      .flatMap((match) => {
        if (
          match.fixtureSource !== "hkjc"
          || !match.pinnacleMatchId
          || match.inplay
          || STARTED_MATCH_STATUS.test(match.status ?? "")
        ) return [];
        const stage = researchStageFor(match.kickoffUtc, now);
        if (!stage) return [];
        const ahComplete = completePairs.has(`${match.id}:${stage}:AH`);
        const ouComplete = completePairs.has(`${match.id}:${stage}:OU`);
        return ahComplete && ouComplete
          ? []
          : [{
              id: match.id,
              pinnacleMatchId: match.pinnacleMatchId,
              kickoffUtc: match.kickoffUtc,
              stage,
            }];
      })
      .sort((a, b) => priority[a.stage] - priority[b.stage] || a.kickoffUtc - b.kickoffUtc)
      .slice(0, MAX_RESEARCH_TIMELINE_DETAIL_TARGETS)
      .map(({ stage: _stage, ...target }) => target);
  }

  /** Candidate keys that currently pass every pre-bet rule except re-confirmation. */
  private simulationCandidateKeys(
    dash: DashboardResponse,
    now: number,
    scannedMatchIds: ReadonlySet<string>,
  ): Set<string> {
    const windowMinutes = scanConfig().windowMinutes;
    const inWindow = (matchId: string, kickoffUtc: number) =>
      scannedMatchIds.has(matchId)
      && isSimulationPurchaseWindow(kickoffUtc, now, windowMinutes);
    return new Set([
      ...dash.arbs
        .filter((op) => op.market !== "COU" && inWindow(op.matchId, op.kickoffUtc))
        .map((op) => op.key),
      ...dash.ev
        .filter((op) =>
          (op.market === "AH" || op.market === "OU" || op.market === "COU")
          && isSafe(op)
          && op.edge >= EV_THRESHOLD
          && inWindow(op.matchId, op.kickoffUtc))
        .map((op) => op.key),
      ...dash.synthetics
        .filter((op) => op.isArb && inWindow(op.matchId, op.kickoffUtc))
        .map((op) => op.key),
    ]);
  }

  /**
   * Trigger one dense pre-kickoff window scan. Safe to call from a CLI, an HTTP
   * helper endpoint, or an external scheduler. This method creates no schedule.
   */
  async runScan(): Promise<ScanOutcome> {
    if (this.scanning) {
      const cfg = scanConfig();
      const at = Date.now();
      return {
        result: "ERROR",
        startedAt: at,
        finishedAt: at,
        runtimeMs: 0,
        windowMinutes: cfg.windowMinutes,
        intervalSec: cfg.intervalSec,
        maxRuntimeSec: cfg.maxRuntimeSec,
        selected: [],
        passes: 0,
        detailCalls: 0,
        newOpportunityKeys: [],
        message: "已有掃描進行中，本次請求已略過。",
      };
    }
    this.scanning = true;
    try {
      const outcome = await runWindowScan({
        now: () => Date.now(),
        loadCandidates: (() => {
          let prepared = false;
          return async () => {
            if (!prepared) {
              prepared = true;
              return this.loadScanCandidates();
            }
            return this.scanCandidates();
          };
        })(),
        pollPass: (events) => this.densePass(events),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        config: scanConfig(),
      });
      this.lastScan = outcome;
      setState("lastScan", JSON.stringify(outcome));
      if (outcome.newOpportunityKeys.length && t30AlertEnabled()) {
        try {
          const sent = await notifySimulationBets(outcome.newOpportunityKeys);
          if (sent) log("telegram_notifications", { sent });
        } catch (err) {
          log("telegram_notification_error", { error: (err as Error).message });
        }
      }
      await this.settleDue(false);
      log("window_scan", {
        result: outcome.result,
        selected: outcome.selected.length,
        passes: outcome.passes,
        detailCalls: outcome.detailCalls,
        runtimeMs: outcome.runtimeMs,
      });
      return outcome;
    } finally {
      this.scanning = false;
    }
  }

  /** Events currently inside the dense window (used by the helper endpoint). */
  windowPreview(): ReturnType<typeof selectWindowEvents> {
    const cfg = scanConfig();
    return selectWindowEvents(this.scanCandidates(), Date.now(), cfg);
  }

  /**
   * Lightweight timeline preparation for the primary HKJC/Pinnacle paths.
   * Crown-only research detail is intentionally not scheduled here: the window
   * scanner must never wait behind a separate provider's research backlog.
   */
  async runResearchTimelineTick(): Promise<{ selected: number; detailCalls: number }> {
    await this.refreshHkjc();
    await this.refreshPinnacleFixtures();
    // This pass is deliberately independent of the dense execution scanner.
    // It selects only the current, still-pre-kickoff milestone and bypasses the
    // normal detail cache so a T30/T15/T5 checkpoint cannot inherit an earlier
    // observation. INSERT OR IGNORE in captureResearchTimelinePrices preserves
    // the first genuine quote for every checkpoint key across retries.
    const checkpointNow = Date.now();
    const targets = this.researchTimelinePinnacleTargets(checkpointNow);
    let detailCalls = 0;
    if (targets.length) {
      const detail = await this.pollPinnacleDetail(
        targets,
        Date.now() + RESEARCH_TIMELINE_DETAIL_LOOP_MS,
        true,
      );
      detailCalls = detail.fetched;
      log("research_timeline_pinnacle_detail", {
        selected: targets.length,
        ...detail,
      });
    }
    // The complete same-day Titan feed changes much faster than future-day
    // schedules. Refresh it independently on every research pass instead of
    // leaving a failed boot-time response stuck behind the 10-minute shared
    // fixture cache. A failed refresh never deletes the last good universe.
    if (!DEMO && this.fixtureCache) {
      try {
        const live = await this.pinnacle.fetchTitanLiveFixtures([0, 1, 2, 3, 4]);
        const liveIds = new Set(live.map((fixture) => fixture.providerMatchId));
        const merged = new Map(
          [...this.fixtureCache.titan, ...live].map((fixture) => [fixture.providerMatchId, fixture]),
        );
        this.fixtureCache.titan = [...merged.values()];
        this.lastTitanLiveFixtureIds = liveIds;
        log("titan_live_fixture_refresh", {
          liveFixtures: live.length,
          mergedFixtures: this.fixtureCache.titan.length,
        });
      } catch (err) {
        log("titan_live_fixture_error", {
          error: (err as Error).message,
          retainedLiveFixtures: this.lastTitanLiveFixtureIds.size,
          retainedMergedFixtures: this.fixtureCache.titan.length,
        });
      }
    }
    // Pinnacle-only research runs after the shared fixture cache is warm.
    // It writes only research-timeline rows and never touches HKJC execution
    // or the T-30 window scanner.
    try {
      await this.refreshPinnacleOnlyResearch();
    } catch (err) {
      log("pinnacle_only_research_error", { error: (err as Error).message });
    }
    return { selected: targets.length, detailCalls };
  }

  private persistPrices(
    matchId: string,
    provider: "hkjc" | "pinnacle" | "crown",
    prices: ProviderPrice[],
    now: number,
    kickoffUtc?: number,
  ): void {
    const insertSnap = rawDb.prepare(
      "INSERT INTO odds_snapshots(match_id,provider,market,line_key,selection,decimal_odds,source_updated_at,fetched_at,phase) VALUES(?,?,?,?,?,?,?,?,'prematch')",
    );
    const upsertLine = rawDb.prepare(
      "INSERT INTO market_lines(match_id,market,line_key,line_value,is_main,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(match_id,market,line_key) DO UPDATE SET is_main=excluded.is_main, updated_at=excluded.updated_at",
    );
    const getLatest = rawDb.prepare("SELECT decimal_odds FROM odds_latest WHERE key=?");
    const upsertLatest = rawDb.prepare(
      `INSERT INTO odds_latest(key,match_id,provider,market,line_key,selection,decimal_odds,prev_decimal_odds,source_updated_at,fetched_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET prev_decimal_odds=excluded.prev_decimal_odds,
         decimal_odds=excluded.decimal_odds, source_updated_at=excluded.source_updated_at, fetched_at=excluded.fetched_at`,
    );
    for (const p of prices) {
      const lineKey = lineKeyOf(p.market, p.lineValue);
      upsertLine.run(matchId, p.market, lineKey, p.lineValue, p.isMain ? 1 : 0, now);
      const key = `${matchId}|${provider}|${p.market}|${lineKey}|${p.selection}`;
      const prev = (getLatest.get(key) as { decimal_odds: number } | undefined)?.decimal_odds ?? null;
      if (prev === null || Math.abs(prev - p.decimalOdds) > 1e-9) {
        insertSnap.run(matchId, provider, p.market, lineKey, p.selection, p.decimalOdds, p.sourceUpdatedAt ?? null, now);
      }
      upsertLatest.run(key, matchId, provider, p.market, lineKey, p.selection, p.decimalOdds, prev, p.sourceUpdatedAt ?? null, now);
    }
    if (kickoffUtc !== undefined) {
      captureResearchTimelinePrices(matchId, provider, prices, kickoffUtc, now);
    }
  }

  /* ----------------------------- dashboard ------------------------------ */

  /** Return the latest completed read-only board without recomputing it per request. */
  dashboardData(): DashboardResponse {
    if (this.dashboardCache) return this.dashboardCache;
    return this.rememberDashboard(this.buildDashboardData());
  }

  private rememberDashboard(dashboard: DashboardResponse): DashboardResponse {
    this.dashboardCache = dashboard;
    return dashboard;
  }

  buildDashboardData(): DashboardResponse {
    const now = Date.now();
    const allMatches = db
      .select()
      .from(matches)
      .all()
      .filter((m) => m.fixtureSource === "hkjc" && m.kickoffUtc > now - 30 * 60_000)
      .sort((a, b) => a.kickoffUtc - b.kickoffUtc);
    // Only active dashboard fixtures need prices/lines.  Reading the complete
    // retained history on every 20-second frontend poll caused avoidable work
    // during an in-flight scan and enlarged the event-loop stall window.
    const matchIds = allMatches.map((match) => match.id);
    const mappings = new Map(
      (matchIds.length ? db.select().from(matchMapping).where(inArray(matchMapping.matchId, matchIds)).all() : [])
        .map((row) => [row.matchId, row]),
    );
    const latestRows = matchIds.length
      ? db.select().from(oddsLatest).where(inArray(oddsLatest.matchId, matchIds)).all()
      : [];
    const byMatch = new Map<string, typeof latestRows>();
    for (const r of latestRows) {
      const list = byMatch.get(r.matchId) ?? [];
      list.push(r);
      byMatch.set(r.matchId, list);
    }
    const linesRows = matchIds.length
      ? db.select().from(marketLines).where(inArray(marketLines.matchId, matchIds)).all()
      : [];
    const linesByMatch = new Map<string, typeof linesRows>();
    for (const r of linesRows) {
      const list = linesByMatch.get(r.matchId) ?? [];
      list.push(r);
      linesByMatch.set(r.matchId, list);
    }

    const arbs: ArbOpportunity[] = [];
    const evs: EvOpportunity[] = [];
    const synthetics: SyntheticOpportunity[] = [];
    const rows: MatchRow[] = [];

    for (const m of allMatches) {
      const mapping = mappings.get(m.id);
      const prices = byMatch.get(m.id) ?? [];
      const historicalCrownRows = prices.some((price) => price.provider === "crown");
      const crownPolicy = crownExecutionPolicy({
        now,
        kickoffUtc: m.kickoffUtc,
        observation: this.crownFeedByMatch.get(m.id),
        hasHistoricalCrownRows: historicalCrownRows,
      });
      const crownExecutionEnabled = crownPolicy.executionEnabled;
      const matchLabel = `${m.homeTeam} vs ${m.awayTeam}`;
      const directEvs: EvOpportunity[] = [];
      const cell = (provider: string, market: Market, lineKey: string, selection: Selection): PriceCell | undefined => {
        const requestedLine = Number(lineKey);
        const r = prices.find(
          (p) =>
            p.provider === provider &&
            p.market === market &&
            p.selection === selection &&
            (market === "AH"
              ? Number.isFinite(requestedLine) &&
                isSameHandicapRoad(Number(p.lineKey), requestedLine)
              : p.lineKey === lineKey),
        );
        if (!r) return undefined;
        return {
          decimalOdds: r.decimalOdds,
          prevDecimalOdds: r.prevDecimalOdds,
          fetchedAt: r.fetchedAt,
          sourceUpdatedAt: r.sourceUpdatedAt,
          ageSec: Math.round((now - r.fetchedAt) / 1000),
          stale: now - r.fetchedAt > STALE_MS,
        };
      };

      const lineRows: LineRow[] = [];
      const declared = (linesByMatch.get(m.id) ?? []).sort(
        (a, b) => a.market.localeCompare(b.market) || (a.lineValue ?? 0) - (b.lineValue ?? 0),
      );
      for (const l of declared) {
        const market = l.market as Market;
        const sels: Selection[] = market === "1X2" ? ["H", "D", "A"] : market === "AH" ? ["H", "A"] : ["O", "U"];
        const hk: Partial<Record<Selection, PriceCell>> = {};
        const pin: Partial<Record<Selection, PriceCell>> = {};
        const crown: Partial<Record<Selection, PriceCell>> = {};
        for (const s of sels) {
          const a = cell("hkjc", market, l.lineKey, s);
          const b = cell("pinnacle", market, l.lineKey, s);
          const c = cell("crown", market, l.lineKey, s);
          if (a) hk[s] = a;
          if (b) pin[s] = b;
          if (c) crown[s] = c;
        }
        const hasHk = Object.keys(hk).length === sels.length;
        const hasPin = Object.keys(pin).length === sels.length;
        const hasCrown = Object.keys(crown).length === sels.length;
        const hasFreshHk = hasHk && sels.every((s) => isHkjcExecutionQuoteFresh(hk[s]!, now));
        const hasFreshPin = hasPin && sels.every((s) => !pin[s]!.stale);
        const hasFreshCrown = hasCrown && sels.every((s) => !crown[s]!.stale);
        const exactLine = hasHk && hasPin;
        const deltas: Partial<Record<Selection, number>> = {};
        for (const s of sels) {
          if (hk[s] && pin[s]) deltas[s] = Math.round((hk[s]!.decimalOdds - pin[s]!.decimalOdds) * 1000) / 1000;
        }

        let totalProbability: number | null = null;
        let bestQ: number | null = null;
        let arb: ArbOpportunity | null = null;

        if (market === "1X2") {
          if (hasFreshPin) {
            totalProbability = sels.reduce((acc, s) => acc + 1 / pin[s]!.decimalOdds, 0);
          }
          if (crownExecutionEnabled && hasFreshHk && hasFreshCrown) {
            bestQ = sels.reduce((acc, s) => acc + 1 / Math.max(hk[s]!.decimalOdds, crown[s]!.decimalOdds), 0);
            arb = findThreeWayArb({
              matchId: m.id,
              matchLabel,
              league: m.league,
              kickoffUtc: m.kickoffUtc,
              hkjc: { H: hk.H?.decimalOdds, D: hk.D?.decimalOdds, A: hk.A?.decimalOdds },
              crown: { H: crown.H?.decimalOdds, D: crown.D?.decimalOdds, A: crown.A?.decimalOdds },
            });
          }
        } else {
          const [s1, s2] = sels;
          if (hasFreshPin) totalProbability = 1 / pin[s1]!.decimalOdds + 1 / pin[s2]!.decimalOdds;
          // COU is PinnAPI × HKJC EV only. Crown has neither a valid corner
          // source nor a permitted arb/synthetic route.
          if (crownExecutionEnabled && market !== "COU" && hasFreshHk && hasFreshCrown) {
            const q1 = 1 / hk[s1]!.decimalOdds + 1 / crown[s2]!.decimalOdds;
            const q2 = 1 / hk[s2]!.decimalOdds + 1 / crown[s1]!.decimalOdds;
            bestQ = Math.min(q1, q2);
            const base = {
              matchId: m.id,
              matchLabel,
              league: m.league,
              kickoffUtc: m.kickoffUtc,
              market: market as "AH" | "OU",
              lineKey: l.lineKey,
              lineDisplay: formatLine(market, l.lineValue),
            };
            arb =
              findTwoWayArb({ ...base, hkjc: { selection: s1, decimalOdds: hk[s1]!.decimalOdds }, crown: { selection: s2, decimalOdds: crown[s2]!.decimalOdds } }) ??
              findTwoWayArb({ ...base, hkjc: { selection: s2, decimalOdds: hk[s2]!.decimalOdds }, crown: { selection: s1, decimalOdds: crown[s1]!.decimalOdds } });
          }
        }

        let lineEv: EvOpportunity[] = [];
        // COU is accepted only where both books quote the complete, fresh
        // two-sided exact line. Other markets retain their existing behavior.
        const evComparable =
          hasFreshPin
          && Object.keys(hk).length > 0
          && (market !== "COU" || (exactLine && hasFreshHk));
        if (crownExecutionEnabled && evComparable) {
          lineEv = evaluateEv({
            matchId: m.id,
            matchLabel,
            league: m.league,
            kickoffUtc: m.kickoffUtc,
            market,
            lineKey: l.lineKey,
            lineDisplay: formatLine(market, l.lineValue),
            pinnacle: sels
              .filter((s) => pin[s])
              .map((s) => ({
                selection: s,
                decimalOdds: pin[s]!.decimalOdds,
                fetchedAt: pin[s]!.fetchedAt,
              })),
            hkjc: sels.filter((s) => hk[s]).map((s) => ({ selection: s, decimalOdds: hk[s]!.decimalOdds, fetchedAt: hk[s]!.fetchedAt })),
            now,
            mappingConfidence: mapping?.confidence ?? 0,
          });
        }
        if (arb) arbs.push(arb);
        directEvs.push(...lineEv);

        lineRows.push({
          matchId: m.id,
          market,
          lineKey: l.lineKey,
          lineValue: l.lineValue,
          lineDisplay: formatLine(market, l.lineValue),
          isMain: !!l.isMain,
          hkjc: hk,
          pinnacle: pin,
          exactLine,
          totalProbability: totalProbability === null ? null : Math.round(totalProbability * 1e6) / 1e6,
          bestQ: bestQ === null ? null : Math.round(bestQ * 1e6) / 1e6,
          deltas,
          arb,
          ev: lineEv.length ? lineEv : null,
        });
      }

      /* synthetic quotes from HKJC 1X2 vs Crown handicap singles */
      const rawSyn = crownExecutionEnabled
        ? this.buildSyntheticsFor(m.id, matchLabel, m.league, m.kickoffUtc, prices, now)
        : [];
      // Standalone 1X2 remains visible for observation only. An AH/OU target
      // may still use an economically equivalent HKJC 1X2 combination when
      // that route offers the better return.
      const syntheticEvs = crownExecutionEnabled
        ? this.buildSyntheticEvsFor(
            m.id,
            matchLabel,
            m.league,
            m.kickoffUtc,
            prices,
            mapping?.confidence ?? 0,
            now,
          )
        : [];
      const gated = enforceCrownExecutionGate(crownPolicy, {
        arbs: arbs.filter((op) => op.matchId === m.id),
        ev: selectBestEv([...directEvs, ...syntheticEvs]),
        synthetics: rawSyn,
      });
      // Remove any match-local result that could have been appended before the
      // final gate, then append only the sanitized execution collections.
      for (let i = arbs.length - 1; i >= 0; i--) {
        if (arbs[i].matchId === m.id) arbs.splice(i, 1);
      }
      arbs.push(...gated.arbs);
      const syn = gated.synthetics;
      synthetics.push(...syn);
      const matchEvs = gated.ev;
      evs.push(...matchEvs);
      for (const line of lineRows) {
        const selected = matchEvs.filter(
          (e) =>
            e.market === line.market &&
            e.selection &&
            (e.market === "AH"
              ? isSameHandicapRoad(Number(e.lineKey), Number(line.lineKey))
              : e.lineKey === line.lineKey),
        );
        line.ev = selected.length ? selected : null;
      }

      rows.push({
        id: m.id,
        league: m.league,
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        kickoffUtc: m.kickoffUtc,
        minutesToKickoff: Math.round((m.kickoffUtc - now) / 60_000),
        matched: !!m.pinnacleMatchId,
        pinnacleMatchId: m.pinnacleMatchId,
        mappingConfidence: mapping?.confidence ?? 0,
        unmatchedReason: mapping?.unmatchedReason ?? null,
        lines: lineRows,
        hasArb: lineRows.some((r) => !!r.arb),
        hasEv: matchEvs.length > 0,
        hasSynthetic: syn.some((s) => s.isArb),
        synthetics: syn,
        crownExecutionMode: crownPolicy.mode,
        crownExecutionReason: crownPolicy.reason,
        crownPredictionFallback: crownPolicy.predictionFallbackAllowed,
      });
    }

    const leagues = Array.from(new Set(rows.map((r) => r.league))).sort();
    return { status: this.buildStatus(rows, arbs, evs, synthetics), matches: rows, arbs, ev: evs, synthetics, leagues };
  }

  private buildSyntheticEvsFor(
    matchId: string,
    matchLabel: string,
    league: string,
    kickoffUtc: number,
    prices: Array<{
      provider: string;
      market: string;
      lineKey: string;
      selection: string;
      decimalOdds: number;
      fetchedAt: number;
      sourceUpdatedAt?: number | null;
    }>,
    mappingConfidence: number,
    now: number,
  ): EvOpportunity[] {
    const hk1x2 = (selection: Selection) =>
      prices.find((p) => p.provider === "hkjc" && p.market === "1X2" && p.selection === selection);
    const home = hk1x2("H");
    const draw = hk1x2("D");
    const away = hk1x2("A");
    if (!home || !draw || !away) return [];

    const out: EvOpportunity[] = [];
    for (const side of ["away", "home"] as SynSide[]) {
      const selection: Selection = side === "away" ? "A" : "H";
      const officialPlusLine = lineKeyOf("AH", side === "away" ? -1 : 1);
      const officialPlus = prices.find(
        (p) =>
          p.provider === "hkjc" &&
          p.market === "AH" &&
          p.lineKey === officialPlusLine &&
          p.selection === selection,
      );
      const officialMinusLine = lineKeyOf("AH", side === "away" ? 1 : -1);
      const officialMinus = prices.find(
        (p) =>
          p.provider === "hkjc" &&
          p.market === "AH" &&
          p.lineKey === officialMinusLine &&
          p.selection === selection,
      );
      for (const target of EV_SYNTHETIC_TARGETS) {
        const homeHandicap = side === "away" ? -target : target;
        const lineKey = lineKeyOf("AH", homeHandicap);
        const quote = buildSynthetic(
          side,
          target,
          {
            oddsHome: home.decimalOdds,
            oddsDraw: draw.decimalOdds,
            oddsAway: away.decimalOdds,
            official1: officialPlus?.decimalOdds ?? null,
            officialMinus1: officialMinus?.decimalOdds ?? null,
          },
          HKJC_FIXED_STAKE,
        );
        if (!quote) continue;

        const pin = prices.filter(
          (p) =>
            p.provider === "pinnacle" &&
            p.market === "AH" &&
            isSameHandicapRoad(Number(p.lineKey), homeHandicap) &&
            (p.selection === "H" || p.selection === "A"),
        );
        const pinHome = pin.find((p) => p.selection === "H");
        const pinAway = pin.find((p) => p.selection === "A");
        if (!pinHome || !pinAway) continue;

        const usedRows = quote.components
          .map((component) =>
            prices.find(
              (price) =>
                price.provider === "hkjc" &&
                price.market === component.market &&
                price.lineKey === component.lineKey &&
                price.selection === component.selection,
            ),
          )
          .filter((price): price is NonNullable<typeof price> => !!price);
        if (
          usedRows.length !== quote.components.length ||
          usedRows.some((price) => !isHkjcExecutionQuoteFresh(price, now))
        ) {
          continue;
        }
        const evaluated = evaluateEv({
          matchId,
          matchLabel,
          league,
          kickoffUtc,
          market: "AH",
          lineKey,
          lineDisplay: quote.lineDisplay,
          pinnacle: [
            { selection: "H", decimalOdds: pinHome.decimalOdds, fetchedAt: pinHome.fetchedAt },
            { selection: "A", decimalOdds: pinAway.decimalOdds, fetchedAt: pinAway.fetchedAt },
          ],
          hkjc: [
            {
              selection,
              decimalOdds: quote.odds,
              fetchedAt: Math.min(...usedRows.map((p) => p.fetchedAt)),
            },
          ],
          now,
          mappingConfidence,
        });
        for (const e of evaluated) {
          out.push({
            ...e,
            synthetic: true,
            formula: quote.formula,
            components: quote.components,
          });
        }
      }
    }
    return out;
  }

  private buildSyntheticsFor(
    matchId: string,
    matchLabel: string,
    league: string,
    kickoffUtc: number,
    prices: Array<{
      provider: string;
      market: string;
      lineKey: string;
      selection: string;
      decimalOdds: number;
      fetchedAt: number;
      sourceUpdatedAt?: number | null;
    }>,
    now: number,
  ): SyntheticOpportunity[] {
    const hk1x2 = (sel: string) =>
      prices.find((p) => p.provider === "hkjc" && p.market === "1X2" && p.selection === sel);
    const home = hk1x2("H");
    const draw = hk1x2("D");
    const away = hk1x2("A");
    if (!home || !draw || !away) return [];
    const oddsHome = home.decimalOdds;
    const oddsDraw = draw.decimalOdds;
    const oddsAway = away.decimalOdds;
    const officialFor = (side: SynSide) => {
      const lineKey = (side === "away" ? -1 : 1).toFixed(2);
      const sel = side === "away" ? "A" : "H";
      return prices.find(
        (p) => p.provider === "hkjc" && p.market === "AH" && p.lineKey === lineKey && p.selection === sel,
      );
    };
    const out: SyntheticOpportunity[] = [];
    for (const side of ["away", "home"] as SynSide[]) {
      const officialRow = officialFor(side);
      const official1 = officialRow?.decimalOdds ?? null;
      for (const target of SYNTHETIC_TARGETS) {
        // Crown must quote the mirrored opposite leg on the exact same line.
        const crownHomeHandicap = side === "away" ? -target : target;
        const crownSelection: Selection = side === "away" ? "H" : "A";
        const crownRow = prices.find(
          (p) =>
            p.provider === "crown" &&
            p.market === "AH" &&
            p.lineKey === crownHomeHandicap.toFixed(2) &&
            p.selection === crownSelection,
        );
        if (!crownRow || now - crownRow.fetchedAt > STALE_MS) continue;
        const crownOdds = crownRow.decimalOdds;
        // Crown leg anchored at HK$5,000 -> target payout -> synthetic outlay.
        const payout = CROWN_FIXED_STAKE * crownOdds;
        const probe = buildSynthetic(side, target, { oddsHome, oddsDraw, oddsAway, official1 }, 1000);
        if (!probe) continue;
        const W = payout / probe.odds;
        const quote = buildSynthetic(side, target, { oddsHome, oddsDraw, oddsAway, official1 }, W);
        if (!quote) continue;
        const usedRows = quote.components
          .map((component) =>
            prices.find(
              (price) =>
                price.provider === "hkjc" &&
                price.market === component.market &&
                price.lineKey === component.lineKey &&
                price.selection === component.selection,
            ),
          )
          .filter((price): price is NonNullable<typeof price> => !!price);
        if (
          usedRows.length !== quote.components.length ||
          usedRows.some((price) => !isHkjcExecutionQuoteFresh(price, now))
        ) {
          continue;
        }
        if (!syntheticCoversCrown(quote, crownHomeHandicap, crownSelection)) continue;
        const q = 1 / quote.odds + 1 / crownOdds;
        const totalStake = round2(W + CROWN_FIXED_STAKE);
        const profit = round2(payout - totalStake);
        out.push({
          key: `synth|${matchId}|${side}|${target}`,
          matchId,
          matchLabel,
          league,
          kickoffUtc,
          side,
          targetHandicap: target,
          lineDisplay: quote.lineDisplay,
          syntheticOdds: quote.odds,
          formula: quote.formula,
          components: quote.components,
          crownOdds,
          crownSelection,
          q: Math.round(q * 1e6) / 1e6,
          // Synthetic locks use the same pure lock rule as direct locks.
          // The Pinnacle EV threshold applies only to case2_ev.
          isArb: isArbitrageTotal(q),
          totalStake,
          payout: round2(payout),
          profit,
          roi: totalStake > 0 ? profit / totalStake : 0,
        });
      }
    }
    return out;
  }

  buildStatus(rows: MatchRow[], arbs: ArbOpportunity[], evs: EvOpportunity[], syn: SyntheticOpportunity[]): StatusResponse {
    const health = db.select().from(providerHealth).all();
    const providers: ProviderStatus[] = (["hkjc", "pinnacle"] as const).map((p) => {
      const h = health.find((x) => x.provider === p);
      return {
        provider: p,
        ok: !!h?.ok,
        mode: (h?.mode ?? (DEMO ? "demo" : "degraded")) as ProviderStatus["mode"],
        lastSuccessAt: h?.lastSuccessAt ?? null,
        lastAttemptAt: h?.lastAttemptAt ?? null,
        lastError: h?.lastError ?? null,
        consecutiveFailures: h?.consecutiveFailures ?? 0,
        lastLatencyMs: h?.lastLatencyMs ?? null,
        itemCount: h?.itemCount ?? 0,
      };
    });
    const mode = DEMO ? "demo" : providers.every((p) => p.ok) ? "live" : "degraded";
    return {
      now: Date.now(),
      mode,
      coldStart: this.isColdStart() || this.coldStartStage === "quick",
      coldStartStage: this.coldStartStage,
      refreshing: this.refreshing,
      lastRefreshAt: this.lastRefreshAt,
      lastGoodAt: this.lastGoodAt,
      nextRefreshEligibleAt: this.nextRefreshEligibleAt(),
      degradedReason: this.degradedReason,
      providers,
      pinnacleSource: this.pinnacleSourceStatus(),
      scan: this.scanConfigInfo(),
      counts: {
        matches: rows.length,
        matched: rows.filter((r) => r.matched).length,
        arbs: arbs.length,
        ev: evs.length,
        synthetic: syn.filter((s) => s.isArb).length,
        snapshots: countSnapshots(),
      },
    };
  }

  private pinnacleSourceStatus(): StatusResponse["pinnacleSource"] {
    const titan = this.pinnacle.status();
    const optic = this.optic.status();
    const pinnapi = this.pinnapi.status();
    return {
      strategy: "pinnapi-primary",
      primary: "pinnapi",
      fallback: "opticodds-then-titan007",
      opticOk: optic.ok,
      pinnapiConfigured: pinnapi.configured,
      officialConfigured: titan.officialConfigured,
      lastRowMatchedBy: titan.lastRowMatchedBy,
      lastRowCompanyId: titan.lastRowCompanyId,
      warnings: [...pinnapi.warnings, ...optic.warnings, ...titan.warnings].slice(-5),
    };
  }

  /* -------------------------- opportunity state ------------------------- */

  private recordOpportunities(dash: DashboardResponse, now: number): string[] {
    const existing: DedupeEntry[] = db
      .select()
      .from(opportunities)
      .all()
      .map((r) => ({ key: r.key, firstSeen: r.firstSeen, lastSeen: r.lastSeen, notified: !!r.notified, metric: r.metric, payload: r.payload }));
    const seen = [
      ...dash.arbs.map((a) => ({ key: a.key, metric: a.q, payload: JSON.stringify(a) })),
      ...dash.ev.filter(isSafe).map((e) => ({ key: e.key, metric: e.edge, payload: JSON.stringify(e) })),
      ...dash.synthetics.filter((s) => s.isArb).map((s) => ({ key: s.key, metric: s.q ?? 1, payload: JSON.stringify(s) })),
    ];
    const merged = mergeOpportunityState(existing, seen, now);
    const tx = rawDb.transaction(() => {
      for (const key of merged.expired) rawDb.prepare("DELETE FROM opportunities WHERE key=?").run(key);
      const stmt = rawDb.prepare(
        `INSERT INTO opportunities(key,category,match_id,market,line_key,selection,payload,metric,first_seen,last_seen,notified)
         VALUES(?,?,?,?,?,?,?,?,?,?,0)
         ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, metric=excluded.metric, last_seen=excluded.last_seen`,
      );
      for (const [key, entry] of merged.state) {
        const parts = key.split("|");
        const category = parts[0] === "synth" ? "synth_arb" : parts[0];
        stmt.run(
          key,
          category,
          parts[1] ?? "",
          parts[2] ?? "",
          parts[3] ?? "",
          parts[4] ?? "",
          entry.payload ?? "{}",
          entry.metric,
          entry.firstSeen,
          entry.lastSeen,
        );
      }
    });
    tx();
    if (merged.fresh.length) log("opportunities_new", { count: merged.fresh.length });
    return merged.fresh.map((f) => f.key);
  }

  /* ----------------------------- simulations ---------------------------- */

  private placeSimulations(
    dash: DashboardResponse,
    now: number,
    scannedMatchIds: ReadonlySet<string>,
    confirmedKeys: ReadonlySet<string>,
  ): void {
    const windowMinutes = scanConfig().windowMinutes;
    const target = simulationTarget();
    const activeBets = db
      .select()
      .from(simulationBets)
      .where(eq(simulationBets.excludedFromStats, 0))
      .all();
    const currentBets = activeBets.length;
    const existingBets = activeBets.map((bet) => ({
      matchId: bet.matchId,
      category: bet.category,
    }));
    const crownExposure = rawDb
      .prepare(
        `SELECT b.match_id AS matchId,l.market,l.line_key AS lineKey,l.selection,l.stake
         FROM simulation_legs l
         JOIN simulation_bets b ON b.id=l.bet_id
         WHERE l.provider='crown'`,
      )
      .all() as Array<{ matchId: string; market: string; lineKey: string; selection: string; stake: number }>;
    let remaining = remainingSimulationCapacity(currentBets, target);
    if (remaining <= 0) {
      log("simulation_target_reached", { target, current: currentBets });
      return;
    }
    const eligible = (matchId: string, kickoffUtc: number, category: "case1_arb" | "case2_ev" | "synth_arb") =>
      scannedMatchIds.has(matchId) &&
      isSimulationPurchaseWindow(kickoffUtc, now, windowMinutes) &&
      matchCategoryEligible(existingBets, matchId, category);
    const insertBet = rawDb.prepare(
      `INSERT OR IGNORE INTO simulation_bets(unique_key,category,match_id,market,line_key,selection,match_label,league,kickoff_utc,
        total_stake,expected_payout,expected_profit,roi,ev_pct,q_total,placed_at,notes)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertLeg = rawDb.prepare(
      `INSERT INTO simulation_legs(bet_id,provider,market,line_key,selection,decimal_odds,stake,synthetic,synthetic_detail)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    );
    const tx = rawDb.transaction(() => {
      const verificationNote = executionVerificationNote(now);
      /* 情況一 — arb, Crown fixed 5,000, HKJC back-calculated */
      for (const a of dash.arbs) {
        if (remaining <= 0) break;
        if (!confirmedKeys.has(a.key)) continue;
        if (a.market === "COU") continue;
        if (!eligible(a.matchId, a.kickoffUtc, "case1_arb")) continue;
        const proposedCrown = a.legs
          .filter((leg) => leg.provider === "crown")
          .map((leg) => ({
            matchId: a.matchId,
            market: leg.market,
            lineKey: leg.lineKey,
            selection: leg.selection,
            stake: leg.stake,
          }));
        if (!crownLegsWithinLimit(crownExposure, proposedCrown, CROWN_FIXED_STAKE)) continue;
        const key = `case1_arb|${a.matchId}|${a.lineKey}|${a.market}:${a.legs.map((l) => l.selection).join("")}`;
        const res = insertBet.run(
          key, "case1_arb", a.matchId, a.market, a.lineKey, a.legs[0]?.selection ?? "", a.matchLabel, a.league,
          a.kickoffUtc, a.totalStake, a.payout, a.profit, a.roi, null, a.q, now, verificationNote,
        );
        if (res.changes) {
          remaining--;
          existingBets.push({ matchId: a.matchId, category: "case1_arb" });
          crownExposure.push(...proposedCrown);
          const betId = Number(res.lastInsertRowid);
          for (const l of a.legs) insertLeg.run(betId, l.provider, l.market, l.lineKey, l.selection, l.decimalOdds, l.stake, 0, null);
        }
      }
      /* 情況二 — AH/OU target, direct or HKJC-equivalent route, fixed 10,000 */
      for (const e of dash.ev) {
        if (remaining <= 0) break;
        if (!confirmedKeys.has(e.key)) continue;
        if (!eligible(e.matchId, e.kickoffUtc, "case2_ev")) continue;
        // Only the target market decides eligibility. Synthetic AH/OU routes
        // and direct exact-line COU EV are valid; 1X2 is observation-only.
        if (e.market !== "AH" && e.market !== "OU" && e.market !== "COU") continue;
        if (!isSafe(e) || e.edge < EV_THRESHOLD) continue;
        const key = `case2_ev|${e.matchId}|${e.lineKey}|${e.market}:${e.selection}`;
        const payout = round2(HKJC_FIXED_STAKE * e.hkjcOdds);
        const res = insertBet.run(
          key, "case2_ev", e.matchId, e.market, e.lineKey, e.selection, e.matchLabel, e.league, e.kickoffUtc,
          HKJC_FIXED_STAKE, payout, round2(HKJC_FIXED_STAKE * e.edge), e.edge, e.edge, null, now,
          verificationNote,
        );
        if (res.changes) {
          remaining--;
          existingBets.push({ matchId: e.matchId, category: "case2_ev" });
          const betId = Number(res.lastInsertRowid);
          if (e.synthetic && e.components?.length) {
            for (const c of e.components) {
              insertLeg.run(
                betId,
                "hkjc",
                c.market,
                c.lineKey,
                c.selection,
                c.decimalOdds,
                c.stake,
                1,
                c.syntheticDetail ?? e.formula ?? "主客和等價 EV",
              );
            }
          } else {
            insertLeg.run(betId, "hkjc", e.market, e.lineKey, e.selection, e.hkjcOdds, HKJC_FIXED_STAKE, 0, null);
          }
        }
      }
      /* 合成賠率 — Crown fixed 5,000, HKJC split by the synthetic formula */
      for (const s of dash.synthetics) {
        if (remaining <= 0) break;
        if (!confirmedKeys.has(s.key)) continue;
        if (!eligible(s.matchId, s.kickoffUtc, "synth_arb")) continue;
        if (!s.isArb || !s.crownOdds || !s.crownSelection) continue;
        const proposedCrown = [{
          matchId: s.matchId,
          market: "AH",
          lineKey: (s.side === "away" ? -s.targetHandicap : s.targetHandicap).toFixed(2),
          selection: s.crownSelection,
          stake: CROWN_FIXED_STAKE,
        }];
        if (!crownLegsWithinLimit(crownExposure, proposedCrown, CROWN_FIXED_STAKE)) continue;
        const key = `synth_arb|${s.matchId}|${s.targetHandicap}|${s.side}`;
        const res = insertBet.run(
          key, "synth_arb", s.matchId, "AH", (s.side === "away" ? -s.targetHandicap : s.targetHandicap).toFixed(2),
          s.side === "away" ? "A" : "H", s.matchLabel, s.league, s.kickoffUtc, s.totalStake, s.payout, s.profit, s.roi,
          null, s.q, now, verificationNote,
        );
        if (res.changes) {
          remaining--;
          existingBets.push({ matchId: s.matchId, category: "synth_arb" });
          crownExposure.push(...proposedCrown);
          const betId = Number(res.lastInsertRowid);
          insertLeg.run(
            betId, "crown", "AH", (s.side === "away" ? -s.targetHandicap : s.targetHandicap).toFixed(2),
            s.crownSelection, s.crownOdds, CROWN_FIXED_STAKE, 0, null,
          );
          for (const c of s.components) {
            insertLeg.run(betId, "hkjc", c.market, c.lineKey, c.selection, c.decimalOdds, c.stake, 1, c.syntheticDetail ?? s.formula);
          }
        }
      }
    });
    tx();
  }

  /* ------------------------------ settlement ---------------------------- */

  /**
   * Settle eligible simulations. PinnAPI's live cache is authoritative only
   * after a score was observed while live and the same event subsequently left
   * the live response. titan007 is strictly a fallback when that cache is
   * absent, never a reason to settle an event still known to be live.
   */
  async settleDue(manual: boolean): Promise<{ settled: number; pending: number; resultsFetched: number }> {
    const now = Date.now();
    const open = db
      .select()
      .from(simulationBets)
      .where(eq(simulationBets.excludedFromStats, 0))
      .all()
      .filter((b) => !b.settledAt);
    await this.refreshTrackedPinnapiLiveScores(now);
    // Manual settlement may refresh/check results, but cannot bypass the
    // existing 105-minute protection for a final score.
    const due = open.filter((b) => isSettleEligible(b.kickoffUtc, now));
    if (!due.length) return { settled: 0, pending: open.length, resultsFetched: 0 };

    const matchesById = new Map(db.select().from(matches).all().map((match) => [match.id, match]));
    const cornerDue = due.filter((bet) => bet.market === "COU");
    const standardDue = due.filter((bet) => bet.market !== "COU");
    const cachedLive = (standardDue.length
      ? rawDb
          .prepare(
            `SELECT event_id,match_id,home_score,away_score,seen_live,no_longer_live
             FROM pinnapi_live_scores WHERE match_id IN (${standardDue.map(() => "?").join(",")})`,
          )
          .all(...standardDue.map((bet) => bet.matchId))
      : []) as Array<{
      event_id: string;
      match_id: string;
      home_score: number;
      away_score: number;
      seen_live: number;
      no_longer_live: number;
    }>;
    const cacheByEvent = new Map(cachedLive.map((row) => [row.event_id, row]));
    const chosen = new Map<string, {
      homeScore: number;
      awayScore: number;
      cornersTotal: number | null;
      pinnacleId: string;
      source: string;
    }>();
    const titanFallback = standardDue.filter((bet) => {
      const match = matchesById.get(bet.matchId);
      const source = match ? this.sourceMap(match.id) : null;
      const activePinnacleId = match?.pinnacleMatchId ?? null;
      const eventId =
        source?.pinnapi_id ??
        (activePinnacleId?.startsWith("pinnapi:") ? activePinnacleId.slice("pinnapi:".length) : null);
      const cache = eventId ? cacheByEvent.get(eventId) : undefined;
      const choice = chooseSettlementSource(
        cache
          ? {
              homeScore: cache.home_score,
              awayScore: cache.away_score,
              seenLive: cache.seen_live,
              noLongerLive: cache.no_longer_live,
            }
          : null,
        bet.kickoffUtc,
        now,
      );
      if (choice === "pinnapi_live" && cache) {
        chosen.set(bet.matchId, {
          homeScore: cache.home_score,
          awayScore: cache.away_score,
          cornersTotal: null,
          pinnacleId: `pinnapi:${cache.event_id}`,
          source: "pinnapi_live",
        });
      }
      return choice === "titan_fallback";
    });

    let titanFetched = 0;
    try {
      if (titanFallback.length) {
        const fetched = DEMO ? DEMO_FIXTURE.results : await this.pinnacle.fetchResults([0, -1, -2, -3]);
        titanFetched = fetched.length;
        const byTitanId = new Map(fetched.map((result) => [result.providerMatchId, result]));
        const aliases = this.aliasIndex();
        for (const bet of titanFallback) {
          const match = matchesById.get(bet.matchId);
          if (!match) continue;
          const source = this.sourceMap(match.id);
          const titanId =
            source?.titan_id ??
            (match.pinnacleMatchId?.startsWith("titan:") ? match.pinnacleMatchId.slice("titan:".length) : null);
          let result = titanId ? byTitanId.get(titanId) : undefined;
          let reversed = !!source?.titan_reversed;
          if (!result) {
            const matched = matchFinalResult(
              {
                id: match.id,
                league: match.league,
                homeTeam: match.homeTeam,
                awayTeam: match.awayTeam,
                kickoffUtc: match.kickoffUtc,
              },
              fetched,
              aliases,
            );
            result = matched?.result;
            reversed = !!matched?.reversed;
          }
          if (!result) continue;
          chosen.set(bet.matchId, {
            homeScore: reversed ? result.awayScore : result.homeScore,
            awayScore: reversed ? result.homeScore : result.awayScore,
            cornersTotal: null,
            pinnacleId: result.providerMatchId,
            source: result.source,
          });
        }
      }
    } catch (err) {
      log("results_error", { error: (err as Error).message });
    }

    // The official HKJC result feed is deliberately third: PinnAPI requires a
    // genuine live-to-gone observation, titan007 remains the existing fallback,
    // and only bets still unresolved after both may use the HKJC master ID.
    let hkjcFetched = 0;
    try {
      const hkjcFallback = titanFallback
        .filter((bet) => !chosen.has(bet.matchId))
        .map((bet) => ({ bet, hkjcId: bet.matchId.replace(/^hkjc:/i, "") }))
        .filter(({ hkjcId }) => !!hkjcId);
      if (hkjcFallback.length) {
        const official = await this.hkjc.fetchHistoricResults(
          hkjcFallback.map(({ bet, hkjcId }) => ({ matchId: hkjcId, kickoffUtc: bet.kickoffUtc })),
        );
        hkjcFetched = official.length;
        const byHkjcId = new Map(official.map((result) => [result.matchId, result]));
        for (const { bet, hkjcId } of hkjcFallback) {
          const result = byHkjcId.get(hkjcId);
          if (!result) continue;
          chosen.set(bet.matchId, {
            homeScore: result.homeScore,
            awayScore: result.awayScore,
            cornersTotal: result.cornersTotal,
            pinnacleId: `hkjc:${result.matchId}`,
            source: result.source,
          });
        }
      }
    } catch (err) {
      log("hkjc_results_error", { error: (err as Error).message });
    }

    // Corner simulations have an intentionally separate result path. There is
    // no live-score, goal-score or titan fallback: a missing ttlCornerResult
    // leaves the bet pending indefinitely.
    let cornerFetched = 0;
    try {
      if (cornerDue.length) {
        const official = await this.hkjc.fetchHistoricResults(
          cornerDue.map((bet) => ({ matchId: bet.matchId.replace(/^hkjc:/i, ""), kickoffUtc: bet.kickoffUtc })),
        );
        cornerFetched = official.length;
        const byHkjcId = new Map(official.map((result) => [result.matchId, result]));
        for (const bet of cornerDue) {
          const result = byHkjcId.get(bet.matchId.replace(/^hkjc:/i, ""));
          if (!result || !canSettleCornerMarket(result.source, result.cornersTotal)) continue;
          chosen.set(bet.matchId, {
            homeScore: result.homeScore,
            awayScore: result.awayScore,
            cornersTotal: result.cornersTotal,
            pinnacleId: `hkjc:${result.matchId}`,
            source: result.source,
          });
        }
      }
    } catch (err) {
      log("hkjc_corner_results_error", { error: (err as Error).message });
    }

    const resultStmt = rawDb.prepare(
      `INSERT INTO results(match_id,pinnacle_match_id,home_score,away_score,corners_total,half_home,half_away,source,fetched_at)
       VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET home_score=excluded.home_score,
       away_score=excluded.away_score, corners_total=excluded.corners_total, half_home=excluded.half_home, half_away=excluded.half_away,
       source=excluded.source, fetched_at=excluded.fetched_at`,
    );
    let settled = 0;
    const tx = rawDb.transaction(() => {
      for (const b of due) {
        const result = chosen.get(b.matchId);
        if (!result) continue;
        resultStmt.run(
          b.matchId,
          result.pinnacleId,
          result.homeScore,
          result.awayScore,
          result.cornersTotal,
          null,
          null,
          result.source,
          now,
        );
        const legs = db.select().from(simulationLegs).where(eq(simulationLegs.betId, b.id)).all();
        if (!legs.length) continue;
        if (
          b.market === "COU" &&
          (!canSettleCornerMarket(result.source, result.cornersTotal) ||
            legs.some(
              (leg) =>
                leg.market !== "COU" ||
                !leg.lineKey ||
                !Number.isFinite(Number(leg.lineKey)) ||
                (leg.selection !== "O" && leg.selection !== "U"),
            ))
        ) {
          // Corrupt/incomplete COU rows stay pending rather than being pushed
          // or settled from the score fields.
          continue;
        }
        const score = { homeScore: result.homeScore, awayScore: result.awayScore };
        const statuses: LegStatus[] = [];
        let totalReturn = 0;
        for (const leg of legs) {
          const lineValue = leg.lineKey ? Number(leg.lineKey) : null;
          const status =
            leg.market === "COU"
              ? settleCornerTotal(result.cornersTotal!, lineValue!, leg.selection as "O" | "U")
              : settleLeg(leg.market as Market, lineValue, leg.selection as Selection, score);
          const ret = legReturn(status, leg.stake, leg.decimalOdds);
          statuses.push(status);
          totalReturn += ret;
          rawDb.prepare("UPDATE simulation_legs SET leg_status=?, leg_return=? WHERE id=?").run(status, ret, leg.id);
        }
        const pnl = round2(totalReturn - b.totalStake);
        rawDb
          .prepare(
            "UPDATE simulation_bets SET settled_at=?, result_status=?, realized_return=?, realized_pnl=?, final_score=?, settlement_source=? WHERE id=?",
          )
          .run(
            now,
            aggregateBetStatus(statuses),
            round2(totalReturn),
            pnl,
            b.market === "COU" ? `角球 ${result.cornersTotal}` : `${score.homeScore}-${score.awayScore}`,
            result.source,
            b.id,
          );
        settled++;
      }
    });
    tx();
    const resultsFetched = chosen.size + titanFetched + hkjcFetched + cornerFetched;
    log("settlement", { settled, due: due.length, resultsFetched, manual });
    return { settled, pending: open.length - settled, resultsFetched };
  }

  clearSimulations(category?: string): number {
    const tx = rawDb.transaction(() => {
      if (category) {
        rawDb
          .prepare("DELETE FROM simulation_legs WHERE bet_id IN (SELECT id FROM simulation_bets WHERE category=?)")
          .run(category);
        return rawDb.prepare("DELETE FROM simulation_bets WHERE category=?").run(category).changes;
      }
      rawDb.prepare("DELETE FROM simulation_legs").run();
      return rawDb.prepare("DELETE FROM simulation_bets").run().changes;
    });
    const n = tx();
    log("simulations_cleared", { category: category ?? "all", removed: n });
    return n;
  }
}

export const engine = new RadarEngine();
