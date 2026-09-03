import * as OpenCC from "opencc-js";
import {
  getPinnacleTranslationEntity,
  recordPinnacleTranslationEntityFailure,
  recordPinnacleTranslationEntitySuccess,
  type PinnacleTranslationEntityType,
} from "./store";

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const USER_AGENT = "odds-radar-pinnacle-translation/1.0 (Wikidata fallback; contact: github.com/patrick33483-creator/odds-radar)";
const LANGUAGE_PREFERENCE = ["zh-hk", "zh-tw", "zh-hant", "zh"] as const;
const FAILURE_RETRY_MS = 4 * 60 * 60_000;
const MAX_FAILURES = 3;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRIES = 1;
const toHongKongTraditional = OpenCC.Converter({ from: "cn", to: "hk" });

export type WikidataLabelLanguage = typeof LANGUAGE_PREFERENCE[number];
export interface WikidataEntityTranslation {
  label: string;
  language: WikidataLabelLanguage;
  wikidataId: string;
}

export interface WikidataEntityLookup {
  lookup(name: string, entityType: PinnacleTranslationEntityType): Promise<WikidataEntityTranslation | null>;
  wasBudgetExhausted?(): boolean;
}

export class WikidataLookupBudgetExhaustedError extends Error {
  constructor() {
    super("Wikidata entity lookup budget exhausted; defer fixture translation");
    this.name = "WikidataLookupBudgetExhaustedError";
  }
}

interface SearchResult {
  id?: string;
  label?: string;
  description?: string;
  aliases?: string[];
  match?: { type?: string; language?: string; text?: string };
}

interface SearchResponse {
  search?: SearchResult[];
  error?: { info?: string };
}

interface EntityResponse {
  entities?: Record<string, {
    missing?: string;
    labels?: Partial<Record<WikidataLabelLanguage, { value?: string }>>;
  }>;
  error?: { info?: string };
}

interface LookupOptions {
  maxDistinct?: number;
  timeoutMs?: number;
  retries?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
  retryDelay?: (attempt: number) => Promise<void>;
}

class RequestSemaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

// Shared across refresh ticks so overlapping background translations can never
// exceed Wikidata's three-request concurrency ceiling.
const wikidataRequests = new RequestSemaphore(3);

export function normaliseEnglishEntityName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function isRelevantCandidate(
  candidate: SearchResult,
  entityType: PinnacleTranslationEntityType,
  requestedName: string,
  index: number,
): boolean {
  const description = (candidate.description ?? "").toLowerCase();
  const football = /\b(association football|football|soccer|futsal)\b/.test(description);
  if (entityType === "league") {
    return football && /\b(league|competition|tournament|championship|division|cup)\b/.test(description);
  }

  if (football && /\b(club|team|side|organization|organisation)\b/.test(description)) return true;
  // Wikidata occasionally omits a description for smaller clubs. Accept only
  // its strongest possible name signal: the top result with an exact label,
  // alias, or API match text. This deliberately does not accept an arbitrary
  // first result merely because one was returned.
  if (index !== 0) return false;
  const requested = normaliseEnglishEntityName(requestedName);
  const exactNames = [
    candidate.label,
    ...(candidate.aliases ?? []),
    candidate.match?.text,
  ].filter((value): value is string => !!value);
  return exactNames.some((value) => normaliseEnglishEntityName(value) === requested);
}

function selectCandidate(
  results: readonly SearchResult[],
  entityType: PinnacleTranslationEntityType,
  requestedName: string,
): SearchResult | null {
  const relevant = results
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate, index }) => candidate.id && isRelevantCandidate(candidate, entityType, requestedName, index));
  if (!relevant.length) return null;
  const requested = normaliseEnglishEntityName(requestedName);
  relevant.sort((a, b) => {
    const exactA = normaliseEnglishEntityName(a.candidate.label ?? "") === requested ? 1 : 0;
    const exactB = normaliseEnglishEntityName(b.candidate.label ?? "") === requested ? 1 : 0;
    return exactB - exactA || a.index - b.index;
  });
  return relevant[0].candidate;
}

