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

import { fetchJson } from "../lib/http";
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
  const n = typeof value === "number" ? value : Number(str(value));
  return Number.isFinite(n) ? n : null;
}

function validDecimal(value: unknown): number | null {
  const n = num(value);
  return n !== null && n > 1 ? n : null;
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

function values(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.map(asRecord).filter((v): v is JsonRecord => !!v);
  const record = asRecord(value);
  return record ? Object.values(record).map(asRecord).filter((v): v is JsonRecord => !!v) : [];
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

  for (const [index, spread] of values(period.spreads ?? period.handicaps).entries()) {
    const lineValue = num(spread.hdp ?? spread.handicap ?? spread.line);
    const home = validDecimal(spread.home ?? spread.home_odds);
    const away = validDecimal(spread.away ?? spread.away_odds);
    if (lineValue === null || !isQuarterStep(lineValue)) continue;
    // PinnAPI's hdp is already home-perspective: negative = home gives.
    const isMain = spread.is_main !== false && spread.main !== false && (spread.is_main === true || spread.main === true || index === 0);
    if (home !== null) prices.push({ market: "AH", lineValue, isMain, selection: "H", decimalOdds: home, sourceUpdatedAt: now });
    if (away !== null) prices.push({ market: "AH", lineValue, isMain, selection: "A", decimalOdds: away, sourceUpdatedAt: now });
  }

  for (const [index, total] of values(period.totals ?? period.total).entries()) {
    const lineValue = num(total.points ?? total.total ?? total.line);
    const over = validDecimal(total.over ?? total.over_odds);
    const under = validDecimal(total.under ?? total.under_odds);
    if (lineValue === null || lineValue < 0 || !isQuarterStep(lineValue)) continue;
    const isMain = total.is_main !== false && total.main !== false && (total.is_main === true || total.main === true || index === 0);
    if (over !== null) prices.push({ market: "OU", lineValue, isMain, selection: "O", decimalOdds: over, sourceUpdatedAt: now });
    if (under !== null) prices.push({ market: "OU", lineValue, isMain, selection: "U", decimalOdds: under, sourceUpdatedAt: now });
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

  async fetchFixtures(): Promise<PinnapiFixture[]> {
    this.requireConfigured();
    try {
      const payload = await fetchJson<unknown>(this.endpoint("/kit/v1/prematch/fixtures?sport_id=1"), {
        headers: pinnapiHeaders(),
        timeoutMs: 25_000,
        retries: 1,
      });
      const fixtures = parsePinnapiFixtures(payload);
      this.lastSuccessAt = Date.now();
      return fixtures;
    } catch (err) {
      this.warn(`PinnAPI fixtures unavailable: ${(err as Error).message}`);
      throw err;
    }
  }

  async fetchEventLines(eventId: string): Promise<PinnapiLines> {
    this.requireConfigured();
    const safeId = encodeURIComponent(eventId);
    try {
      const payload = await fetchJson<unknown>(this.endpoint(`/kit/v1/prematch/lines?event_id=${safeId}`), {
        headers: pinnapiHeaders(),
        timeoutMs: 25_000,
        retries: 1,
      });
      const result = parsePinnapiLines(payload, eventId);
      this.lastSuccessAt = Date.now();
      return result;
    } catch (err) {
      this.warn(`PinnAPI lines unavailable: ${(err as Error).message}`);
      throw err;
    }
  }

  async fetchMatchPrices(eventId: string): Promise<ProviderPrice[]> {
    return (await this.fetchEventLines(eventId)).prices;
  }
}
