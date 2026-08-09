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
import { CROWN_FIXED_STAKE, findThreeWayArb, findTwoWayArb } from "./arb";
import { evaluateEv, EV_THRESHOLD, HKJC_FIXED_STAKE, isSafe, MIN_MAPPING_CONFIDENCE, selectBestEv, STALE_MS } from "./ev";
import { buildSynthetic, EV_SYNTHETIC_TARGETS, SYNTHETIC_TARGETS, syntheticCoversCrown, type SynSide } from "./synthetic";
import { mergeOpportunityState, type DedupeEntry } from "./dedupe";
import { teamAliasSeedRows } from "./team-alias-seeds";
import { notifySimulationBets } from "./telegram";
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
  type ScanCandidate,
  type ScanConfig,
} from "./scan";
import {
  aggregateBetStatus,
  chooseSettlementSource,
  isSettleEligible,
  legReturn,
  matchFinalResult,
  round2,
  settleLeg,
  type LegStatus,
} from "./settlement";
import {
  countSnapshots,
  db,
  eq,
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
  private readonly hkjc = new HkjcProvider();
  private readonly pinnapi = new PinnapiProvider();
  private readonly pinnacle = new PinnacleProvider();
  private readonly optic = new OpticOddsProvider();

  private refreshing = false;
  private inflight: Promise<void> | null = null;
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
  private pinnacleDetail = new Map<string, PinnacleDetailCacheEntry>();
  private crownDetail = new Map<string, PinnacleDetailCacheEntry>();
  private pinnacleRowsSeen = 0;
  private lastScan: ScanOutcome | null = null;
  private scanning = false;
  private matchRefreshes = new Map<string, Promise<MatchRefreshResponse>>();

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
    const now = Date.now();
    try {
      const res = DEMO
        ? { events: DEMO_FIXTURE.hkjc, latencyMs: 1, partial: false, warnings: ["DEMO"] }
        : await this.hkjc.fetchPreMatch({});
      this.setHealth("hkjc", { ok: true, latencyMs: res.latencyMs, itemCount: res.events.length, mode: DEMO ? "demo" : "live" });
      const tx = rawDb.transaction(() => {
        for (const ev of res.events) {
          const id = `hkjc:${ev.providerMatchId}`;
          rawDb
            .prepare(
              `INSERT INTO matches(id,hkjc_id,pinnacle_match_id,league,league_en,home_team,away_team,home_team_en,away_team_en,kickoff_utc,status,inplay,updated_at)
               VALUES(?,?,NULL,?,?,?,?,?,?,?,?,0,?)
               ON CONFLICT(id) DO UPDATE SET league=excluded.league, league_en=excluded.league_en,
                 home_team=excluded.home_team, away_team=excluded.away_team, kickoff_utc=excluded.kickoff_utc,
                 status=excluded.status, inplay=0, updated_at=excluded.updated_at`,
            )
            .run(
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
          this.persistPrices(id, "hkjc", ev.prices, now);
        }
      });
      tx();
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
          titan = await this.pinnacle.fetchFixtures([0, 1, 2, 3, 4]);
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

    const pending = db.select().from(matches).all().filter((m) => m.kickoffUtc > now - 5 * 60_000);
    let mapped = 0;
    const matchWithVerifiedTimeFallback = (
      target: CandidateEvent,
      candidates: CandidateEvent[],
      sourceAliases?: AliasIndex,
    ) => {
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
    };
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
        rawDb.prepare("UPDATE matches SET pinnacle_match_id=? WHERE id=?").run(activeId, m.id);
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
      if (bet.settledAt || bet.kickoffUtc > now) continue;
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
                prices = await this.pinnapi.fetchMatchPrices(source.pinnapi_id);
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
          this.persistPrices(m.id, "pinnacle", prices, Date.now());
        }

        if (!DEMO && source?.titan_id) {
          const cachedCrown = this.crownDetail.get(source.titan_id);
          let crownPrices =
            !bypassCache && cachedCrown && Date.now() - cachedCrown.at < ttl ? cachedCrown.prices : null;
          if (!crownPrices) {
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
          if (crownPrices.length) {
            rawDb.prepare("DELETE FROM odds_latest WHERE match_id=? AND provider='crown'").run(m.id);
            this.persistPrices(m.id, "crown", crownPrices, Date.now());
          }
        }
      }
    });
    await Promise.all(workers);
    this.pinnacleRowsSeen = rows;
    return { fetched, failed, rows };
  }

  /** Matches eligible for detail polling in the given mode. */
  private detailTargets(mode: RefreshMode, cfg: ScanConfig) {
    const now = Date.now();
    const all = db
      .select()
      .from(matches)
      .all()
      .filter((m) => m.pinnacleMatchId && m.kickoffUtc > now)
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

    const dash = this.buildDashboardData();
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
    const now = Date.now();
    await this.refreshHkjc();
    const res = await this.pollPinnacleDetail(
      events.map((e) => ({ id: e.matchId, pinnacleMatchId: e.pinnacleMatchId, kickoffUtc: e.kickoffUtc })),
      Date.now() + MAX_LOOP_MS,
      true,
    );
    const dash = this.buildDashboardData();
    this.recordOpportunities(dash, now);
    // Simulation purchases are exclusive to this dense-scan path and to the
    // events selected for this pass. General/manual refreshes never buy.
    this.placeSimulations(dash, now, new Set(events.map((e) => e.matchId)));
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
   * Trigger one dense pre-kickoff window scan. Safe to call from a CLI, an HTTP
   * helper endpoint, or an external scheduler. This method creates no schedule.
   */
  async runScan(): Promise<ScanOutcome> {
    const currentBets = db
      .select()
      .from(simulationBets)
      .where(eq(simulationBets.excludedFromStats, 0))
      .all().length;
    const target = simulationTarget();
    if (simulationTargetReached(currentBets, target)) {
      const cfg = scanConfig();
      const at = Date.now();
      const outcome: ScanOutcome = {
        result: "TARGET_REACHED",
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
        message: `模擬注單目標已達 ${currentBets}/${target}，自動視窗掃描不執行。`,
      };
      this.lastScan = outcome;
      setState("lastScan", JSON.stringify(outcome));
      return outcome;
    }
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
      if (outcome.newOpportunityKeys.length) {
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

  private persistPrices(matchId: string, provider: "hkjc" | "pinnacle" | "crown", prices: ProviderPrice[], now: number): void {
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
  }

  /* ----------------------------- dashboard ------------------------------ */

  buildDashboardData(): DashboardResponse {
    const now = Date.now();
    const allMatches = db
      .select()
      .from(matches)
      .all()
      .filter((m) => m.kickoffUtc > now - 30 * 60_000)
      .sort((a, b) => a.kickoffUtc - b.kickoffUtc);
    const mappings = new Map(db.select().from(matchMapping).all().map((r) => [r.matchId, r]));
    const latestRows = db.select().from(oddsLatest).all();
    const byMatch = new Map<string, typeof latestRows>();
    for (const r of latestRows) {
      const list = byMatch.get(r.matchId) ?? [];
      list.push(r);
      byMatch.set(r.matchId, list);
    }
    const linesRows = db.select().from(marketLines).all();
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
        const hasFreshHk = hasHk && sels.every((s) => !hk[s]!.stale);
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
          if (hasFreshHk && hasFreshCrown) {
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
          if (hasFreshHk && hasFreshCrown) {
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
        if (hasFreshPin && Object.keys(hk).length > 0) {
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
      const syn = this.buildSyntheticsFor(m.id, matchLabel, m.league, m.kickoffUtc, prices, now);
      synthetics.push(...syn);
      // Standalone 1X2 remains visible for observation only. An AH/OU target
      // may still use an economically equivalent HKJC 1X2 combination when
      // that route offers the better return.
      const syntheticEvs = this.buildSyntheticEvsFor(
        m.id,
        matchLabel,
        m.league,
        m.kickoffUtc,
        prices,
        mapping?.confidence ?? 0,
        now,
      );
      const matchEvs = selectBestEv([...directEvs, ...syntheticEvs]);
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
        if (!usedRows.length) continue;
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
          usedRows.some((price) => now - price.fetchedAt > STALE_MS)
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
          isArb: q < 1,
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

  private placeSimulations(dash: DashboardResponse, now: number, scannedMatchIds: ReadonlySet<string>): void {
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
        total_stake,expected_payout,expected_profit,roi,ev_pct,q_total,placed_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertLeg = rawDb.prepare(
      `INSERT INTO simulation_legs(bet_id,provider,market,line_key,selection,decimal_odds,stake,synthetic,synthetic_detail)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    );
    const tx = rawDb.transaction(() => {
      /* 情況一 — arb, Crown fixed 5,000, HKJC back-calculated */
      for (const a of dash.arbs) {
        if (remaining <= 0) break;
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
          a.kickoffUtc, a.totalStake, a.payout, a.profit, a.roi, null, a.q, now,
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
        if (!eligible(e.matchId, e.kickoffUtc, "case2_ev")) continue;
        // Only the target market decides eligibility. A synthetic AH/OU route
        // is valid; a standalone 1X2 target is observation-only.
        if (e.market !== "AH" && e.market !== "OU") continue;
        if (!isSafe(e) || e.edge < EV_THRESHOLD) continue;
        const key = `case2_ev|${e.matchId}|${e.lineKey}|${e.market}:${e.selection}`;
        const payout = round2(HKJC_FIXED_STAKE * e.hkjcOdds);
        const res = insertBet.run(
          key, "case2_ev", e.matchId, e.market, e.lineKey, e.selection, e.matchLabel, e.league, e.kickoffUtc,
          HKJC_FIXED_STAKE, payout, round2(HKJC_FIXED_STAKE * e.edge), e.edge, e.edge, null, now,
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
          null, s.q, now,
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
    const cachedLive = rawDb
      .prepare(
        `SELECT event_id,match_id,home_score,away_score,seen_live,no_longer_live
         FROM pinnapi_live_scores WHERE match_id IN (${due.map(() => "?").join(",")})`,
      )
      .all(...due.map((bet) => bet.matchId)) as Array<{
      event_id: string;
      match_id: string;
      home_score: number;
      away_score: number;
      seen_live: number;
      no_longer_live: number;
    }>;
    const cacheByEvent = new Map(cachedLive.map((row) => [row.event_id, row]));
    const chosen = new Map<string, { homeScore: number; awayScore: number; pinnacleId: string; source: string }>();
    const titanFallback = due.filter((bet) => {
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
            pinnacleId: `hkjc:${result.matchId}`,
            source: result.source,
          });
        }
      }
    } catch (err) {
      log("hkjc_results_error", { error: (err as Error).message });
    }

    const resultStmt = rawDb.prepare(
      `INSERT INTO results(match_id,pinnacle_match_id,home_score,away_score,half_home,half_away,source,fetched_at)
       VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET home_score=excluded.home_score,
       away_score=excluded.away_score, half_home=excluded.half_home, half_away=excluded.half_away,
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
          null,
          null,
          result.source,
          now,
        );
        const legs = db.select().from(simulationLegs).where(eq(simulationLegs.betId, b.id)).all();
        if (!legs.length) continue;
        const score = { homeScore: result.homeScore, awayScore: result.awayScore };
        const statuses: LegStatus[] = [];
        let totalReturn = 0;
        for (const leg of legs) {
          const lineValue = leg.lineKey ? Number(leg.lineKey) : null;
          const status = settleLeg(leg.market as Market, lineValue, leg.selection as Selection, score);
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
            `${score.homeScore}-${score.awayScore}`,
            result.source,
            b.id,
          );
        settled++;
      }
    });
    tx();
    const resultsFetched = chosen.size + titanFetched + hkjcFetched;
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
