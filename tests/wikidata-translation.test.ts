import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const dbPath = `/tmp/odds-radar-wikidata-translation-${process.pid}.db`;
process.env.RADAR_DB = dbPath;

let rawDb: typeof import("../server/lib/store").rawDb;
let migrate: typeof import("../server/lib/store").migrate;
let shouldFetchTranslation: typeof import("../server/lib/pinnacleTranslation").shouldFetchTranslation;
let createWikidataEntityLookup: typeof import("../server/lib/wikidataTranslation").createWikidataEntityLookup;
let normaliseEnglishEntityName: typeof import("../server/lib/wikidataTranslation").normaliseEnglishEntityName;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function successfulFetch(labels: Record<string, string> = { "zh-hk": "阿仙奴" }) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.searchParams.get("action") === "wbsearchentities") {
      return response({
        search: [{
          id: "Q9617",
          label: "Arsenal F.C.",
          description: "English association football club",
        }],
      });
    }
    return response({
      entities: {
        Q9617: {
          labels: Object.fromEntries(
            Object.entries(labels).map(([language, value]) => [language, { language, value }]),
          ),
        },
      },
    });
  });
}

beforeAll(async () => {
  const store = await import("../server/lib/store");
  const translation = await import("../server/lib/pinnacleTranslation");
  const wikidata = await import("../server/lib/wikidataTranslation");
  rawDb = store.rawDb;
  migrate = store.migrate;
  shouldFetchTranslation = translation.shouldFetchTranslation;
  createWikidataEntityLookup = wikidata.createWikidataEntityLookup;
  normaliseEnglishEntityName = wikidata.normaliseEnglishEntityName;
});

beforeEach(() => {
  rawDb.prepare("DELETE FROM pinnacle_translation_entities").run();
});

