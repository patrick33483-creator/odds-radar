/**
 * PinnAPI Edge adapter.
 *
 * This is the primary Pinnacle reference feed for fixture matching and
 * full-match pre-match prices. Credentials are deliberately read only from the
 * environment and are never included in logs or thrown errors.
 *
 * Endpoints:
 *   GET /kit/v1/prematch/fixtures?sport_id=1
 *   GET /kit/v1/prematch/lines?event_id=<id>
 *
 * Only periods.num_0 (full match) is accepted for prices. PinnAPI's Asian
 * handicap sign is already the radar convention: negative means the home team
 * gives, so it must not be flipped.
 */

import { fetchJson, type FetchOpts } from "../lib/http";
import { isQuarterStep } from "../lib/lines";
import type { ProviderPrice } from "./types";

type JsonRecord = Record<string, unknown>;

export interface PinnapiFixture {
  /** Raw PinnAPI event_id, persisted as pinnapi:<event_id> by the engine. */
  providerMatchId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: number;
  inplay: boolean;
  status: string;
  /** Null for a parent/top-level event; used to prefer parent fixtures. */
  parentId: string | null;
}

export interface PinnapiLines {
  eventId: string;
  /** `closed` is informational market state, not a stale-data conclusion. */
  marketStatus: string | null;
  prices: ProviderPrice[];
}

export interface PinnapiCornerLines extends PinnapiLines {
  /** The only accepted special-event child. Null when unavailable/ambiguous. */
  cornerEventId: string | null;
  /** Auditable count of eligible full-match corner children. */
  candidateCount: number;
}

/**
 * A score observed in PinnAPI's bounded all-live-markets response. It is
 * explicitly a live observation, never a final result by itself.
 */
export interface PinnapiLiveScore {
  eventId: string;
  homeScore: number;
  awayScore: number;
  minutes: number | null;
  state: string | null;
  observedAt: number;
}

export interface PinnapiLiveScoreSnapshot {
  observedAt: number;
  scores: PinnapiLiveScore[];
  /** Live event IDs even when a malformed row carries no usable score. */
  liveEventIds: string[];
}

export interface PinnapiConfig {
  baseUrl: string;
  configured: boolean;
}

interface PrivatePinnapiConfig extends PinnapiConfig {
  apiKey: string | null;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function str(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = str(value);
  if (!text) return null;
  const n = typeof value === "number" ? value : Number(text);
  return Number.isFinite(n) ? n : null;
}

function validDecimal(value: unknown): number | null {
  const n = num(value);
  return n !== null && n > 1 ? n : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const n = num(value);
  return n !== null && n >= 0 && Number.isInteger(n) ? n : null;
}

function configuredBase(raw: string | undefined): string {
  const fallback = "https://pinnapi.com";
  const candidate = raw?.trim() || fallback;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && url.protocol !== "http:") return fallback;
    // A base URL is an endpoint location, not an authentication channel. Strip
    // user-info, query parameters and fragments so a misconfigured URL cannot
    // leak a credential through the HTTP helper's error message.
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

function privateConfig(env: NodeJS.ProcessEnv = process.env): PrivatePinnapiConfig {
  // A platform-injected custom credential is equivalent to an API key for
  // PinnAPI, but must use x-api-key explicitly.
  const token = env.CUSTOM_CRED_PINNAPI_COM_TOKEN?.trim() || null;
  const directKey = env.PINNAPI_API_KEY?.trim() || null;
  const apiKey = token ?? directKey;
  return {
    baseUrl: configuredBase(env.PINNAPI_BASE_URL || env.CUSTOM_CRED_PINNAPI_COM_URL),
    configured: !!apiKey,
    apiKey,
  };
}

/** Safe-to-display configuration (never exposes a credential). */
export function pinnapiConfig(env: NodeJS.ProcessEnv = process.env): PinnapiConfig {
  const config = privateConfig(env);
  return { baseUrl: config.baseUrl, configured: config.configured };
}

/** Kept separate for focused tests and to guarantee a single auth mechanism. */
export function pinnapiHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const config = privateConfig(env);
  return config.apiKey ? { accept: "application/json", "x-api-key": config.apiKey } : { accept: "application/json" };
}

