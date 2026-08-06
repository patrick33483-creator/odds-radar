/**
 * Refresh orchestration, opportunity detection and simulation placement.
 *
 * Freshness policy
 *   frontend poll                 20 s   (client)
 *   backend refresh throttle      30 s
 *   titan007 fixture-list cache   10 min
 *   Crown detail cache            <=1h -> 60 s | 1-3h -> 180 s | >3h -> 600 s
 *
 * Cold start is two-stage: a quick <=3h scan publishes partial data immediately,
 * then a full refresh runs in the background. Last-good data is always retained;
 * a provider failure never clears the previous snapshot and never invents prices.
 */

import { CrownProvider } from "../providers/crown";
import { HkjcProvider } from "../providers/hkjc";
import type { ProviderPrice } from "../providers/types";
import { formatLine, lineKeyOf } from "./lines";
import { matchEvent, normalizeName, type AliasIndex, type CandidateEvent } from "./matching";
import { findThreeWayArb, findTwoWayArb, CROWN_FIXED_STAKE } from "./arb";
import { evaluateEv, EV_THRESHOLD, HKJC_FIXED_STAKE, isSafe, MIN_MAPPING_CONFIDENCE, STALE_MS } from "./ev";
import { buildSynthetic, SYNTHETIC_TARGETS, syntheticCoversCrown, type SynSide } from "./synthetic";
import { mergeOpportunityState, type DedupeEntry } from "./dedupe";
import { aggregateBetStatus, isSettleEligible, legReturn, round2, settleLeg, type LegStatus } from "./settlement";
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
  results as resultsTable,
  setState,
  simulationBets,
  simulationLegs,
  teamAliases,
} from "./store";
import { DEMO_FIXTURE } from "./demo-data";
import type {
  ArbOpportunity,
  DashboardResponse,
  EvOpportunity,
  LineRow,
  Market,
  MatchRow,
  PriceCell,
  ProviderStatus,
  Selection,
  StatusResponse,
  SyntheticOpportunity,
} from "@shared/types";

export const REFRESH_THROTTLE_MS = 30_000;
export const FIXTURE_CACHE_MS = 10 * 60_000;
export const QUICK_WINDOW_MIN = 180;
/** Any dense helper loop must stay under this budget. */
export const MAX_LOOP_MS = 290_000;

const DEMO = process.env.RADAR_DEMO === "1";

function log(event: string, fields: Record<string, unknown> = {}): void {
  const payload = { ts: new Date().toISOString(), scope: "radar", event, ...fields };
  console.log(JSON.stringify(payload));
}

function crownCacheTtl(minutesToKickoff: number): number {
  if (minutesToKickoff <= 60) return 60_000;
  if (minutesToKickoff <= 180) return 180_000;
  return 600_000;
}

interface CrownDetailCacheEntry {
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
  private readonly crown = new CrownProvider();

  private refreshing = false;
  private inflight: Promise<void> | null = null;
  private lastRefreshAt: number | null = null;
  private lastGoodAt: number | null = null;
  private coldStartStage: StatusResponse["coldStartStage"] = "idle";
  private degradedReason: string | null = null;

  private fixtureCache: { at: number; rows: Awaited<ReturnType<CrownProvider["fetchFixtures"]>> } | null = null;
  private crownDetail = new Map<string, CrownDetailCacheEntry>();

