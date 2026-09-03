import { rawDb } from "./store";
import type {
  OuSignalDatasetResponse,
  OuSignalObservation,
  OuSignalPrealert,
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

interface StoredPrealertRow {
  unique_key: string;
  match_id: string;
  provider: Provider;
  rule_id: string;
  line_key: string;
  direction_path: string;
  initial_selected_odds: number;
  t30_selected_odds: number;
  signal_t30_odds: number;
  detected_at: number;
  notified_at: number | null;
  league: string;
  home_team: string;
  away_team: string;
  kickoff_utc: number;
}

export const OU_SIGNAL_RULES: OuSignalRule[] = [
  {
    id: "pinnacle-uoo-short-005-010",
    provider: "pinnacle",
    providerLabel: "Pinnacle／平博",
    directionPath: "U→O→O",
    driftBucket: "收水 0.05–0.10",
    signalSelection: "O",
    mode: "direct",
    historicalEdgePp: 22.8,
    historicalNote: "歷史 20 場，16/20 命中；大球命中率高過 T-5 原始隱含機率 22.8 點",
    historicalSample: 20,
    historicalDecided: 20,
    historicalHits: 16,
    historicalHitRate: 0.8,
    historicalRoi: 0.44625,
  },
  {
    id: "pinnacle-ooo-short-010-020",
    provider: "pinnacle",
    providerLabel: "Pinnacle／平博",
    directionPath: "O→O→O",
    driftBucket: "收水 0.10–0.20",
    signalSelection: "O",
    mode: "direct",
    historicalEdgePp: 16.9,
    historicalNote: "歷史 22 場，17/22 命中；大球命中率高過 T-5 原始隱含機率 16.9 點",
    historicalSample: 22,
    historicalDecided: 22,
    historicalHits: 17,
    historicalHitRate: 0.772727,
    historicalRoi: 0.264182,
  },
  {
    id: "pinnacle-ooo-line-gt-275-over-watch",
    provider: "pinnacle",
    providerLabel: "Pinnacle／平博",
    directionPath: "O→O→O",
    driftBucket: "任何水位走勢",
    lineMinExclusive: 2.75,
    signalSelection: "O",
    mode: "direct",
    historicalEdgePp: 0,
    historicalNote: "隱藏觀察：O→O→O 主盤大於 2.75，研究標籤；不獨立發送通知",
  },
  {
    id: "pinnacle-uoo-line-250-275-over-watch",
    provider: "pinnacle",
    providerLabel: "Pinnacle／平博",
    directionPath: "U→O→O",
    driftBucket: "任何水位走勢",
    lineMinExclusive: 2.5,
    lineMaxInclusive: 2.75,
    signalSelection: "O",
    mode: "direct",
    historicalEdgePp: 0,
    historicalNote: "隱藏觀察：U→O→O 主盤大於 2.50 至 2.75，研究標籤；不獨立發送通知",
  },
  {
    id: "hkjc-ooo-flat-wide-line-225-250-under-watch",
    activatedAt: 1_788_350_822_000,
    provider: "hkjc",
    providerLabel: "馬會",
    directionPath: "O→O→O",
    driftBucket: "持平或拉闊",
    lineMinInclusive: 2.25,
    lineMaxInclusive: 2.5,
    signalSelection: "U",
    mode: "reverse",
    historicalEdgePp: 0,
    historicalNote: "Watch：歷史 23 場，反向小球 17/23（73.9%），ROI +41.4%；主盤 2.25 至 2.50",
    historicalSample: 23,
    historicalDecided: 23,
    historicalHits: 17,
    historicalHitRate: 0.73913,
    historicalRoi: 0.414348,
  },
  {
    id: "pinnacle-ouu-t5-selected-180-190-over-watch",
    activatedAt: 1_788_350_822_000,
    provider: "pinnacle",
    providerLabel: "Pinnacle／平博",
    directionPath: "O→U→U",
    driftBucket: "任何水位走勢",
    selectedT5OddsMinInclusive: 1.8,
    selectedT5OddsMaxInclusive: 1.9,
    signalSelection: "O",
    mode: "reverse",
    historicalEdgePp: 0,
    historicalNote: "Watch：歷史 30 場（26 場判定），反向大球 17/26（65.4%），ROI +27.2%；T-5 原選定價 1.80 至 1.90",
    historicalSample: 30,
    historicalDecided: 26,
    historicalHits: 17,
    historicalHitRate: 0.653846,
    historicalRoi: 0.271687,
  },
  {
    id: "hkjc-ooo-t5-selected-le-180-under-watch",
    activatedAt: 1_788_350_822_000,
    provider: "hkjc",
    providerLabel: "馬會",
    directionPath: "O→O→O",
    driftBucket: "任何水位走勢",
    selectedT5OddsMaxInclusive: 1.8,
    signalSelection: "U",
    mode: "reverse",
    historicalEdgePp: 0,
    historicalNote: "Watch：歷史 35 場，反向小球 22/35（62.9%），ROI +21.7%；T-5 原選定價不高於 1.80",
    historicalSample: 35,
    historicalDecided: 35,
    historicalHits: 22,
    historicalHitRate: 0.628571,
    historicalRoi: 0.216857,
  },
  {
    id: "pinnacle-ouu-short-010-020-reverse",
    provider: "pinnacle",
    providerLabel: "Pinnacle／平博",
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
    historicalEdgePp: 0,
    historicalNote: "Watch：歷史 24 場，反向小球 17/24（70.8%），ROI +35.5%；包含主盤 2.25 至 2.50 子條件",
    historicalSample: 24,
    historicalDecided: 24,
    historicalHits: 17,
    historicalHitRate: 0.708333,
    historicalRoi: 0.355417,
  },
];

/** Retired rules remain decodable for historical rows, but never match new observations. */
const RETIRED_OU_SIGNAL_RULES: OuSignalRule[] = [{
  id: "pinnacle-uuu-flat-wide-reverse",
  provider: "pinnacle",
  providerLabel: "Pinnacle／平博",
  directionPath: "U→U→U",
  driftBucket: "持平或拉闊",
  signalSelection: "O",
  mode: "reverse",
  historicalEdgePp: -24.3,
  historicalNote: "已停用；只保留舊紀錄解碼，不再配對新賽事",
}];

/** Keep collecting these rules for research, but never send T-30/T-5 Telegram alerts. */
export const OU_HIDDEN_RULE_IDS = new Set([
  "pinnacle-ouu-short-010-020-reverse",
  "pinnacle-ooo-line-gt-275-over-watch",
  "pinnacle-uoo-line-250-275-over-watch",
  "pinnacle-uuu-flat-wide-reverse",
]);
/** T-30 is only a candidate stage, so Watch rules stay silent until fully qualified at T-5. */
export const OU_T30_TG_DISABLED_RULE_IDS = new Set([
  ...OU_HIDDEN_RULE_IDS,
  "hkjc-ooo-flat-wide-line-225-250-under-watch",
  "hkjc-ooo-flat-wide-reverse",
  "pinnacle-ouu-t5-selected-180-190-over-watch",
  "hkjc-ooo-t5-selected-le-180-under-watch",
]);

const RULE_BY_ID = new Map(
  [...OU_SIGNAL_RULES, ...RETIRED_OU_SIGNAL_RULES].map((rule) => [rule.id, rule]),
);

export function ouRuleById(ruleId: string): OuSignalRule | undefined {
  return RULE_BY_ID.get(ruleId);
}
const T30_RULES_BY_PREFIX = new Map<string, OuSignalRule[]>();
for (const rule of OU_SIGNAL_RULES) {
  const prefix = `${rule.provider}|${rule.directionPath.split("→").slice(0, 2).join("→")}`;
  T30_RULES_BY_PREFIX.set(prefix, [...(T30_RULES_BY_PREFIX.get(prefix) ?? []), rule]);
}

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

function lineNumber(lineKey: string): number | null {
  const parts = lineKey.replace(/[OU]/g, "").split("/").map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((sum, part) => sum + part, 0) / parts.length;
}

function matchesLine(rule: OuSignalRule, lineKey: string): boolean {
  const line = lineNumber(lineKey);
  if (line === null) return false;
  if (rule.lineMinInclusive !== undefined && line < rule.lineMinInclusive) return false;
  if (rule.lineMinExclusive !== undefined && line <= rule.lineMinExclusive) return false;
  if (rule.lineMaxInclusive !== undefined && line > rule.lineMaxInclusive) return false;
  return true;
}

function matchesSelectedT5Odds(rule: OuSignalRule, selectedT5Odds: number): boolean {
  if (
    rule.selectedT5OddsMinInclusive !== undefined
    && selectedT5Odds < rule.selectedT5OddsMinInclusive
  ) return false;
  if (
    rule.selectedT5OddsMaxInclusive !== undefined
    && selectedT5Odds > rule.selectedT5OddsMaxInclusive
  ) return false;
  return true;
}

function matchingRules(
  provider: Provider,
  path: string,
  gap: number,
  lineKey: string,
  selectedT5Odds: number,
): OuSignalRule[] {
  return OU_SIGNAL_RULES.filter((rule) => {
    if (rule.provider !== provider || rule.directionPath !== path) return false;
    if (!matchesLine(rule, lineKey)) return false;
    if (!matchesSelectedT5Odds(rule, selectedT5Odds)) return false;
    if (rule.driftBucket === "任何水位走勢") return true;
    if (rule.driftBucket === "收水 0.05–0.10") return gap >= 0.05 && gap < 0.1;
    if (rule.driftBucket === "收水 0.10–0.20") return gap >= 0.1 && gap < 0.2;
    return rule.driftBucket === "持平或拉闊" && gap <= 0;
  });
}

/** Lock T-30 candidates once their first two directions match a frozen rule. */
export function syncOuSignalPrealerts(matchIds: string[] = []): number {
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
        AND m.fixture_source IN ('hkjc','pinnacle')
        AND s.provider IN ('hkjc','pinnacle')
        AND (m.fixture_source='hkjc' OR s.provider='pinnacle')
        AND s.stage IN ('initial','T30')
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
    `INSERT OR IGNORE INTO ou_signal_prealerts(
       unique_key,match_id,provider,rule_id,line_key,direction_path,
       initial_selected_odds,t30_selected_odds,signal_t30_odds,detected_at,notified_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`,
  );
  let inserted = 0;
  const tx = rawDb.transaction(() => {
    for (const [groupKey, stages] of groups) {
      const initialRows = stages.get("initial");
      const t30Rows = stages.get("T30");
      if (!initialRows || !t30Rows) continue;
      const decisions = [initialRows, t30Rows].map((stage) =>
        selectedSide(new Map([...stage].map(([side, row]) => [side, row.decimal_odds]))),
      );
      if (decisions.some((decision) => !decision || decision.side === "D")) continue;
      if (decisions.some((decision) => decision!.odds <= 1.7)) continue;
      const path = decisions.map((decision) => decision!.side).join("→");
      const [matchId, provider, lineKey] = groupKey.split("|") as [string, Provider, string];
      const detectedAt = Math.max(...[...t30Rows.values()].map((row) => row.captured_at));
      const rules = (T30_RULES_BY_PREFIX.get(`${provider}|${path}`) ?? [])
        .filter((rule) =>
          matchesLine(rule, lineKey)
          && (rule.activatedAt === undefined || detectedAt >= rule.activatedAt)
        );
      for (const rule of rules) {
        const signalT30Odds = t30Rows.get(rule.signalSelection)?.decimal_odds;
        if (signalT30Odds === undefined) continue;
        const uniqueKey = `${matchId}|${provider}|OU|${lineKey}|${rule.id}|T30`;
        inserted += insert.run(
          uniqueKey,
          matchId,
          provider,
          rule.id,
          lineKey,
          path,
          decisions[0]!.odds,
          decisions[1]!.odds,
          signalT30Odds,
          detectedAt,
        ).changes;
      }
    }
  });
  tx();
  return inserted;
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
        AND m.fixture_source IN ('hkjc','pinnacle')
        AND s.provider IN ('hkjc','pinnacle')
        AND (m.fixture_source='hkjc' OR s.provider='pinnacle')
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
      const detectedAt = Math.max(...[...t5Rows.values()].map((row) => row.captured_at));
      const rules = matchingRules(provider, path, gap, lineKey, decisions[2]!.odds)
        .filter((rule) => rule.activatedAt === undefined || detectedAt >= rule.activatedAt);
      for (const rule of rules) {
        const signalT5Odds = t5Rows.get(rule.signalSelection)?.decimal_odds;
        if (signalT5Odds === undefined) continue;
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

function toPrealert(row: StoredPrealertRow): OuSignalPrealert {
  const rule = RULE_BY_ID.get(row.rule_id);
  if (!rule) throw new Error(`Unknown OU prealert rule: ${row.rule_id}`);
  return {
    uniqueKey: row.unique_key,
    matchId: row.match_id,
    league: row.league,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    kickoffUtc: row.kickoff_utc,
    provider: row.provider,
    providerLabel: rule.providerLabel,
    ruleId: row.rule_id,
    lineKey: row.line_key,
    directionPath: row.direction_path,
    signalSelection: rule.signalSelection,
    mode: rule.mode,
    initialSelectedOdds: row.initial_selected_odds,
    t30SelectedOdds: row.t30_selected_odds,
    signalT30Odds: row.signal_t30_odds,
    detectedAt: row.detected_at,
    notifiedAt: row.notified_at,
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
      WHERE m.fixture_source IN ('hkjc','pinnacle')
      ORDER BY CASE
        WHEN r.match_id IS NULL AND m.kickoff_utc<=? AND m.kickoff_utc>=? THEN 0
        WHEN m.kickoff_utc>? THEN 1
        ELSE 2 END,
        o.detected_at DESC`,
  ).all(now, now - 3 * 60 * 60_000, now) as StoredSignalRow[];
  const observations = rows
    .map((row) => toObservation(row, now))
    .filter((row) => !OU_HIDDEN_RULE_IDS.has(row.ruleId));
  return {
    generatedAt: now,
    activatedAt: Number(
      (rawDb.prepare("SELECT value FROM app_state WHERE key='ou_signal_monitor_activated_at'").get() as { value: string }).value,
    ),
    rules: OU_SIGNAL_RULES.filter((rule) => !OU_HIDDEN_RULE_IDS.has(rule.id)),
    summaries: summaries(observations).filter(
      (summary) => !OU_HIDDEN_RULE_IDS.has(summary.rule.id),
    ),
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
      WHERE m.fixture_source IN ('hkjc','pinnacle') AND o.notified_at IS NULL AND o.detected_at>=? ${filter}
      ORDER BY o.detected_at`,
  ).all(activatedAt, ...matchIds) as StoredSignalRow[];
  return rows
    .map((row) => toObservation(row, now))
    .filter((row) => !OU_HIDDEN_RULE_IDS.has(row.ruleId));
}

export function unsentOuPrealerts(matchIds: string[] = []): OuSignalPrealert[] {
  syncOuSignalPrealerts(matchIds);
  const activatedAt = Number(
    (rawDb.prepare("SELECT value FROM app_state WHERE key='ou_signal_prealert_activated_at'").get() as { value: string }).value,
  );
  const filter = matchIds.length ? `AND p.match_id IN (${matchIds.map(() => "?").join(",")})` : "";
  const rows = rawDb.prepare(
    `SELECT p.*,m.league,m.home_team,m.away_team,m.kickoff_utc
       FROM ou_signal_prealerts p
       JOIN matches m ON m.id=p.match_id
      WHERE m.fixture_source IN ('hkjc','pinnacle') AND p.notified_at IS NULL AND p.detected_at>=? ${filter}
      ORDER BY p.detected_at`,
  ).all(activatedAt, ...matchIds) as StoredPrealertRow[];
  return rows
    .map(toPrealert)
    .filter((row) => !OU_T30_TG_DISABLED_RULE_IDS.has(row.ruleId));
}

export function markOuSignalNotified(uniqueKey: string, notifiedAt = Date.now()): void {
  rawDb.prepare(
    "UPDATE ou_signal_observations SET notified_at=? WHERE unique_key=? AND notified_at IS NULL",
  ).run(notifiedAt, uniqueKey);
}

export function markOuPrealertNotified(uniqueKey: string, notifiedAt = Date.now()): void {
  rawDb.prepare(
    "UPDATE ou_signal_prealerts SET notified_at=? WHERE unique_key=? AND notified_at IS NULL",
  ).run(notifiedAt, uniqueKey);
}