async function fetchJson<T>(
  params: Record<string, string>,
  options: Required<Pick<LookupOptions, "fetchFn" | "timeoutMs" | "retries" | "retryDelay">>,
): Promise<T> {
  const url = new URL(WIKIDATA_API);
  for (const [key, value] of Object.entries({ format: "json", origin: "*", ...params })) {
    url.searchParams.set(key, value);
  }
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await wikidataRequests.run(() => options.fetchFn(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: controller.signal,
      }));
      if (!response.ok) throw new Error(`Wikidata HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < options.retries) await options.retryDelay(attempt + 1);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Wikidata request failed: ${lastError?.message ?? "unknown error"}`);
}

/**
 * Create one tick-scoped lookup context. It deduplicates normalized entities,
 * observes the 60-distinct-entity budget, and persists positive and negative
 * results so later fixtures do not repeatedly call Wikidata.
 */
export function createWikidataEntityLookup(options: LookupOptions = {}): WikidataEntityLookup {
  const maxDistinct = options.maxDistinct ?? 60;
  const now = options.now ?? Date.now;
  const requestOptions = {
    fetchFn: options.fetchFn ?? fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retries: options.retries ?? DEFAULT_RETRIES,
    retryDelay: options.retryDelay ?? ((attempt: number) => new Promise<void>(
      (resolve) => setTimeout(resolve, 200 * attempt),
    )),
  };
  const claimed = new Set<string>();
  const inFlight = new Map<string, Promise<WikidataEntityTranslation | null>>();
  let budgetExhausted = false;

  async function uncachedLookup(
    name: string,
    normalizedName: string,
    entityType: PinnacleTranslationEntityType,
  ): Promise<WikidataEntityTranslation | null> {
    const key = `${entityType}:${normalizedName}`;
    if (!claimed.has(key)) {
      if (claimed.size >= maxDistinct) {
        budgetExhausted = true;
        return null;
      }
      claimed.add(key);
    }

    try {
      const search = await fetchJson<SearchResponse>({
        action: "wbsearchentities",
        search: name,
        language: "en",
        uselang: "en",
        type: "item",
        limit: "8",
      }, requestOptions);
      if (search.error?.info) throw new Error(search.error.info);
      const candidate = selectCandidate(search.search ?? [], entityType, name);
      if (!candidate?.id) throw new Error(`no relevant ${entityType} result`);

      const entities = await fetchJson<EntityResponse>({
        action: "wbgetentities",
        ids: candidate.id,
        props: "labels",
        languages: LANGUAGE_PREFERENCE.join("|"),
      }, requestOptions);
      if (entities.error?.info) throw new Error(entities.error.info);
      const labels = entities.entities?.[candidate.id]?.labels;
      let selected: WikidataEntityTranslation | null = null;
      for (const language of LANGUAGE_PREFERENCE) {
        const value = labels?.[language]?.value?.trim();
        if (!value) continue;
        selected = {
          label: language === "zh" ? toHongKongTraditional(value) : value,
          language,
          wikidataId: candidate.id,
        };
        break;
      }
      if (!selected) throw new Error("no Chinese label in zh-hk/zh-tw/zh-hant/zh");
      recordPinnacleTranslationEntitySuccess({
        normalizedName,
        entityType,
        zhLabel: selected.label,
        labelLanguage: selected.language,
        wikidataId: selected.wikidataId,
      }, now());
      return selected;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordPinnacleTranslationEntityFailure({
        normalizedName,
        entityType,
        lastError: message.slice(0, 500),
      }, now());
      return null;
    }
  }

  return {
    lookup(name, entityType) {
      const normalizedName = normaliseEnglishEntityName(name);
      if (!normalizedName) return Promise.resolve(null);
      const cached = getPinnacleTranslationEntity(normalizedName, entityType);
      if (cached?.zh_label && cached.wikidata_id && cached.label_language) {
        return Promise.resolve({
          label: cached.zh_label,
          language: cached.label_language as WikidataLabelLanguage,
          wikidataId: cached.wikidata_id,
        });
      }
      if (
        cached
        && (cached.attempt_count >= MAX_FAILURES
          || (cached.attempted_at !== null && now() - cached.attempted_at < FAILURE_RETRY_MS))
      ) {
        return Promise.resolve(null);
      }

      const key = `${entityType}:${normalizedName}`;
      const running = inFlight.get(key);
      if (running) return running;
      const promise = uncachedLookup(name, normalizedName, entityType)
        .finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return promise;
    },
    wasBudgetExhausted() {
      return budgetExhausted;
    },
  };
}
