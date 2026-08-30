import { rawDb } from "./store";
import type {
  OuSignalDatasetResponse,
  OuSignalObservation,
  OuSignalRule,
  OuSignalRuleSummary,
} from "@shared/types";

type Provider = "hkjc" | "pinnacle";
type Side = "O" | "U";
type Stage = "initial" | "T30" | "T5";

interface SnapshotRow {
  match_id: string;
  provider: Provider;
  stage: Stage;
  line_key: string;
  selection: Side;
  decimal_odds: number;
  captured_at: number;
}

interface MatchRow {
  id: string;
  league: string;
  home_team: string;
  away_team: string;
  kickoff_utc: number;
  status: string;
  inplay: number;
  home_score: number | null;
  away_score: number | null;
}

interface StoredSignalRow {
  unique_key: string;
  match_id: string;
  provider: Provider;
  rule_id: string;
  line_key: string;
  direction_path: string;
  drift_bucket: string;
  original_selection: Side;
  signal_selection: Side;
  initial_signal_odds: number;
  t5_signal_odds: number;
  signal_t5_odds: number;
  odds_gap: number;
  detected_at: number;
  notified_at: number | null;
  league: string;
  home_team: string;
  away_team: string;
  kickoff_utc: number;
  status: string;
  inplay: number;
  home_score: number | null;
  away_score: number | null;
}

export const OU_SIGNAL_RULES: OuSignalRule[] = [
  {
    id: "pinnacle-uoo-short-005-010",
    provider: "pinnacle",
    providerLabel: "皇冠",
    directionPath: "U→O→O",
    driftBucket: "收水 0.05–0.10",
    signalSelection: "O",
    mode: "direct",
    historicalEdgePp: 22.8,
    historicalNote: "歷史大球命中率高過 T-5 原始隱含機率 22.8 點",
  },
  {
    id: "pinnacle-ooo-short-010-020",
    provider: "pinnacle",
    providerLabel: "皇冠",
    directionPath: "O→O→O",
    driftBucket: "收水 0.10–0.20",
    signalSelection: "O",
    mode: "direct",
    historicalEdgePp: 16.9,
    historicalNote: "歷史大球命中率高過 T-5 原始隱含機率 16.9 點",
  },
  {
    id: "pinnacle-ouu-short-010-020-reverse",
    provider: "pinnacle",
    providerLabel: "皇冠",
    directionPath: "O→U→U",
    driftBucket: "收水 0.10–0.20",
    signalSelection: "O",
    mode: "reverse",
    historicalEdgePp: -10.9,
    historicalNote: "歷史原方向小球低過隱含機率 10.9 點，反向觀察大球",
  },
  {
    id: "hkjc-ooo-flat-wide-reverse",
    provider: "hkjc",
    providerLabel: "馬會",
    directionPath: "O→O→O",
    driftBucket: "持平或拉闊",
    signalSelection: "U",
    mode: "reverse",
    historicalEdgePp: -15.1,
    historicalNote: "歷史原方向大球低過隱含機率 15.1 點，反向觀察小球",
  },
  {
    id: "pinnacle-uuu-flat-wide-reverse",
    provider: "pinnacle",
    providerLabel: "皇冠",
    directionPath: "U→U→U",
    driftBucket: "持平或拉闊",
    signalSelection: "O",
    mode: "reverse",
    historicalEdgePp: -24.3,
    historicalNote: "歷史原方向小球低過隱含機率 24.3 點，反向觀察大球",
  },
];

const RULE_BY_ID = new Map(OU_SIGNAL_RULES.map((rule) => [rule.id, rule]));

function selectedSide(prices: Map<Side, number>): { side: Side | "D"; odds: number } | null {
  const over = prices.get("O");
  const under = prices.get("U");
  if (over === undefined || under === undefined) return null;
  if (Math.abs(over - under) < 1e-12) return { side: "D", odds: over };
  return over < under ? { side: "O", odds: over } : { side: "U", odds: under };
}

function driftBucket(gap: number): string {
  if (gap >= 0.2) return "收水 0.20+";
  if (gap >= 0.1) return "收水 0.10–0.20";
  if (gap >= 0.05) return "收水 0.05–0.10";
  if (gap > 0) return "收水少於 0.05";
  return "持平或拉闊";
}

function matchingRule(provider: Provider, path: string, gap: number): OuSignalRule | undefined {
  return OU_SIGNAL_RULES.find((rule) => {
    if (rule.provider !== provider || rule.directionPath !== path) return false;
    if (rule.driftBucket === "收水 0.05–0.10") return gap >= 0.05 && gap < 0.1;
    if (rule.driftBucket === "收水 0.10–0.20") return gap >= 0.1 && gap < 0.2;
    return rule.driftBucket === "持平或拉闊" && gap <= 0;
  });
}

