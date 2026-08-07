import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderPrice } from "./types";
import type { PinnacleFixture } from "./pinnacle";

const execFileAsync = promisify(execFile);

interface OpticFixture {
  id: string;
  start_date: string;
  status?: string;
  is_live?: boolean;
  league?: { name?: string };
  home_team_display?: string;
  away_team_display?: string;
  home_competitors?: Array<{ name?: string }>;
  away_competitors?: Array<{ name?: string }>;
  odds?: OpticOdd[];
}

interface OpticOdd {
  sportsbook?: string;
  market?: string;
  name?: string;
  selection?: string;
  points?: number | null;
  price?: number | string;
  timestamp?: number | string;
  is_main?: boolean;
}

interface ToolEnvelope {
  status_code?: number;
  data?: { cursor?: string | null; data?: OpticFixture[] };
  error?: string;
}

async function callOptic(path: string, params: Record<string, unknown>): Promise<ToolEnvelope> {
  const payload = JSON.stringify({
    source_id: "opticodds",
    tool_name: "opticodds",
    arguments: { method: "GET", path, params },
  });
  const { stdout } = await execFileAsync("external-tool", ["call", payload], {
    timeout: 90_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as ToolEnvelope;
  if ((parsed.status_code ?? 500) >= 400 || parsed.error) {
    throw new Error(parsed.error ?? `OpticOdds HTTP ${parsed.status_code}`);
  }
  return parsed;
}

function fixtureTeams(f: OpticFixture): { home: string; away: string } {
  return {
    home: f.home_team_display ?? f.home_competitors?.[0]?.name ?? "",
    away: f.away_team_display ?? f.away_competitors?.[0]?.name ?? "",
  };
}

export function parseOpticFixtures(rows: OpticFixture[]): PinnacleFixture[] {
  return rows
    .map((f) => {
      const teams = fixtureTeams(f);
      return {
        providerMatchId: f.id,
        league: f.league?.name ?? "",
        homeTeam: teams.home,
        awayTeam: teams.away,
        kickoffUtc: Date.parse(f.start_date),
        statusText: f.status ?? "unplayed",
        homeScore: null,
        awayScore: null,
        halfHome: null,
        halfAway: null,
        handicapVal: null,
        totalVal: null,
      };
    })
    .filter((f) => f.providerMatchId && f.homeTeam && f.awayTeam && Number.isFinite(f.kickoffUtc));
}

function sameTeam(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]/g, "");
  return !!a && !!b && norm(a) === norm(b);
}

/**
 * Normalize OpticOdds' Pinnacle quotes to the radar convention:
 * lineValue is always the handicap applied to the HKJC home team.
 */
export function parseOpticPrices(fixture: OpticFixture, reversed = false): ProviderPrice[] {
  const { home, away } = fixtureTeams(fixture);
  const out: ProviderPrice[] = [];
  for (const q of fixture.odds ?? []) {
    if ((q.sportsbook ?? "").toLowerCase() !== "pinnacle") continue;
    const decimalOdds = Number(q.price);
    if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) continue;
    const marketName = (q.market ?? "").toLowerCase();
    const selectionName = q.selection || q.name || "";
    const sourceUpdatedAt = Number(q.timestamp);
    const timestampMs = Number.isFinite(sourceUpdatedAt)
      ? sourceUpdatedAt < 10_000_000_000
        ? Math.round(sourceUpdatedAt * 1000)
        : Math.round(sourceUpdatedAt)
      : null;

    if (marketName.includes("asian handicap")) {
      const points = Number(q.points);
      if (!Number.isFinite(points)) continue;
      const providerHome = sameTeam(selectionName, home);
      const providerAway = sameTeam(selectionName, away);
      if (!providerHome && !providerAway) continue;
      const providerHomeLine = providerHome ? points : -points;
      out.push({
        market: "AH",
        lineValue: reversed ? -providerHomeLine : providerHomeLine,
        isMain: q.is_main !== false,
        selection: reversed ? (providerHome ? "A" : "H") : providerHome ? "H" : "A",
        decimalOdds,
        sourceUpdatedAt: timestampMs,
      });
      continue;
    }

    if (marketName.includes("asian total") || marketName.includes("total goals")) {
      const points = Number(q.points);
      if (!Number.isFinite(points)) continue;
      const label = `${q.name ?? ""} ${q.selection ?? ""}`.toLowerCase();
      const selection = label.includes("under") ? "U" : label.includes("over") ? "O" : null;
      if (!selection) continue;
      out.push({
        market: "OU",
        lineValue: points,
        isMain: q.is_main !== false,
        selection,
        decimalOdds,
        sourceUpdatedAt: timestampMs,
      });
      continue;
    }

    if (marketName === "moneyline" || marketName.includes("three way")) {
      const isHome = sameTeam(selectionName, home);
      const isAway = sameTeam(selectionName, away);
      const isDraw = /draw|tie|和/.test(selectionName.toLowerCase());
      let selection: "H" | "D" | "A" | null = isDraw ? "D" : isHome ? "H" : isAway ? "A" : null;
      if (!selection) continue;
      if (reversed && selection !== "D") selection = selection === "H" ? "A" : "H";
      out.push({
        market: "1X2",
        lineValue: null,
        isMain: q.is_main !== false,
        selection,
        decimalOdds,
        sourceUpdatedAt: timestampMs,
      });
    }
  }
  return out;
}

export class OpticOddsProvider {
  private warnings: string[] = [];
  private lastSuccessAt: number | null = null;

  status() {
    return { ok: this.lastSuccessAt !== null, lastSuccessAt: this.lastSuccessAt, warnings: [...this.warnings] };
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
    if (this.warnings.length > 5) this.warnings.shift();
  }

  async fetchFixtures(): Promise<PinnacleFixture[]> {
    const all: OpticFixture[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 25; page++) {
      const res = await callOptic("/fixtures/active", {
        sport: "soccer",
        ...(cursor ? { cursor } : {}),
      });
      const rows = res.data?.data ?? [];
      all.push(...rows);
      cursor = res.data?.cursor ?? null;
      if (!cursor || rows.length === 0) break;
    }
    this.lastSuccessAt = Date.now();
    return parseOpticFixtures(all);
  }

  async fetchMatchPrices(providerMatchId: string, reversed = false): Promise<ProviderPrice[]> {
    try {
      const res = await callOptic("/fixtures/odds", {
        fixture_id: [providerMatchId],
        sportsbook: ["Pinnacle"],
        is_main: true,
        odds_format: "DECIMAL",
      });
      const fixture = res.data?.data?.[0];
      if (!fixture) return [];
      this.lastSuccessAt = Date.now();
      return parseOpticPrices(fixture, reversed);
    } catch (err) {
      this.warn((err as Error).message);
      throw err;
    }
  }
}