function startTimestamp(row: JsonRecord): number | null {
  const raw = row.starts ?? row.start_ts;
  if (typeof raw === "number") {
    const ms = raw < 10_000_000_000 ? raw * 1000 : raw;
    return Number.isFinite(ms) ? ms : null;
  }
  const text = str(raw);
  if (!text) return null;
  const numeric = Number(text);
  const parsed = Number.isFinite(numeric)
    ? numeric < 10_000_000_000
      ? numeric * 1000
      : numeric
    : Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  // Reject impossible timestamps rather than allowing an accidental unit or
  // malformed value to enter fixture matching.
  return parsed >= Date.UTC(2020, 0, 1) && parsed <= Date.UTC(2100, 0, 1) ? parsed : null;
}

function isInplay(row: JsonRecord): boolean {
  const status = str(row.status ?? row.event_status ?? row.state);
  const flag = row.inplay ?? row.is_live ?? row.live;
  return (
    flag === true ||
    flag === 1 ||
    flag === "1" ||
    Number(row.live_status) === 1 ||
    /live|in[\s_-]?play|started|running|suspended/i.test(status)
  );
}

function collectFixtureRows(value: unknown, out: JsonRecord[], depth = 0): void {
  if (depth > 5 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectFixtureRows(item, out, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  if (record.event_id !== undefined || record.eventId !== undefined) out.push(record);
  for (const key of ["fixtures", "events", "data", "leagues", "league"]) {
    if (record[key] !== undefined) collectFixtureRows(record[key], out, depth + 1);
  }
}

function hasFullMatchPeriod(row: JsonRecord): boolean {
  const periods = asRecord(row.periods);
  return !!periods && asRecord(periods.num_0) !== null;
}

interface PinnapiFixtureCandidate extends PinnapiFixture {
  hasFullMatch: boolean;
}

/**
 * Maps the fixtures response into CandidateEvent-compatible records. Duplicate
 * parent/child records prefer the item that exposes a full-match `num_0`
 * period. When both expose `num_0`, the top-level parent is preferred.
 */
export function parsePinnapiFixtures(payload: unknown): PinnapiFixture[] {
  const rawRows: JsonRecord[] = [];
  collectFixtureRows(payload, rawRows);
  const candidates: PinnapiFixtureCandidate[] = rawRows
    .map((row): PinnapiFixtureCandidate | null => {
      const eventId = str(row.event_id ?? row.eventId ?? row.id);
      const league = str(row.league_name ?? row.league ?? row.leagueName);
      const homeTeam = str(row.home ?? row.home_team ?? row.homeTeam);
      const awayTeam = str(row.away ?? row.away_team ?? row.awayTeam);
      const kickoffUtc = startTimestamp(row);
      const parentRaw = row.parent_id ?? row.parentId;
      const parentId = parentRaw === null || parentRaw === undefined || str(parentRaw) === "" ? null : str(parentRaw);
      if (!eventId || !league || !homeTeam || !awayTeam || kickoffUtc === null || isInplay(row)) return null;
      return {
        providerMatchId: eventId,
        league,
        homeTeam,
        awayTeam,
        kickoffUtc,
        inplay: false,
        status: str(row.status ?? row.event_status ?? row.state) || "scheduled",
        parentId,
        hasFullMatch: hasFullMatchPeriod(row),
      };
    })
    .filter((row): row is PinnapiFixtureCandidate => row !== null);

  const byId = new Map(candidates.map((row) => [row.providerMatchId, row]));
  const familyIdOf = (row: PinnapiFixtureCandidate): string => {
    let current = row;
    const seen = new Set<string>([current.providerMatchId]);
    while (current.parentId && !seen.has(current.parentId)) {
      const parent = byId.get(current.parentId);
      if (!parent) break;
      seen.add(parent.providerMatchId);
      current = parent;
    }
    return current.providerMatchId;
  };
  const families = new Map<string, PinnapiFixtureCandidate[]>();
  for (const row of candidates) {
    const familyId = familyIdOf(row);
    const family = families.get(familyId) ?? [];
    family.push(row);
    families.set(familyId, family);
  }
  const familyPreferred = [...families.values()].map((family) => {
    const withFullMatch = family.filter((row) => row.hasFullMatch);
    const eligible = withFullMatch.length ? withFullMatch : family;
    return eligible.find((row) => row.parentId === null) ?? eligible[0];
  });

  const byFixture = new Map<string, PinnapiFixtureCandidate>();
  for (const row of familyPreferred) {
    const key = `${row.league.toLowerCase()}|${row.homeTeam.toLowerCase()}|${row.awayTeam.toLowerCase()}|${Math.round(row.kickoffUtc / 60_000)}`;
    const prior = byFixture.get(key);
    if (
      !prior ||
      (row.hasFullMatch && !prior.hasFullMatch) ||
      (row.hasFullMatch === prior.hasFullMatch && prior.parentId !== null && row.parentId === null)
    ) {
      byFixture.set(key, row);
    }
  }
  return [...byFixture.values()].map(({ hasFullMatch: _hasFullMatch, ...fixture }) => fixture);
}

function collectLiveRows(value: unknown, out: JsonRecord[], depth = 0): void {
  if (depth > 5 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectLiveRows(item, out, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  if (record.event_id !== undefined || record.eventId !== undefined) out.push(record);
  for (const key of ["events", "fixtures", "data", "leagues", "league"]) {
    if (record[key] !== undefined) collectLiveRows(record[key], out, depth + 1);
  }
}

function liveMinutes(value: unknown): number | null {
  const direct = num(value);
  if (direct !== null && direct >= 0) return Math.floor(direct);
  const match = str(value).match(/\d+/);
  return match ? Number(match[0]) : null;
}

/**
 * Reads only score records that show a real live-state signal. A 0-0 payload
 * without live state/minutes is intentionally ignored, so pre-match defaults
 * cannot become a result merely because they resemble a score.
 */
export function parsePinnapiLiveScores(payload: unknown, observedAt = Date.now()): PinnapiLiveScore[] {
  const rows: JsonRecord[] = [];
  collectLiveRows(payload, rows);
  const byEventId = new Map<string, PinnapiLiveScore>();

  for (const row of rows) {
    const eventId = str(row.event_id ?? row.eventId ?? row.id);
    const state = asRecord(row.state);
    const home = asRecord(state?.home);
    const away = asRecord(state?.away);
    const match = asRecord(state?.match);
    const periods = asRecord(row.periods);
    const fullMeta = asRecord(asRecord(periods?.num_0)?.meta);
    const minutes = liveMinutes(match?.minutes ?? state?.minutes ?? row.minutes);
    const stateText =
      str(match?.state ?? match?.status ?? state?.status ?? row.status ?? row.event_status ?? row.live_status) || null;
    const explicitLive =
      state !== null ||
      minutes !== null ||
      row.inplay === true ||
      row.live === true ||
      row.is_live === true ||
      /live|in[\s_-]?play|started|running/i.test(stateText ?? "");
    if (!eventId || !explicitLive) continue;

    // Documented primary fields: state.home.score / state.away.score.
    // Full-match metadata is defensive only, never a pre-match substitute.
    const homeScore = nonNegativeInteger(home?.score ?? state?.home_score ?? fullMeta?.home_score);
    const awayScore = nonNegativeInteger(away?.score ?? state?.away_score ?? fullMeta?.away_score);
    if (homeScore === null || awayScore === null) continue;
    byEventId.set(eventId, { eventId, homeScore, awayScore, minutes, state: stateText, observedAt });
  }
  return [...byEventId.values()];
}

/** IDs positively represented by the bounded live endpoint, score optional. */
export function parsePinnapiLiveEventIds(payload: unknown): string[] {
  const rows: JsonRecord[] = [];
  collectLiveRows(payload, rows);
  const eventIds = new Set<string>();
  for (const row of rows) {
    const eventId = str(row.event_id ?? row.eventId ?? row.id);
    const state = asRecord(row.state);
    const match = asRecord(state?.match);
    const stateMinutes = state ? state.minutes : undefined;
    const stateText =
      str(match?.state ?? match?.status ?? state?.status ?? row.status ?? row.event_status ?? row.live_status) || "";
    if (
      eventId &&
      (state !== null ||
        liveMinutes(match?.minutes ?? stateMinutes ?? row.minutes) !== null ||
        row.inplay === true ||
        row.live === true ||
        row.is_live === true ||
        /live|in[\s_-]?play|started|running/i.test(stateText))
    ) {
      // Keep a live ID even if its individual score row is incomplete, so it
      // cannot falsely look like disappearance/end after a prior observation.
      eventIds.add(eventId);
    }
  }
  return [...eventIds];
}

function values(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.map(asRecord).filter((v): v is JsonRecord => !!v);
  const record = asRecord(value);
  return record ? Object.values(record).map(asRecord).filter((v): v is JsonRecord => !!v) : [];
}

type ExplicitMain = boolean | null;

function explicitMain(row: JsonRecord): ExplicitMain {
  if (typeof row.is_main === "boolean") return row.is_main;
  if (typeof row.main === "boolean") return row.main;
  return null;
}

interface TwoSidedLine {
  lineValue: number;
  first: number | null;
  second: number | null;
  explicitMain: ExplicitMain;
}

/**
 * PinnAPI line arrays/maps do not document ordering as main-market metadata.
 * Preserve a provider boolean when present. With no boolean anywhere, the
 * only defensible inference is a sole complete line; multiple complete lines
 * remain unmarked so downstream stage-main selection fails closed.
 */
function resolvedMainLines(lines: TwoSidedLine[]): Set<number> {
  const explicitlyMain = new Set(
    lines.filter((line) => line.explicitMain === true).map((line) => line.lineValue),
  );
  if (lines.some((line) => line.explicitMain !== null)) return explicitlyMain;
  const complete = lines.filter((line) => line.first !== null && line.second !== null);
  return complete.length === 1 ? new Set([complete[0].lineValue]) : new Set();
}

function cornerEvent(row: JsonRecord): boolean {
  // PinnAPI returns corners as child fixtures. Never infer corners from an
  // ordinary parent price tree or from a period/market name alone.
  const identity = [
    row.league_name,
    row.league,
    row.home,
    row.away,
    row.special_category,
    row.special_units,
  ]
    .map(str)
    .join(" ");
  return /(^|[^a-z])corners?([^a-z]|$)/i.test(identity.replace(/[_-]+/g, " "));
}

/** Supports PinnAPI's arrays and its line-keyed special-market maps. */
function specialLineRows(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.map(asRecord).filter((row): row is JsonRecord => !!row);
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([line, quote]) => {
    const row = asRecord(quote);
    return row ? [{ ...row, line: row.line ?? line }] : [];
  });
}

/**
 * Strict full-match total-corners parser for
 * `/kit/v1/prematch/markets?event_id=…&include_specials=1`.
 *
 * Corners are separate PinnAPI child events. This intentionally fails closed:
 * exactly one corner child must expose `periods.num_0`, and each emitted total
 * must be an exact quarter line with both O/U prices on that same line.
 * First-half/derivative periods and ambiguous children are never merged into
 * the standard match prices.
 */
export function parsePinnapiCornerLines(payload: unknown, requestedEventId = ""): PinnapiCornerLines {
  const root = asRecord(payload) ?? {};
  const events = Array.isArray(root.events) ? root.events.map(asRecord).filter((row): row is JsonRecord => !!row) : [];
  const candidates = events.filter((event) => cornerEvent(event) && asRecord(asRecord(event.periods)?.num_0) !== null);
  if (candidates.length !== 1) {
    return {
      eventId: requestedEventId,
      cornerEventId: null,
      candidateCount: candidates.length,
      marketStatus: candidates.length > 1 ? "ambiguous" : "unavailable",
      prices: [],
    };
  }

  const child = candidates[0];
  const period = asRecord(asRecord(child.periods)?.num_0);
  if (!period) {
    return { eventId: requestedEventId, cornerEventId: null, candidateCount: 0, marketStatus: "unavailable", prices: [] };
  }
  const sourceAt = sourceUpdatedAt(child, period);
  const complete: Array<{ lineValue: number; over: number; under: number; isMain: boolean }> = [];
  for (const total of specialLineRows(period.totals ?? period.total)) {
    const lineValue = num(total.points ?? total.total ?? total.line);
    const over = validDecimal(total.over ?? total.over_odds);
    const under = validDecimal(total.under ?? total.under_odds);
    if (lineValue === null || lineValue < 0 || !isQuarterStep(lineValue) || over === null || under === null) continue;
    complete.push({
      lineValue,
      over,
      under,
      isMain: total.is_main === true || total.main === true,
    });
  }
  // With no explicit provider main flag, retain all valid lines but identify
  // the balanced price as main. This never manufactures a line.
  const balanced = complete.length
    ? complete.reduce((best, row) => (Math.abs(row.over - row.under) < Math.abs(best.over - best.under) ? row : best))
    : null;
  const prices = complete.flatMap((row): ProviderPrice[] => [
    {
      market: "COU",
      lineValue: row.lineValue,
      isMain: row.isMain || balanced?.lineValue === row.lineValue,
      selection: "O",
      decimalOdds: row.over,
      sourceUpdatedAt: sourceAt,
    },
    {
      market: "COU",
      lineValue: row.lineValue,
      isMain: row.isMain || balanced?.lineValue === row.lineValue,
      selection: "U",
      decimalOdds: row.under,
      sourceUpdatedAt: sourceAt,
    },
  ]);
  return {
    eventId: str(root.event_id ?? root.eventId) || requestedEventId,
    cornerEventId: str(child.event_id ?? child.eventId ?? child.id) || null,
    candidateCount: 1,
    marketStatus: str(period.status ?? child.status ?? root.status) || null,
    prices,
  };
}

function sourceUpdatedAt(payload: JsonRecord, period: JsonRecord): number {
  const raw = period.updated_at ?? period.updatedAt ?? payload.source_timestamp ?? payload.last ?? payload.updated_at;
  if (raw === undefined || raw === null || str(raw) === "") return Date.now();
  const n = typeof raw === "number" ? raw : Number(str(raw));
  if (Number.isFinite(n)) return n < 10_000_000_000 ? n * 1000 : n;
  const parsed = Date.parse(str(raw));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function fullMatchPeriod(payload: JsonRecord): JsonRecord | null {
  const periods = asRecord(payload.periods);
  if (periods) return asRecord(periods.num_0);
  // /prematch/lines is the compact, full-match-only endpoint. Its current
  // response omits the periods wrapper, so its root price object represents
  // num_0. Do not use this fallback when a period tree is present but num_0 is
  // absent: that would allow a half/derivative period to be mislabelled.
  return payload.money_line !== undefined || payload.moneyline !== undefined || payload.spreads !== undefined || payload.totals !== undefined
    ? payload
    : null;
}

/**
 * Parses only full-match `periods.num_0` prices. The compact /lines endpoint
 * omits that wrapper but is itself the documented full-match representation.
 * Lines must already be exact quarter steps; values are never rounded into a
 * tradeable line.
 */
export function parsePinnapiLines(payload: unknown, requestedEventId = ""): PinnapiLines {
  const root = asRecord(payload) ?? {};
  const period = fullMatchPeriod(root);
  const eventId = str(root.event_id ?? root.eventId) || requestedEventId;
  const marketStatus = period ? str(period.status ?? root.status) || null : str(root.status) || null;
  if (!period) return { eventId, marketStatus, prices: [] };

  const now = sourceUpdatedAt(root, period);
  const prices: ProviderPrice[] = [];
  const moneyline = asRecord(period.moneyline ?? period.money_line ?? period["1x2"]);
  if (moneyline) {
    const home = validDecimal(moneyline.home ?? moneyline.home_odds);
    const draw = validDecimal(moneyline.draw ?? moneyline.draw_odds);
    const away = validDecimal(moneyline.away ?? moneyline.away_odds);
    if (home !== null) prices.push({ market: "1X2", lineValue: null, isMain: true, selection: "H", decimalOdds: home, sourceUpdatedAt: now });
    if (draw !== null) prices.push({ market: "1X2", lineValue: null, isMain: true, selection: "D", decimalOdds: draw, sourceUpdatedAt: now });
    if (away !== null) prices.push({ market: "1X2", lineValue: null, isMain: true, selection: "A", decimalOdds: away, sourceUpdatedAt: now });
  }

  const spreads = values(period.spreads ?? period.handicaps).flatMap((spread): TwoSidedLine[] => {
    const lineValue = num(spread.hdp ?? spread.handicap ?? spread.line);
    if (lineValue === null || !isQuarterStep(lineValue)) return [];
    return [{
      lineValue,
      first: validDecimal(spread.home ?? spread.home_odds),
      second: validDecimal(spread.away ?? spread.away_odds),
      explicitMain: explicitMain(spread),
    }];
  });
  const mainSpreads = resolvedMainLines(spreads);
  for (const spread of spreads) {
    // PinnAPI's hdp is already home-perspective: negative = home gives.
    const isMain = mainSpreads.has(spread.lineValue);
    if (spread.first !== null) prices.push({ market: "AH", lineValue: spread.lineValue, isMain, selection: "H", decimalOdds: spread.first, sourceUpdatedAt: now });
    if (spread.second !== null) prices.push({ market: "AH", lineValue: spread.lineValue, isMain, selection: "A", decimalOdds: spread.second, sourceUpdatedAt: now });
  }

  const totals = values(period.totals ?? period.total).flatMap((total): TwoSidedLine[] => {
    const lineValue = num(total.points ?? total.total ?? total.line);
    if (lineValue === null || lineValue < 0 || !isQuarterStep(lineValue)) return [];
    return [{
      lineValue,
      first: validDecimal(total.over ?? total.over_odds),
      second: validDecimal(total.under ?? total.under_odds),
      explicitMain: explicitMain(total),
    }];
  });
  const mainTotals = resolvedMainLines(totals);
  for (const total of totals) {
    const isMain = mainTotals.has(total.lineValue);
    if (total.first !== null) prices.push({ market: "OU", lineValue: total.lineValue, isMain, selection: "O", decimalOdds: total.first, sourceUpdatedAt: now });
    if (total.second !== null) prices.push({ market: "OU", lineValue: total.lineValue, isMain, selection: "U", decimalOdds: total.second, sourceUpdatedAt: now });
  }

  return { eventId, marketStatus, prices };
}

export class PinnapiProvider {
  private lastSuccessAt: number | null = null;
  private warnings: string[] = [];

  status() {
    const config = pinnapiConfig();
    return { configured: config.configured, lastSuccessAt: this.lastSuccessAt, warnings: [...this.warnings] };
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
    if (this.warnings.length > 5) this.warnings.shift();
  }

  private endpoint(path: string): string {
    return `${pinnapiConfig().baseUrl}${path}`;
  }

  private requireConfigured(): void {
    if (!pinnapiConfig().configured) throw new Error("PinnAPI credentials are not configured");
  }

  /** Raw, read-only payload for bounded market-capability validation. */
  async fetchFixturePayload(): Promise<unknown> {
    this.requireConfigured();
    return fetchJson<unknown>(this.endpoint("/kit/v1/prematch/fixtures?sport_id=1"), {
      headers: pinnapiHeaders(),
      timeoutMs: 25_000,
      retries: 1,
    });
  }

  async fetchFixtures(): Promise<PinnapiFixture[]> {
    this.requireConfigured();
    try {
      const payload = await this.fetchFixturePayload();
      const fixtures = parsePinnapiFixtures(payload);
      this.lastSuccessAt = Date.now();
      return fixtures;
    } catch (err) {
      this.warn(`PinnAPI fixtures unavailable: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Raw, read-only event line payload for capability validation. */
  async fetchEventLinePayload(
    eventId: string,
    request: Pick<FetchOpts, "timeoutMs" | "retries"> = {},
  ): Promise<unknown> {
    this.requireConfigured();
    const safeId = encodeURIComponent(eventId);
    return fetchJson<unknown>(this.endpoint(`/kit/v1/prematch/lines?event_id=${safeId}`), {
      headers: pinnapiHeaders(),
      timeoutMs: request.timeoutMs ?? 25_000,
      retries: request.retries ?? 1,
    });
  }

  /** Raw special-markets payload. Kept separate from normal match prices. */
  async fetchEventCornerLinePayload(eventId: string): Promise<unknown> {
    this.requireConfigured();
    const safeId = encodeURIComponent(eventId);
    return fetchJson<unknown>(this.endpoint(`/kit/v1/prematch/markets?event_id=${safeId}&include_specials=1`), {
      headers: pinnapiHeaders(),
      timeoutMs: 25_000,
      retries: 1,
    });
  }

  async fetchEventLines(
    eventId: string,
    request: Pick<FetchOpts, "timeoutMs" | "retries"> = {},
  ): Promise<PinnapiLines> {
    this.requireConfigured();
    try {
      const payload = await this.fetchEventLinePayload(eventId, request);
      const result = parsePinnapiLines(payload, eventId);
      this.lastSuccessAt = Date.now();
      return result;
    } catch (err) {
      this.warn(`PinnAPI lines unavailable: ${(err as Error).message}`);
      throw err;
    }
  }

  async fetchEventCornerLines(eventId: string): Promise<PinnapiCornerLines> {
    this.requireConfigured();
    try {
      const payload = await this.fetchEventCornerLinePayload(eventId);
      const result = parsePinnapiCornerLines(payload, eventId);
      this.lastSuccessAt = Date.now();
      return result;
    } catch (err) {
      this.warn(`PinnAPI corner lines unavailable: ${(err as Error).message}`);
      throw err;
    }
  }

  async fetchMatchPrices(
    eventId: string,
    request: Pick<FetchOpts, "timeoutMs" | "retries"> = {},
  ): Promise<ProviderPrice[]> {
    return (await this.fetchEventLines(eventId, request)).prices;
  }

  /**
   * Exactly one bounded request for the complete football live market. Callers
   * filter this response to tracked event IDs; this method never fans out.
   */
  async fetchLiveScoreSnapshot(): Promise<PinnapiLiveScoreSnapshot> {
    this.requireConfigured();
    const observedAt = Date.now();
    try {
      const payload = await fetchJson<unknown>(this.endpoint("/kit/v1/markets?sport_id=1&event_type=live"), {
        headers: pinnapiHeaders(),
        timeoutMs: 25_000,
        retries: 1,
      });
      const scores = parsePinnapiLiveScores(payload, observedAt);
      const liveEventIds = parsePinnapiLiveEventIds(payload);
      this.lastSuccessAt = observedAt;
      return { observedAt, scores, liveEventIds };
    } catch (err) {
      this.warn(`PinnAPI live markets unavailable: ${(err as Error).message}`);
      throw err;
    }
  }
}
