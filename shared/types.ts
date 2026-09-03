/* Shared DTO / domain types used by both server and client. */

/** COU is full-match total corners (角球大細), never a goals-total alias. */
export type Market = "1X2" | "AH" | "OU" | "COU";
export type Provider = "hkjc" | "pinnacle" | "crown";
export type Selection = "H" | "D" | "A" | "O" | "U";
export type AppMode = "live" | "degraded" | "demo";

export const MARKET_LABEL: Record<Market, string> = {
  "1X2": "主客和",
  AH: "亞洲讓球",
  OU: "入球大細",
  COU: "角球大細",
};

export const SELECTION_LABEL: Record<Selection, string> = {
  H: "主",
  D: "和",
  A: "客",
  O: "大",
  U: "細",
};

export interface PriceCell {
  decimalOdds: number;
  prevDecimalOdds?: number | null;
  fetchedAt: number;
  sourceUpdatedAt?: number | null;
  ageSec: number;
  stale: boolean;
}

export interface LineRow {
  matchId: string;
  market: Market;
  lineKey: string;
  lineValue: number | null;
  lineDisplay: string;
  isMain: boolean;
  hkjc: Partial<Record<Selection, PriceCell>>;
  pinnacle: Partial<Record<Selection, PriceCell>>;
  exactLine: boolean; // both books quote this exact normalized line
  totalProbability: number | null; // q for the complementary pair (or 3-way)
  bestQ: number | null;
  deltas: Partial<Record<Selection, number>>;
  arb?: ArbOpportunity | null;
  ev?: EvOpportunity[] | null;
}

export interface MatchRow {
  id: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: number;
  minutesToKickoff: number;
  matched: boolean;
  pinnacleMatchId: string | null;
  mappingConfidence: number;
  unmatchedReason: string | null;
  lines: LineRow[];
  hasArb: boolean;
  hasEv: boolean;
  hasSynthetic: boolean;
  synthetics: SyntheticOpportunity[];
  /** Old Crown rows may remain for prediction context, never execution. */
  crownExecutionMode: "live" | "prediction_only";
  crownExecutionReason:
    | "live_crown_snapshot"
    | "no_crown_observation"
    | "empty_crown_snapshot"
    | "stale_crown_observation";
  crownPredictionFallback: boolean;
}

export interface BetLeg {
  provider: Provider | "hkjc-synthetic";
  label: string;
  market: Market;
  lineKey: string;
  lineDisplay: string;
  selection: Selection;
  decimalOdds: number;
  stake: number;
  synthetic?: boolean;
  syntheticDetail?: string;
}

export interface ArbOpportunity {
  key: string;
  matchId: string;
  matchLabel: string;
  league: string;
  kickoffUtc: number;
  market: Market;
  lineKey: string;
  lineDisplay: string;
  q: number;
  legs: BetLeg[];
  totalStake: number;
  payout: number;
  profit: number;
  roi: number;
  structure: string; // e.g. 'two-way-complementary' | 'three-way-cover'
}

export interface EvOpportunity {
  key: string;
  matchId: string;
  matchLabel: string;
  league: string;
  kickoffUtc: number;
  market: Market;
  lineKey: string;
  lineDisplay: string;
  selection: Selection;
  hkjcOdds: number;
  fairOdds: number;
  trueProb: number;
  edge: number; // EV as fraction, e.g. 0.031
  stake: number;
  expectedProfit: number;
  flags: string[];
  /** True when the effective HKJC price is assembled from multiple HKJC legs. */
  synthetic?: boolean;
  formula?: string;
  components?: BetLeg[];
}

export interface SyntheticOpportunity {
  key: string;
  matchId: string;
  matchLabel: string;
  league: string;
  kickoffUtc: number;
  side: "home" | "away";
  targetHandicap: number; // handicap received by `side`
  lineDisplay: string;
  syntheticOdds: number;
  formula: string;
  components: BetLeg[];
  crownOdds: number | null;
  crownSelection: Selection | null;
  q: number | null;
  isArb: boolean;
  totalStake: number;
  payout: number;
  profit: number;
  roi: number;
}

export interface ProviderStatus {
  provider: Provider;
  ok: boolean;
  mode: AppMode;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  lastLatencyMs: number | null;
  itemCount: number;
}

/** How the replaceable Pinnacle adapter is currently sourcing prices. */
export interface PinnacleSourceInfo {
  strategy: "pinnapi-primary" | "official-api" | "titan007" | "opticodds-primary";
  officialConfigured: boolean;
  pinnapiConfigured: boolean;
  lastRowMatchedBy: "name" | "id-hint" | null;
  lastRowCompanyId: string | null;
  primary: "pinnapi" | "opticodds";
  fallback: "opticodds-then-titan007" | "titan007";
  opticOk: boolean;
  warnings: string[];
}

