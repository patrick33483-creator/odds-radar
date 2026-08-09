import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parsePinnapiFixtures, type PinnapiProvider } from "../providers/pinnapi";

type RecordValue = Record<string, unknown>;

export interface CornerQuoteEvidence {
  path: string;
  line: number;
  over: number;
  under: number;
  sourceTimestamp: string | number | null;
}

export interface CornerPayloadAnalysis {
  signalPaths: string[];
  quotes: CornerQuoteEvidence[];
}

export interface PinnapiCornerValidationReport {
  generatedAt: string;
  status: "VERIFIED" | "INCONCLUSIVE" | "NOT_AVAILABLE";
  bettingEnabled: false;
  fixturesAvailable: number;
  fixturesInspected: number;
  responsesWithSignals: number;
  responsesWithCompleteQuotes: number;
  quotesWithSourceTimestamp: number;
  signalPaths: string[];
  events: Array<{
    eventId: string;
    match: string;
    kickoffUtc: number;
    signalPaths: string[];
    completeQuotes: number;
    quotesWithSourceTimestamp: number;
    error?: string;
  }>;
  conclusion: string;
}

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function finite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function decimal(value: unknown): number | null {
  const parsed = finite(value);
  return parsed !== null && parsed > 1 ? parsed : null;
}

function isCornerSignal(value: string): boolean {
  return /(^|[^a-z])(corner|corners)([^a-z]|$)|角球/i.test(value.replace(/[_-]+/g, " "));
}

function timestampOf(value: RecordValue): string | number | null {
  for (const key of ["updated_at", "updatedAt", "source_timestamp", "timestamp", "last"]) {
    const candidate = value[key];
    if (typeof candidate === "string" || typeof candidate === "number") return candidate;
  }
  return null;
}

function quoteFrom(value: RecordValue, path: string, inheritedTimestamp: string | number | null): CornerQuoteEvidence | null {
  const line = finite(value.points ?? value.total ?? value.line ?? value.hdp);
  const over = decimal(value.over ?? value.over_odds);
  const under = decimal(value.under ?? value.under_odds);
  if (line === null || line < 0 || over === null || under === null) return null;
  return { path, line, over, under, sourceTimestamp: timestampOf(value) ?? inheritedTimestamp };
}

/** Pure raw-payload inspection. It never maps a corner quote into a bet. */
export function analyzeCornerPayload(payload: unknown): CornerPayloadAnalysis {
  const signals = new Set<string>();
  const quotes: CornerQuoteEvidence[] = [];

  const walk = (
    value: unknown,
    path: string,
    cornerContext: boolean,
    inheritedTimestamp: string | number | null,
    depth: number,
  ): void => {
    if (depth > 10 || value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, cornerContext, inheritedTimestamp, depth + 1));
      return;
    }
    const object = record(value);
    if (!object) return;
    const localTimestamp = timestampOf(object) ?? inheritedTimestamp;
    const descriptor = [
      object.market,
      object.market_name,
      object.name,
      object.type,
      object.period,
      object.period_name,
    ].filter((item): item is string => typeof item === "string").join(" ");
    const localCorner = cornerContext || isCornerSignal(descriptor);
    if (localCorner) {
      signals.add(path);
      const quote = quoteFrom(object, path, localTimestamp);
      if (quote) quotes.push(quote);
    }
    for (const [key, child] of Object.entries(object)) {
      const childPath = path ? `${path}.${key}` : key;
      const childCorner = localCorner || isCornerSignal(key);
      if (childCorner) signals.add(childPath);
      walk(child, childPath, childCorner, localTimestamp, depth + 1);
    }
  };

  walk(payload, "$", false, null, 0);
  return { signalPaths: [...signals].sort(), quotes };
}

function reportPath(): string {
  return resolve(process.env.RADAR_CORNER_VALIDATION_REPORT ?? "data/pinnapi-corner-validation.json");
}

export async function readCornerValidationReport(): Promise<PinnapiCornerValidationReport | null> {
  try {
    return JSON.parse(await readFile(reportPath(), "utf8")) as PinnapiCornerValidationReport;
  } catch {
    return null;
  }
}

export async function runPinnapiCornerValidation(
  provider: PinnapiProvider,
  options: { limit?: number } = {},
): Promise<PinnapiCornerValidationReport> {
  const now = Date.now();
  const limit = Math.max(1, Math.min(30, Math.floor(options.limit ?? 20)));
  const fixturePayload = await provider.fetchFixturePayload();
  const fixtures = parsePinnapiFixtures(fixturePayload)
    .filter((fixture) => fixture.kickoffUtc > now)
    .sort((a, b) => a.kickoffUtc - b.kickoffUtc)
    .slice(0, limit);
  const events: PinnapiCornerValidationReport["events"] = [];

  for (let offset = 0; offset < fixtures.length; offset += 4) {
    const chunk = fixtures.slice(offset, offset + 4);
    const checked = await Promise.all(chunk.map(async (fixture) => {
      try {
        const payload = await provider.fetchEventLinePayload(fixture.providerMatchId);
        const analysis = analyzeCornerPayload(payload);
        return {
          eventId: fixture.providerMatchId,
          match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
          kickoffUtc: fixture.kickoffUtc,
          signalPaths: analysis.signalPaths.slice(0, 30),
          completeQuotes: analysis.quotes.length,
          quotesWithSourceTimestamp: analysis.quotes.filter((quote) => quote.sourceTimestamp !== null).length,
        };
      } catch (error) {
        return {
          eventId: fixture.providerMatchId,
          match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
          kickoffUtc: fixture.kickoffUtc,
          signalPaths: [],
          completeQuotes: 0,
          quotesWithSourceTimestamp: 0,
          error: (error as Error).message,
        };
      }
    }));
    events.push(...checked);
  }

  const responsesWithSignals = events.filter((event) => event.signalPaths.length > 0).length;
  const responsesWithCompleteQuotes = events.filter((event) => event.completeQuotes > 0).length;
  const quotesWithSourceTimestamp = events.reduce((sum, event) => sum + event.quotesWithSourceTimestamp, 0);
  const status: PinnapiCornerValidationReport["status"] =
    responsesWithCompleteQuotes > 0 && quotesWithSourceTimestamp > 0
      ? "VERIFIED"
      : responsesWithSignals > 0
        ? "INCONCLUSIVE"
        : "NOT_AVAILABLE";
  const report: PinnapiCornerValidationReport = {
    generatedAt: new Date().toISOString(),
    status,
    bettingEnabled: false,
    fixturesAvailable: parsePinnapiFixtures(fixturePayload).filter((fixture) => fixture.kickoffUtc > now).length,
    fixturesInspected: events.length,
    responsesWithSignals,
    responsesWithCompleteQuotes,
    quotesWithSourceTimestamp,
    signalPaths: [...new Set(events.flatMap((event) => event.signalPaths))].slice(0, 100),
    events,
    conclusion:
      status === "VERIFIED"
        ? "找到具完整大／細雙邊賠率及來源時間的角球盤；目前仍維持只讀，未啟用投注。"
        : status === "INCONCLUSIVE"
          ? "找到角球相關欄位，但未同時確認完整雙邊賠率及來源時間；不可用於 EV 或投注。"
          : "本批未開賽足球賽事的 PinnAPI 回應未提供可驗證角球盤；不可用於 EV 或投注。",
  };
  const destination = reportPath();
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}