/**
 * Lock every qualifying same-line observation. The signal is based on
 * initial/T-30/T-5 only and keeps the audit's strict selected-price > 1.70
 * threshold at every checkpoint.
 */
export function syncOuSignalObservations(matchIds: string[] = []): number {
  const cutoff = Date.now() - 120 * 24 * 60 * 60_000;
  const matchFilter = matchIds.length
    ? `AND s.match_id IN (${matchIds.map(() => "?").join(",")})`
    : "AND m.kickoff_utc>=?";
  const params = matchIds.length ? matchIds : [cutoff];
  const rows = rawDb.prepare(
    `SELECT s.match_id,s.provider,s.stage,s.line_key,s.selection,s.decimal_odds,s.captured_at
       FROM research_timeline_snapshots s
       JOIN matches m ON m.id=s.match_id
      WHERE s.market='OU'
        AND s.provider IN ('hkjc','pinnacle')
        AND s.stage IN ('initial','T30','T5')
        AND s.selection IN ('O','U')
        ${matchFilter}
      ORDER BY s.match_id,s.provider,s.line_key,s.stage,s.selection`,
  ).all(...params) as SnapshotRow[];

  const groups = new Map<string, Map<Stage, Map<Side, SnapshotRow>>>();
  for (const row of rows) {
    const key = `${row.match_id}|${row.provider}|${row.line_key}`;
    const stages = groups.get(key) ?? new Map<Stage, Map<Side, SnapshotRow>>();
    const prices = stages.get(row.stage) ?? new Map<Side, SnapshotRow>();
    prices.set(row.selection, row);
    stages.set(row.stage, prices);
    groups.set(key, stages);
  }

  const insert = rawDb.prepare(
    `INSERT OR IGNORE INTO ou_signal_observations(
       unique_key,match_id,provider,rule_id,line_key,direction_path,drift_bucket,
       original_selection,signal_selection,initial_signal_odds,t5_signal_odds,
       signal_t5_odds,odds_gap,detected_at,notified_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
  );
  let inserted = 0;
  const tx = rawDb.transaction(() => {
    for (const [groupKey, stages] of groups) {
      const initialRows = stages.get("initial");
      const t30Rows = stages.get("T30");
      const t5Rows = stages.get("T5");
      if (!initialRows || !t30Rows || !t5Rows) continue;
      const stageRows = [initialRows, t30Rows, t5Rows];
      const decisions = stageRows.map((stage) =>
        selectedSide(new Map([...stage].map(([side, row]) => [side, row.decimal_odds]))),
      );
      if (decisions.some((decision) => !decision || decision.side === "D")) continue;
      if (decisions.some((decision) => decision!.odds <= 1.7)) continue;
      const path = decisions.map((decision) => decision!.side).join("→");
      const t5Side = decisions[2]!.side as Side;
      const initialSignalOdds = initialRows.get(t5Side)?.decimal_odds;
      const t5SignalOdds = t5Rows.get(t5Side)?.decimal_odds;
      if (initialSignalOdds === undefined || t5SignalOdds === undefined) continue;
      const gap = Math.round((initialSignalOdds - t5SignalOdds) * 10_000) / 10_000;
      const [matchId, provider, lineKey] = groupKey.split("|") as [string, Provider, string];
      const rule = matchingRule(provider, path, gap);
      if (!rule) continue;
      const signalT5Odds = t5Rows.get(rule.signalSelection)?.decimal_odds;
      if (signalT5Odds === undefined) continue;
      const detectedAt = Math.max(...[...t5Rows.values()].map((row) => row.captured_at));
      const uniqueKey = `${matchId}|${provider}|OU|${lineKey}|${rule.id}`;
      inserted += insert.run(
        uniqueKey,
        matchId,
        provider,
        rule.id,
        lineKey,
        path,
        driftBucket(gap),
        t5Side,
        rule.signalSelection,
        initialSignalOdds,
        t5SignalOdds,
        signalT5Odds,
        gap,
        detectedAt,
      ).changes;
    }
  });
  tx();
  return inserted;
}

function observationStatus(row: StoredSignalRow, now: number): OuSignalObservation["matchStatus"] {
  if (row.home_score !== null && row.away_score !== null) return "completed";
  if (row.inplay || (row.kickoff_utc <= now && now - row.kickoff_utc <= 3 * 60 * 60_000)) return "live";
  if (row.kickoff_utc > now) return "upcoming";
  return "awaiting_result";
}

function resultFor(row: StoredSignalRow): OuSignalObservation["result"] {
  if (row.home_score === null || row.away_score === null) return null;
  const totalGoals = row.home_score + row.away_score;
  const line = Number(row.line_key);
  const actual = totalGoals > line ? "O" : totalGoals < line ? "U" : "push";
  return {
    homeScore: row.home_score,
    awayScore: row.away_score,
    totalGoals,
    outcome: actual === "push" ? "push" : actual === row.signal_selection ? "hit" : "miss",
  };
}

function toObservation(row: StoredSignalRow, now: number): OuSignalObservation {
  const rule = RULE_BY_ID.get(row.rule_id);
  if (!rule) throw new Error(`Unknown OU signal rule: ${row.rule_id}`);
  return {
    uniqueKey: row.unique_key,
    matchId: row.match_id,
    league: row.league,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    kickoffUtc: row.kickoff_utc,
    matchStatus: observationStatus(row, now),
    provider: row.provider,
    providerLabel: rule.providerLabel,
    ruleId: row.rule_id,
    lineKey: row.line_key,
    directionPath: row.direction_path,
    driftBucket: row.drift_bucket,
    originalSelection: row.original_selection,
    signalSelection: row.signal_selection,
    mode: rule.mode,
    referenceInitialOdds: row.initial_signal_odds,
    referenceT5Odds: row.t5_signal_odds,
    signalT5Odds: row.signal_t5_odds,
    oddsGap: row.odds_gap,
    detectedAt: row.detected_at,
    notifiedAt: row.notified_at,
    result: resultFor(row),
  };
}

function summaries(observations: OuSignalObservation[]): OuSignalRuleSummary[] {
  return OU_SIGNAL_RULES.map((rule) => {
    const rows = observations.filter((row) => row.ruleId === rule.id);
    const settled = rows.filter((row) => row.result);
    const decided = settled.filter((row) => row.result?.outcome !== "push");
    const hits = decided.filter((row) => row.result?.outcome === "hit").length;
    return {
      rule,
      observations: rows.length,
      pending: rows.length - settled.length,
      settled: settled.length,
      hits,
      misses: decided.length - hits,
      pushes: settled.length - decided.length,
      prospectiveHitRate: decided.length ? hits / decided.length : null,
    };
  });
}

export function ouSignalDataset(now = Date.now()): OuSignalDatasetResponse {
  syncOuSignalObservations();
  const rows = rawDb.prepare(
    `SELECT o.*,m.league,m.home_team,m.away_team,m.kickoff_utc,m.status,m.inplay,
            r.home_score,r.away_score
       FROM ou_signal_observations o
       JOIN matches m ON m.id=o.match_id
       LEFT JOIN research_results r ON r.match_id=o.match_id
      ORDER BY CASE
        WHEN r.match_id IS NULL AND m.kickoff_utc<=? AND m.kickoff_utc>=? THEN 0
        WHEN m.kickoff_utc>? THEN 1
        ELSE 2 END,
        o.detected_at DESC`,
  ).all(now, now - 3 * 60 * 60_000, now) as StoredSignalRow[];
  const observations = rows.map((row) => toObservation(row, now));
  return {
    generatedAt: now,
    activatedAt: Number(
      (rawDb.prepare("SELECT value FROM app_state WHERE key='ou_signal_monitor_activated_at'").get() as { value: string }).value,
    ),
    rules: OU_SIGNAL_RULES,
    summaries: summaries(observations),
    observations,
  };
}

export function unsentOuSignals(matchIds: string[] = [], now = Date.now()): OuSignalObservation[] {
  syncOuSignalObservations(matchIds);
  const activatedAt = Number(
    (rawDb.prepare("SELECT value FROM app_state WHERE key='ou_signal_monitor_activated_at'").get() as { value: string }).value,
  );
  const filter = matchIds.length ? `AND o.match_id IN (${matchIds.map(() => "?").join(",")})` : "";
  const rows = rawDb.prepare(
    `SELECT o.*,m.league,m.home_team,m.away_team,m.kickoff_utc,m.status,m.inplay,
            r.home_score,r.away_score
       FROM ou_signal_observations o
       JOIN matches m ON m.id=o.match_id
       LEFT JOIN research_results r ON r.match_id=o.match_id
      WHERE o.notified_at IS NULL AND o.detected_at>=? ${filter}
      ORDER BY o.detected_at`,
  ).all(activatedAt, ...matchIds) as StoredSignalRow[];
  return rows.map((row) => toObservation(row, now));
}

export function markOuSignalNotified(uniqueKey: string, notifiedAt = Date.now()): void {
  rawDb.prepare(
    "UPDATE ou_signal_observations SET notified_at=? WHERE unique_key=? AND notified_at IS NULL",
  ).run(notifiedAt, uniqueKey);
}