export type ScanResultCode = "NO_WINDOW" | "NO_ALERT" | "ALERT" | "TARGET_REACHED" | "ERROR";

export interface ScanOutcome {
  result: ScanResultCode;
  startedAt: number;
  finishedAt: number;
  runtimeMs: number;
  windowMinutes: number;
  intervalSec: number;
  maxRuntimeSec: number;
  /** Events selected because 0 < minutes_to_kickoff <= windowMinutes. */
  selected: Array<{ matchId: string; matchLabel: string; minutesToKickoff: number }>;
  passes: number;
  detailCalls: number;
  newOpportunityKeys: string[];
  message: string;
}

export interface ScanConfigInfo {
  windowMinutes: number;
  intervalSec: number;
  maxRuntimeSec: number;
  /** Whether the server-side 30-second schedule check is enabled. */
  scheduleConfigured: boolean;
  /** 0 means unlimited; a positive value is a strict total simulated-bet cap. */
  simulationTarget: number;
  simulationBets: number;
  simulationTargetReached: boolean;
  lastScan: ScanOutcome | null;
}

export interface StatusResponse {
  now: number;
  mode: AppMode;
  coldStart: boolean;
  coldStartStage: "idle" | "quick" | "full" | "done";
  refreshing: boolean;
  lastRefreshAt: number | null;
  lastGoodAt: number | null;
  nextRefreshEligibleAt: number;
  degradedReason: string | null;
  providers: ProviderStatus[];
  pinnacleSource: PinnacleSourceInfo;
  scan: ScanConfigInfo;
  counts: {
    matches: number;
    matched: number;
    arbs: number;
    ev: number;
    synthetic: number;
    snapshots: number;
  };
}

export interface DashboardResponse {
  status: StatusResponse;
  matches: MatchRow[];
  arbs: ArbOpportunity[];
  ev: EvOpportunity[];
  synthetics: SyntheticOpportunity[];
  leagues: string[];
}

export interface MatchRefreshResponse {
  ok: boolean;
  matchId: string;
  matchLabel: string;
  refreshedAt: number;
  hkjcPrices: number;
  pinnaclePrices: number;
  crownPrices: number;
  message: string;
}

export interface SimulationLegDto {
  id: number;
  provider: string;
  market: Market;
  lineKey: string;
  lineDisplay: string;
  selection: Selection;
  decimalOdds: number;
  stake: number;
  synthetic: boolean;
  syntheticDetail: string | null;
  legStatus: string | null;
  legReturn: number | null;
}

export interface SimulationBetDto {
  id: number;
  uniqueKey: string;
  category: "case1_arb" | "case2_ev" | "synth_arb";
  matchId: string;
  matchLabel: string;
  league: string;
  market: Market;
  lineKey: string;
  lineDisplay: string;
  selection: Selection;
  kickoffUtc: number;
  totalStake: number;
  expectedPayout: number;
  expectedProfit: number;
  roi: number;
  evPct: number | null;
  qTotal: number | null;
  placedAt: number;
  settledAt: number | null;
  resultStatus: string | null;
  realizedReturn: number | null;
  realizedPnl: number | null;
  finalScore: string | null;
  settlementSource: string | null;
  legs: SimulationLegDto[];
}

export interface SimulationSummary {
  category: "case1_arb" | "case2_ev" | "synth_arb";
  count: number;
  totalStake: number;
  expectedProfit: number;
  roi: number;
  settledCount: number;
  hitCount: number;
  realizedPnl: number;
  realizedRoi: number;
}

export interface SimulationsResponse {
  bets: SimulationBetDto[];
  summaries: SimulationSummary[];
  overall: {
    settledCount: number;
    totalStake: number;
    realizedPnl: number;
    realizedRoi: number;
    hitRate: number;
  };
}

export interface ResearchResultCollectorStatus {
  enabled: boolean;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastCollected: number;
}

export type ResearchStage = "initial" | "T30" | "T15" | "T5";
export type ResearchMarket = "AH" | "OU" | "COU";
export type ResearchProvider = "hkjc" | "pinnacle" | "crown";
export type FixtureSource = "hkjc" | "pinnacle" | "crown";
export type ResearchCellStatus =
  | "captured"
  | "partial"
  | "pending"
  | "source_unavailable"
  | "match_unmatched"
  | "market_unavailable"
  | "historical_unavailable"
  | "checkpoint_missed";

export interface ResearchTimelineQuote {
  provider: ResearchProvider;
  market: ResearchMarket;
  stage: ResearchStage;
  lineKey: string;
  selection: string;
  decimalOdds: number;
  isMain: boolean;
  sourceUpdatedAt: number | null;
  capturedAt: number;
  targetAt: number | null;
  /** How this immutable observation was collected. */
  origin: string;
  sourceName: string | null;
  sourceMatchId: string | null;
  sourceUrl: string | null;
}