afterAll(() => {
  rawDb.close();
  for (const suffix of ["", "-shm", "-wal"]) {
    try { rmSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
  }
});

describe("Wikidata entity fallback", () => {
  it("normalizes equivalent English cache keys and reuses one successful lookup", async () => {
    const fetchFn = successfulFetch();
    const resolver = createWikidataEntityLookup({ fetchFn, retries: 0 });
    const first = await resolver.lookup("Arsenal F.C.", "team");
    const second = await resolver.lookup(" arsenal-f.c. ", "team");
    expect(normaliseEnglishEntityName(" Arsenal-F.C. ")).toBe("arsenalfc");
    expect(first?.label).toBe("阿仙奴");
    expect(second).toEqual(first);
    expect(fetchFn).toHaveBeenCalledTimes(2); // one search + one label request
    expect(rawDb.prepare("SELECT COUNT(*) n FROM pinnacle_translation_entities").get()).toEqual({ n: 1 });
  });

  it("prefers zh-hk, then zh-tw, then zh-hant, then zh", async () => {
    const cases: Array<[Record<string, string>, string, string]> = [
      [{ "zh-hk": "香港", "zh-tw": "台灣", "zh-hant": "繁體", zh: "简体" }, "香港", "zh-hk"],
      [{ "zh-tw": "台灣", "zh-hant": "繁體", zh: "简体" }, "台灣", "zh-tw"],
      [{ "zh-hant": "繁體", zh: "简体" }, "繁體", "zh-hant"],
      [{ zh: "简体标签" }, "簡體標籤", "zh"],
    ];
    for (const [labels, expectedLabel, expectedLanguage] of cases) {
      rawDb.prepare("DELETE FROM pinnacle_translation_entities").run();
      const result = await createWikidataEntityLookup({
        fetchFn: successfulFetch(labels),
        retries: 0,
      }).lookup("Arsenal F.C.", "team");
      expect(result?.label).toBe(expectedLabel);
      expect(result?.language).toBe(expectedLanguage);
    }
  });

  it("rejects irrelevant entities and selects a relevant football competition", async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get("action") === "wbsearchentities") {
        return response({
          search: [
            { id: "QPERSON", label: "Premier League", description: "British television presenter" },
            { id: "Q9448", label: "Premier League", description: "top-level association football league in England" },
          ],
        });
      }
      expect(url.searchParams.get("ids")).toBe("Q9448");
      return response({ entities: { Q9448: { labels: { "zh-hk": { value: "英格蘭超級足球聯賽" } } } } });
    });
    const result = await createWikidataEntityLookup({ fetchFn, retries: 0 })
      .lookup("Premier League", "league");
    expect(result?.wikidataId).toBe("Q9448");
  });

  it("does not accept an irrelevant arbitrary first team result", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({
      search: [{ id: "QSONG", label: "Rangers", description: "song by a rock band" }],
    }));
    const result = await createWikidataEntityLookup({ fetchFn, retries: 0 })
      .lookup("Rangers FC", "team");
    expect(result).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const cached = rawDb.prepare(
      "SELECT attempt_count,last_error FROM pinnacle_translation_entities WHERE normalized_name='rangersfc'",
    ).get() as { attempt_count: number; last_error: string };
    expect(cached.attempt_count).toBe(1);
    expect(cached.last_error).toContain("no relevant team result");
  });

  it("caches request errors and returns null without throwing into fixture flow", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network timeout"));
    const resolver = createWikidataEntityLookup({ fetchFn, retries: 1, retryDelay: async () => undefined });
    await expect(resolver.lookup("Timeout United", "team")).resolves.toBeNull();
    await expect(resolver.lookup("Timeout United", "team")).resolves.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const row = rawDb.prepare(
      "SELECT attempt_count,last_error FROM pinnacle_translation_entities WHERE normalized_name='timeoutunited'",
    ).get() as { attempt_count: number; last_error: string };
    expect(row.attempt_count).toBe(1);
    expect(row.last_error).toContain("network timeout");
  });

  it("aborts a timed-out request and falls back to null", async () => {
    const fetchFn = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
      }),
    );
    const result = await createWikidataEntityLookup({
      fetchFn: fetchFn as typeof fetch,
      retries: 0,
      timeoutMs: 5,
    }).lookup("Slow Town F.C.", "team");
    expect(result).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const row = rawDb.prepare(
      "SELECT last_error FROM pinnacle_translation_entities WHERE normalized_name='slowtownfc'",
    ).get() as { last_error: string };
    expect(row.last_error).toContain("aborted by timeout");
  });

  it("caps a refresh context at 60 distinct entity lookups", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({ search: [] }));
    const resolver = createWikidataEntityLookup({ fetchFn, retries: 0, maxDistinct: 60 });
    await Promise.all(Array.from({ length: 61 }, (_, i) => resolver.lookup(`Club ${i}`, "team")));
    expect(fetchFn).toHaveBeenCalledTimes(60);
    expect(resolver.wasBudgetExhausted?.()).toBe(true);
    expect((rawDb.prepare("SELECT COUNT(*) n FROM pinnacle_translation_entities").get() as { n: number }).n).toBe(60);
  });

  it("never has more than three Wikidata HTTP requests in flight", async () => {
    let active = 0;
    let peak = 0;
    const fetchFn = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return response({ search: [] });
    });
    const resolver = createWikidataEntityLookup({ fetchFn, retries: 0 });
    await Promise.all(Array.from({ length: 9 }, (_, i) => resolver.lookup(`Concurrent ${i}`, "team")));
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe("pinnacle translation migration", () => {
  it("preserves 67 legacy rows, expands only the source CHECK, and immediately retries old null attempts", () => {
    rawDb.exec(`
      DROP INDEX IF EXISTS pinnacle_translations_updated_idx;
      DROP TABLE pinnacle_translations;
      DELETE FROM app_state WHERE key='pinnacle_wikidata_retry_v1';
      CREATE TABLE pinnacle_translations (
        pinnapi_id TEXT PRIMARY KEY,
        zh_home TEXT,
        zh_away TEXT,
        zh_league TEXT,
        source TEXT NOT NULL CHECK(source IN ('titan','optic')),
        updated_at INTEGER NOT NULL,
        attempted_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT);
      CREATE INDEX pinnacle_translations_updated_idx ON pinnacle_translations(updated_at);
    `);
    const insert = rawDb.prepare(
      `INSERT INTO pinnacle_translations
       VALUES(?,?,?,?,?,?,?,?,?)`,
    );
    for (let i = 0; i < 67; i++) {
      const translated = i === 0;
      insert.run(
        `legacy-${i}`,
        translated ? "阿仙奴" : null,
        translated ? "利物浦" : null,
        translated ? "英超" : null,
        "titan",
        1000 + i,
        2000 + i,
        translated ? 0 : 3,
        translated ? null : "old miss",
      );
    }

    migrate();

    const createSql = (rawDb.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='pinnacle_translations'",
    ).get() as { sql: string }).sql;
    expect(createSql).toMatch(/source\s+IN\s*\('titan','optic','wikidata'\)/i);
    expect((rawDb.prepare("SELECT COUNT(*) n FROM pinnacle_translations").get() as { n: number }).n).toBe(67);
    const success = rawDb.prepare(
      "SELECT zh_home,attempted_at,attempt_count FROM pinnacle_translations WHERE pinnapi_id='legacy-0'",
    ).get() as { zh_home: string; attempted_at: number; attempt_count: number };
    expect(success).toEqual({ zh_home: "阿仙奴", attempted_at: 2000, attempt_count: 0 });
    const oldNull = rawDb.prepare(
      "SELECT zh_home,zh_league,attempted_at,attempt_count,last_error FROM pinnacle_translations WHERE pinnapi_id='legacy-1'",
    ).get() as {
      zh_home: null; zh_league: null; attempted_at: null; attempt_count: number; last_error: null;
    };
    expect(oldNull).toEqual({
      zh_home: null,
      zh_league: null,
      attempted_at: null,
      attempt_count: 0,
      last_error: null,
    });
    expect(shouldFetchTranslation(oldNull, 3000)).toBe(true);
    expect(() => rawDb.prepare(
      `INSERT INTO pinnacle_translations
       VALUES('wikidata-source','甲','乙','聯賽','wikidata',1,1,0,NULL)`,
    ).run()).not.toThrow();
  });
});