  constructor() {
    const stored = getState("lastGoodAt");
    if (stored) this.lastGoodAt = Number(stored);
    if (this.lastGoodAt) this.coldStartStage = "done";
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
   */
  async refresh(opts: { force?: boolean; windowMinutes?: number } = {}): Promise<{ started: boolean; throttled: boolean }> {
    if (this.inflight) {
      await this.inflight;
      return { started: false, throttled: false };
    }
    const now = Date.now();
    if (!opts.force && this.lastRefreshAt && now - this.lastRefreshAt < REFRESH_THROTTLE_MS) {
      return { started: false, throttled: true };
    }
    const cold = this.isColdStart();
    const windowMinutes = opts.windowMinutes ?? (cold ? QUICK_WINDOW_MIN : undefined);
    this.refreshing = true;
    this.coldStartStage = cold ? "quick" : this.coldStartStage;
    this.inflight = this.runRefresh(windowMinutes)
      .catch((err) => log("refresh_failed", { error: (err as Error).message }))
      .finally(() => {
        this.refreshing = false;
        this.inflight = null;
        this.lastRefreshAt = Date.now();
      });
    await this.inflight;

    if (cold && windowMinutes) {
      // Stage two: fill in the remaining fixtures in the background.
      this.coldStartStage = "full";
      void (async () => {
        try {
          await this.refresh({ force: true, windowMinutes: undefined });
        } finally {
          this.coldStartStage = "done";
        }
      })();
    }
    return { started: true, throttled: false };
  }

  private setHealth(provider: "hkjc" | "crown", patch: HealthPatch): void {
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

  private async runRefresh(windowMinutes?: number): Promise<void> {
    const deadline = Date.now() + MAX_LOOP_MS;
    const now = Date.now();
    let hkjcOk = false;

    /* ---- 1. HKJC ---- */
    try {
      const res = DEMO
        ? { events: DEMO_FIXTURE.hkjc, latencyMs: 1, partial: false, warnings: ["DEMO"] }
        : await this.hkjc.fetchPreMatch({ windowMinutes });
      hkjcOk = true;
      this.setHealth("hkjc", { ok: true, latencyMs: res.latencyMs, itemCount: res.events.length, mode: DEMO ? "demo" : "live" });
      const tx = rawDb.transaction(() => {
        for (const ev of res.events) {
          const id = `hkjc:${ev.providerMatchId}`;
          rawDb
            .prepare(
              `INSERT INTO matches(id,hkjc_id,crown_match_id,league,league_en,home_team,away_team,home_team_en,away_team_en,kickoff_utc,status,inplay,updated_at)
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
      log("hkjc_refresh", { matches: res.events.length, latencyMs: res.latencyMs, windowMinutes: windowMinutes ?? null });
    } catch (err) {
      const message = (err as Error).message;
      this.setHealth("hkjc", { ok: false, error: message });
      log("hkjc_error", { error: message });
    }

    /* ---- 2. Crown fixtures + mapping ---- */
    let crownOk = false;
    try {
      if (!this.fixtureCache || Date.now() - this.fixtureCache.at > FIXTURE_CACHE_MS) {
        const rows = DEMO ? DEMO_FIXTURE.crownFixtures : await this.crown.fetchFixtures([0, 1]);
        this.fixtureCache = { at: Date.now(), rows };
      }
      const fixtures = this.fixtureCache.rows;
      crownOk = fixtures.length > 0;
      const aliases = this.aliasIndex();
      const candidates: CandidateEvent[] = fixtures.map((f) => ({
        id: f.providerMatchId,
        league: f.league,
        homeTeam: f.homeTeam,
        awayTeam: f.awayTeam,
        kickoffUtc: f.kickoffUtc,
      }));

      const pending = db.select().from(matches).all().filter((m) => m.kickoffUtc > now - 5 * 60_000);
      const mapTx = rawDb.transaction(() => {
        for (const m of pending) {
          const decision = matchEvent(
            { id: m.id, league: m.league, homeTeam: m.homeTeam, awayTeam: m.awayTeam, kickoffUtc: m.kickoffUtc },
            candidates,
            aliases,
          );
          rawDb
            .prepare(
              `INSERT INTO match_mapping(match_id,crown_match_id,confidence,method,kickoff_delta_sec,unmatched_reason,updated_at)
               VALUES(?,?,?,?,?,?,?)
               ON CONFLICT(match_id) DO UPDATE SET crown_match_id=excluded.crown_match_id,
                 confidence=excluded.confidence, method=excluded.method,
                 kickoff_delta_sec=excluded.kickoff_delta_sec, unmatched_reason=excluded.unmatched_reason,
                 updated_at=excluded.updated_at`,
            )
            .run(m.id, decision.crownMatchId, decision.confidence, decision.method, decision.kickoffDeltaSec, decision.unmatchedReason, now);
          rawDb.prepare("UPDATE matches SET crown_match_id=? WHERE id=?").run(decision.crownMatchId, m.id);
          for (const a of decision.learnedAliases) {
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

      /* ---- 3. Crown detail prices (tiered cache, bounded concurrency) ---- */
      const targets = db
        .select()
        .from(matches)
        .all()
        .filter((m) => m.crownMatchId && m.kickoffUtc > now)
        .filter((m) => (windowMinutes ? m.kickoffUtc - now <= windowMinutes * 60_000 : true))
        .sort((a, b) => a.kickoffUtc - b.kickoffUtc);

      let fetched = 0;
      let failed = 0;
      const queue = [...targets];
      const workers = Array.from({ length: 4 }, async () => {
        while (queue.length) {
          if (Date.now() > deadline) return;
          const m = queue.shift();
          if (!m?.crownMatchId) continue;
          const minutes = (m.kickoffUtc - Date.now()) / 60_000;
          const ttl = crownCacheTtl(minutes);
          const cached = this.crownDetail.get(m.crownMatchId);
          let prices = cached && Date.now() - cached.at < ttl ? cached.prices : null;
          if (!prices) {
            try {
              prices = DEMO
                ? (DEMO_FIXTURE.crownPrices[m.crownMatchId] ?? [])
                : await this.crown.fetchMatchPrices(m.crownMatchId);
              this.crownDetail.set(m.crownMatchId, { at: Date.now(), prices });
              fetched++;
            } catch (err) {
              failed++;
              log("crown_detail_error", { crownMatchId: m.crownMatchId, error: (err as Error).message });
              continue;
            }
          }
          if (prices.length) this.persistPrices(m.id, "crown", prices, Date.now());
        }
      });
      await Promise.all(workers);
      crownOk = crownOk && (fetched > 0 || failed === 0);
      this.setHealth("crown", {
        ok: crownOk,
        itemCount: fixtures.length,
        error: crownOk ? null : `crown detail failures: ${failed}`,
        mode: DEMO ? "demo" : crownOk ? "live" : "degraded",
      });
      log("crown_refresh", { fixtures: fixtures.length, targets: targets.length, fetched, failed });
    } catch (err) {
      const message = (err as Error).message;
      this.setHealth("crown", { ok: false, error: message });
      log("crown_error", { error: message });
    }

    /* ---- 4. Opportunities + simulations + settlement ---- */
    const dash = this.buildDashboardData();
    this.recordOpportunities(dash, now);
    this.placeSimulations(dash, now);
    await this.settleDue(false);
    pruneSnapshots(now);

    if (hkjcOk) {
      this.lastGoodAt = Date.now();
      setState("lastGoodAt", String(this.lastGoodAt));
      if (this.coldStartStage === "idle") this.coldStartStage = "done";
    }
    const health = db.select().from(providerHealth).all();
    const bad = health.filter((h) => !h.ok);
    this.degradedReason = DEMO
      ? "示範資料模式（DEMO）：畫面數字為樣本，並非真實賠率。"
      : bad.length
        ? `${bad.map((b) => (b.provider === "hkjc" ? "馬會" : "皇冠")).join("、")}資料來源暫時無法連接（${bad[0].lastError ?? "未知錯誤"}），現時顯示最後一次成功取得的快照。`
        : null;
  }

  private persistPrices(matchId: string, provider: "hkjc" | "crown", prices: ProviderPrice[], now: number): void {
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
      const cell = (provider: string, market: Market, lineKey: string, selection: Selection): PriceCell | undefined => {
        const r = prices.find(
          (p) => p.provider === provider && p.market === market && p.lineKey === lineKey && p.selection === selection,
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
        const cr: Partial<Record<Selection, PriceCell>> = {};
        for (const s of sels) {
          const a = cell("hkjc", market, l.lineKey, s);
          const b = cell("crown", market, l.lineKey, s);
          if (a) hk[s] = a;
          if (b) cr[s] = b;
        }
        const hasHk = Object.keys(hk).length === sels.length;
        const hasCr = Object.keys(cr).length === sels.length;
        const exactLine = hasHk && hasCr;
        const deltas: Partial<Record<Selection, number>> = {};
        for (const s of sels) {
          if (hk[s] && cr[s]) deltas[s] = Math.round((hk[s]!.decimalOdds - cr[s]!.decimalOdds) * 1000) / 1000;
        }

        let totalProbability: number | null = null;
        let bestQ: number | null = null;
        let arb: ArbOpportunity | null = null;

        if (market === "1X2") {
          if (hasHk && hasCr) {
            totalProbability = sels.reduce((acc, s) => acc + 1 / cr[s]!.decimalOdds, 0);
            bestQ = sels.reduce((acc, s) => acc + 1 / Math.max(hk[s]!.decimalOdds, cr[s]!.decimalOdds), 0);
            arb = findThreeWayArb({
              matchId: m.id,
              matchLabel,
              league: m.league,
              kickoffUtc: m.kickoffUtc,
              hkjc: { H: hk.H?.decimalOdds, D: hk.D?.decimalOdds, A: hk.A?.decimalOdds },
              crown: { H: cr.H?.decimalOdds, D: cr.D?.decimalOdds, A: cr.A?.decimalOdds },
            });
          }
        } else if (exactLine) {
          const [s1, s2] = sels;
          const q1 = 1 / hk[s1]!.decimalOdds + 1 / cr[s2]!.decimalOdds;
          const q2 = 1 / hk[s2]!.decimalOdds + 1 / cr[s1]!.decimalOdds;
          bestQ = Math.min(q1, q2);
          totalProbability = 1 / cr[s1]!.decimalOdds + 1 / cr[s2]!.decimalOdds;
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
            findTwoWayArb({ ...base, hkjc: { selection: s1, decimalOdds: hk[s1]!.decimalOdds }, crown: { selection: s2, decimalOdds: cr[s2]!.decimalOdds } }) ??
            findTwoWayArb({ ...base, hkjc: { selection: s2, decimalOdds: hk[s2]!.decimalOdds }, crown: { selection: s1, decimalOdds: cr[s1]!.decimalOdds } });
        }

        let lineEv: EvOpportunity[] = [];
        if (hasCr && Object.keys(hk).length > 0) {
          lineEv = evaluateEv({
            matchId: m.id,
            matchLabel,
            league: m.league,
            kickoffUtc: m.kickoffUtc,
            market,
            lineKey: l.lineKey,
            lineDisplay: formatLine(market, l.lineValue),
            crown: sels.filter((s) => cr[s]).map((s) => ({ selection: s, decimalOdds: cr[s]!.decimalOdds })),
            hkjc: sels.filter((s) => hk[s]).map((s) => ({ selection: s, decimalOdds: hk[s]!.decimalOdds, fetchedAt: hk[s]!.fetchedAt })),
            now,
            mappingConfidence: mapping?.confidence ?? 0,
          });
        }
        if (arb) arbs.push(arb);
        evs.push(...lineEv);

        lineRows.push({
          matchId: m.id,
          market,
          lineKey: l.lineKey,
          lineValue: l.lineValue,
          lineDisplay: formatLine(market, l.lineValue),
          isMain: !!l.isMain,
          hkjc: hk,
          crown: cr,
          exactLine,
          totalProbability: totalProbability === null ? null : Math.round(totalProbability * 1e6) / 1e6,
          bestQ: bestQ === null ? null : Math.round(bestQ * 1e6) / 1e6,
          deltas,
          arb,
          ev: lineEv.length ? lineEv : null,
        });
      }

      /* synthetic quotes from HKJC 1X2 vs Crown handicap singles */
      const syn = this.buildSyntheticsFor(m.id, matchLabel, m.league, m.kickoffUtc, prices);
      synthetics.push(...syn);

      rows.push({
        id: m.id,
        league: m.league,
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        kickoffUtc: m.kickoffUtc,
        minutesToKickoff: Math.round((m.kickoffUtc - now) / 60_000),
        matched: !!m.crownMatchId,
        crownMatchId: m.crownMatchId,
        mappingConfidence: mapping?.confidence ?? 0,
        unmatchedReason: mapping?.unmatchedReason ?? null,
        lines: lineRows,
        hasArb: lineRows.some((r) => !!r.arb),
        hasEv: lineRows.some((r) => (r.ev?.length ?? 0) > 0),
        hasSynthetic: syn.some((s) => s.isArb),
        synthetics: syn,
      });
    }

    const leagues = Array.from(new Set(rows.map((r) => r.league))).sort();
    return { status: this.buildStatus(rows, arbs, evs, synthetics), matches: rows, arbs, ev: evs, synthetics, leagues };
  }

  private buildSyntheticsFor(
    matchId: string,
    matchLabel: string,
    league: string,
    kickoffUtc: number,
    prices: Array<{ provider: string; market: string; lineKey: string; selection: string; decimalOdds: number }>,
  ): SyntheticOpportunity[] {
    const hk1x2 = (sel: string) =>
      prices.find((p) => p.provider === "hkjc" && p.market === "1X2" && p.selection === sel)?.decimalOdds;
    const oddsHome = hk1x2("H");
    const oddsDraw = hk1x2("D");
    const oddsAway = hk1x2("A");
    if (!oddsHome || !oddsDraw || !oddsAway) return [];
    const officialFor = (side: SynSide) => {
      const lineKey = (side === "away" ? -1 : 1).toFixed(2);
      const sel = side === "away" ? "A" : "H";
      return prices.find((p) => p.provider === "hkjc" && p.market === "AH" && p.lineKey === lineKey && p.selection === sel)
        ?.decimalOdds ?? null;
    };
    const out: SyntheticOpportunity[] = [];
    for (const side of ["away", "home"] as SynSide[]) {
      const official1 = officialFor(side);
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
        if (!crownRow) continue;
        const crownOdds = crownRow.decimalOdds;
        // Crown leg anchored at HK$5,000 -> target payout -> synthetic outlay.
        const payout = CROWN_FIXED_STAKE * crownOdds;
        const probe = buildSynthetic(side, target, { oddsHome, oddsDraw, oddsAway, official1 }, 1000);
        if (!probe) continue;
        const W = payout / probe.odds;
        const quote = buildSynthetic(side, target, { oddsHome, oddsDraw, oddsAway, official1 }, W);
        if (!quote) continue;
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
    const providers: ProviderStatus[] = (["hkjc", "crown"] as const).map((p) => {
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

  /* -------------------------- opportunity state ------------------------- */

  private recordOpportunities(dash: DashboardResponse, now: number): void {
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
  }

  /* ----------------------------- simulations ---------------------------- */

  private placeSimulations(dash: DashboardResponse, now: number): void {
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
        const key = `case1_arb|${a.matchId}|${a.lineKey}|${a.market}:${a.legs.map((l) => l.selection).join("")}`;
        const res = insertBet.run(
          key, "case1_arb", a.matchId, a.market, a.lineKey, a.legs[0]?.selection ?? "", a.matchLabel, a.league,
          a.kickoffUtc, a.totalStake, a.payout, a.profit, a.roi, null, a.q, now,
        );
        if (res.changes) {
          const betId = Number(res.lastInsertRowid);
          for (const l of a.legs) insertLeg.run(betId, l.provider, l.market, l.lineKey, l.selection, l.decimalOdds, l.stake, 0, null);
        }
      }
      /* 情況二 — EV >= 3%, HKJC fixed 10,000 */
      for (const e of dash.ev) {
        if (!isSafe(e) || e.edge < EV_THRESHOLD) continue;
        const key = `case2_ev|${e.matchId}|${e.lineKey}|${e.market}:${e.selection}`;
        const payout = round2(HKJC_FIXED_STAKE * e.hkjcOdds);
        const res = insertBet.run(
          key, "case2_ev", e.matchId, e.market, e.lineKey, e.selection, e.matchLabel, e.league, e.kickoffUtc,
          HKJC_FIXED_STAKE, payout, round2(HKJC_FIXED_STAKE * e.edge), e.edge, e.edge, null, now,
        );
        if (res.changes) {
          const betId = Number(res.lastInsertRowid);
          insertLeg.run(betId, "hkjc", e.market, e.lineKey, e.selection, e.hkjcOdds, HKJC_FIXED_STAKE, 0, null);
        }
      }
      /* 合成賠率 — Crown fixed 5,000, HKJC split by the synthetic formula */
      for (const s of dash.synthetics) {
        if (!s.isArb || !s.crownOdds || !s.crownSelection) continue;
        const key = `synth_arb|${s.matchId}|${s.targetHandicap}|${s.side}`;
        const res = insertBet.run(
          key, "synth_arb", s.matchId, "AH", (s.side === "away" ? -s.targetHandicap : s.targetHandicap).toFixed(2),
          s.side === "away" ? "A" : "H", s.matchLabel, s.league, s.kickoffUtc, s.totalStake, s.payout, s.profit, s.roi,
          null, s.q, now,
        );
        if (res.changes) {
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

  /** Pull results and settle every eligible simulated bet. */
  async settleDue(manual: boolean): Promise<{ settled: number; pending: number; resultsFetched: number }> {
    const now = Date.now();
    const open = db.select().from(simulationBets).all().filter((b) => !b.settledAt);
    const due = open.filter((b) => manual || isSettleEligible(b.kickoffUtc, now));
    if (!due.length) return { settled: 0, pending: open.length, resultsFetched: 0 };

    let resultsFetched = 0;
    try {
      const fetched = DEMO ? DEMO_FIXTURE.results : await this.crown.fetchResults([0, -1, -2, -3]);
      resultsFetched = fetched.length;
      const byCrownId = new Map(fetched.map((r) => [r.providerMatchId, r]));
      const stmt = rawDb.prepare(
        `INSERT INTO results(match_id,crown_match_id,home_score,away_score,half_home,half_away,source,fetched_at)
         VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(match_id) DO UPDATE SET home_score=excluded.home_score,
         away_score=excluded.away_score, half_home=excluded.half_home, half_away=excluded.half_away,
         source=excluded.source, fetched_at=excluded.fetched_at`,
      );
      const tx = rawDb.transaction(() => {
        for (const b of due) {
          const m = db.select().from(matches).where(eq(matches.id, b.matchId)).get();
          if (!m?.crownMatchId) continue;
          const r = byCrownId.get(m.crownMatchId);
          if (!r) continue;
          stmt.run(b.matchId, m.crownMatchId, r.homeScore, r.awayScore, r.halfHome ?? null, r.halfAway ?? null, r.source, now);
        }
      });
      tx();
    } catch (err) {
      log("results_error", { error: (err as Error).message });
    }

    let settled = 0;
    const tx = rawDb.transaction(() => {
      for (const b of due) {
        const result = db.select().from(resultsTable).where(eq(resultsTable.matchId, b.matchId)).get();
        if (!result) continue;
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
            "UPDATE simulation_bets SET settled_at=?, result_status=?, realized_return=?, realized_pnl=?, final_score=? WHERE id=?",
          )
          .run(now, aggregateBetStatus(statuses), round2(totalReturn), pnl, `${score.homeScore}-${score.awayScore}`, b.id);
        settled++;
      }
    });
    tx();
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