export interface ResearchStageSnapshot {
  stage: ResearchStage;
  status: "captured" | "partial" | "pending" | "missing";
  targetAt: number | null;
  /** Immutable time when this checkpoint first obtained at least one quote. */
  firstCapturedAt: number | null;
  /** Latest later attempt to complete the checkpoint, if any. */
  lastRetryAt: number | null;
  /** Compatibility alias for firstCapturedAt. */
  capturedAt: number | null;
  /** Includes known unavailable source/market combinations. */
  note: string | null;
  quotes: ResearchTimelineQuote[];
  /** Per provider/market explanation for every populated or empty cell. */
  cells: Record<ResearchProvider, Record<ResearchMarket, ResearchCellStatus>>;
}

export interface ResearchMatchRow {
  matchId: string;
  fixtureKey: string;
  fixtureSource: FixtureSource;
  hkjcId: string | null;
  titanId: string | null;
  league: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: number;
  snapshotCount: number;
  firstSnapshotAt: number | null;
  lastSnapshotAt: number | null;
  timeline: Record<ResearchStage, ResearchStageSnapshot>;
  result: {
    homeScore: number;
    awayScore: number;
    cornersTotal: number | null;
    source: string;
    fetchedAt: number;
  } | null;
}

export interface ResearchDatasetResponse {
  generatedAt: number;
  filters: {
    days: number;
    provider: ResearchProvider | "all";
    market: ResearchMarket | "all";
  };
  summary: {
    snapshots: number;
    matches: number;
    completedResults: number;
    resultEligibleMatches: number;
    firstSnapshotAt: number | null;
    lastSnapshotAt: number | null;
    /** First checkpoint record created by the isolated research collector. */
    collectionStartedAt: number | null;
    providerCounts: Array<{ name: ResearchProvider; count: number }>;
    marketCounts: Array<{ name: ResearchMarket; count: number }>;
    stageCoverage: Array<{
      stage: ResearchStage;
      capturedMatches: number;
      totalMatches: number;
    }>;
  };
  collector: ResearchResultCollectorStatus;
  matches: ResearchMatchRow[];
}

export type OuSignalMode = "direct" | "reverse";
export type OuSignalMatchStatus = "upcoming" | "live" | "completed" | "awaiting_result";

export interface OuSignalRule {
  id: string;
  activatedAt?: number;
  provider: ResearchProvider;
  providerLabel: string;
  directionPath: string;
  driftBucket: string;
  lineMinInclusive?: number;
  lineMinExclusive?: number;
  lineMaxInclusive?: number;
  selectedT5OddsMinInclusive?: number;
  selectedT5OddsMaxInclusive?: number;
  signalSelection: "O" | "U";
  mode: OuSignalMode;
  historicalEdgePp: number;
  historicalNote: string;
  historicalSample?: number;
  historicalDecided?: number;
  historicalHits?: number;
  historicalHitRate?: number;
  historicalRoi?: number;
}

export interface OuSignalObservation {
  uniqueKey: string;
  matchId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: number;
  matchStatus: OuSignalMatchStatus;
  provider: ResearchProvider;
  providerLabel: string;
  ruleId: string;
  lineKey: string;
  directionPath: string;
  driftBucket: string;
  originalSelection: "O" | "U";
  signalSelection: "O" | "U";
  mode: OuSignalMode;
  referenceInitialOdds: number;
  referenceT5Odds: number;
  signalT5Odds: number;
  oddsGap: number;
  detectedAt: number;
  notifiedAt: number | null;
  result: {
    homeScore: number;
    awayScore: number;
    totalGoals: number;
    outcome: "hit" | "miss" | "push";
  } | null;
}

export interface OuSignalPrealert {
  uniqueKey: string;
  matchId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: number;
  provider: ResearchProvider;
  providerLabel: string;
  ruleId: string;
  lineKey: string;
  directionPath: string;
  signalSelection: "O" | "U";
  mode: OuSignalMode;
  initialSelectedOdds: number;
  t30SelectedOdds: number;
  signalT30Odds: number;
  detectedAt: number;
  notifiedAt: number | null;
}

export interface OuSignalRuleSummary {
  rule: OuSignalRule;
  observations: number;
  pending: number;
  settled: number;
  hits: number;
  misses: number;
  pushes: number;
  prospectiveHitRate: number | null;
}

export interface OuSignalDatasetResponse {
  generatedAt: number;
  activatedAt: number;
  rules: OuSignalRule[];
  summaries: OuSignalRuleSummary[];
  observations: OuSignalObservation[];
}

export const CATEGORY_LABEL: Record<string, string> = {
  case1_arb: "情況一 · 兩邊鎖利",
  case2_ev: "情況二 · 正期望值",
  synth_arb: "合成賠率 · 鎖利",
};
