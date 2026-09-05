import { rawDb, getState, setState } from "./store";
import { formatSelectionLine } from "./lines";
import {
  computeOuRuleHitRate,
  markOuPrealertNotified,
  markOuSignalNotified,
  ouRuleById,
  ouRuleT5OddsRange,
  type OuHitRateResult,
} from "./ou-signals";
import type { OuSignalObservation, OuSignalPrealert, OuSignalRule } from "@shared/types";

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
}

interface BetRow {
  id: number;
  unique_key: string;
  category: string;
  match_label: string;
  league: string;
  market: string;
  line_key: string;
  selection: string;
  kickoff_utc: number;
  total_stake: number;
  expected_profit: number;
  roi: number;
  ev_pct: number | null;
}

interface LegRow {
  provider: string;
  market: string;
  line_key: string;
  selection: string;
  decimal_odds: number;
  stake: number;
  synthetic: number;
}

const CATEGORY_LABEL: Record<string, string> = {
  case1_arb: "對位鎖利",
  case2_ev: "正 EV",
  synth_arb: "合成鎖利",
};

const PROVIDER_LABEL: Record<string, string> = {
  hkjc: "馬會",
  crown: "皇冠",
  pinnacle: "Pinnacle（只作參考）",
};

const MARKET_LABEL: Record<string, string> = {
  "1X2": "主客和",
  AH: "讓球",
  OU: "入球大細",
  COU: "角球大細",
};

function money(value: number): string {
  return `HK$${Math.round(value).toLocaleString("en-HK")}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function hkt(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-HK", {
    timeZone: "Asia/Hong_Kong",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function buildMessage(bet: BetRow, legs: LegRow[]): string {
  const [home = "主隊", away = "客隊"] = bet.match_label.split(/\s+vs\s+/i);
  const selectionLabel = (leg: LegRow, display: string): string => {
    if (leg.market === "1X2") {
      return leg.selection === "H" ? `主勝（${home}）` : leg.selection === "D" ? "和局" : `客勝（${away}）`;
    }
    if (leg.market === "AH") {
      const team = leg.selection === "H" ? home : away;
      return `${team} ${display}`;
    }
    return `${leg.selection === "O" ? "大" : "細"} ${display}`;
  };
  const legLines = legs.map(
    (leg) => {
      const market = leg.market as import("@shared/types").Market;
      const value = leg.line_key ? Number(leg.line_key) : null;
      const display = formatSelectionLine(market, value, leg.selection);
      return `- ${PROVIDER_LABEL[leg.provider] ?? leg.provider}｜${MARKET_LABEL[leg.market] ?? leg.market}｜${selectionLabel(leg, display)}｜賠率 ${leg.decimal_odds.toFixed(3)}｜注碼 ${money(leg.stake)}${leg.synthetic ? "（合成盤）" : ""}`;
    },
  );
  const metric =
    bet.category === "case2_ev" && bet.ev_pct !== null
      ? `EV：${percent(bet.ev_pct)}`
      : `預期回報率：${percent(bet.roi)}`;
  // A single direct HKJC leg has a meaningful scalar minimum price. Synthetic
  // routes are combinations of several stakes, so showing one component's odds
  // as the minimum would be misleading.
  const evLeg =
    bet.category === "case2_ev" && legs.length === 1 && !legs[0]?.synthetic
      ? legs[0]
      : undefined;
  const minimumAcceptableOdds =
    evLeg && bet.ev_pct !== null && bet.ev_pct > -1
      ? (evLeg.decimal_odds * 1.03) / (1 + bet.ev_pct)
      : null;
  return [
    "盤路雷達：發現新模擬注單",
    "✅ 已用馬會即時盤口完成二次確認",
    `${CATEGORY_LABEL[bet.category] ?? bet.category}｜${bet.league}`,
    bet.match_label,
    `開賽：${hkt(bet.kickoff_utc)} HKT`,
    ...legLines,
    `總注碼：${money(bet.total_stake)}`,
    `${metric}｜預期盈利：${money(bet.expected_profit)}`,
    ...(minimumAcceptableOdds !== null
      ? [`最低可接受賠率：${minimumAcceptableOdds.toFixed(3)}（以 EV 3% 門檻計）`]
      : []),
    "請自行核對即時盤口後才落實投注。",
  ].join("\n");
}

export async function notifySimulationBets(newBetKeys: string[]): Promise<number> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId || !newBetKeys.length) return 0;

  const getBet = rawDb.prepare("SELECT * FROM simulation_bets WHERE unique_key=?");
  const getLegs = rawDb.prepare("SELECT * FROM simulation_legs WHERE bet_id=? ORDER BY id");
  let sent = 0;

  for (const rawKey of newBetKeys) {
    const uniqueKey = rawKey.startsWith("bet|") ? rawKey.slice(4) : rawKey;
    const stateKey = `telegram_sent:${uniqueKey}`;
    if (getState(stateKey)) continue;
    const bet = getBet.get(uniqueKey) as BetRow | undefined;
    if (!bet) continue;
    const legs = getLegs.all(bet.id) as LegRow[];

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: buildMessage(bet, legs),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await response.json().catch(() => ({}))) as TelegramApiResponse;
    if (!response.ok || !payload.ok) {
      throw new Error(`Telegram delivery failed: ${payload.description ?? response.status}`);
    }
    setState(stateKey, String(Date.now()));
    sent += 1;
  }
  return sent;
}

/**
 * Format the live prospective record without hiding small samples.
 */
export function formatOuHitRateLine(result: OuHitRateResult | null): string {
  if (!result) return "前瞻命中：暫時無法計算";
  if (result.hitRate === null) return `前瞻命中：${result.hits}/${result.sample}，暫無已結算賽事`;
  const pct = (result.hitRate * 100).toFixed(1);
  return `前瞻命中：${result.hits}/${result.sample}，${pct}%`;
}

function safeHitRateLine(ruleId: string, lineKey: string, context: string): string {
  try {
    return formatOuHitRateLine(computeOuRuleHitRate(ruleId, lineKey));
  } catch (err) {
    console.error(`[telegram] ${context} hit-rate compute failed`, {
      ruleId,
      lineKey,
      error: (err as Error).message,
    });
    return formatOuHitRateLine(null);
  }
}

function historicalLine(rule: OuSignalRule): string {
  if (
    rule.historicalSample !== undefined
    && rule.historicalDecided !== undefined
    && rule.historicalHits !== undefined
    && rule.historicalHitRate !== undefined
  ) {
    return `歷史命中：${rule.historicalHits}/${rule.historicalDecided}，${(rule.historicalHitRate * 100).toFixed(1)}%`;
  }
  return `歷史命中：${rule.historicalNote}`;
}

function boundary(value: number, inclusive: boolean, lower: boolean): string {
  if (inclusive) return lower ? `≥ ${value.toFixed(3)}` : `≤ ${value.toFixed(3)}`;
  return lower ? `> ${value.toFixed(3)}` : `< ${value.toFixed(3)}`;
}

function t5OddsRangeLine(
  rule: OuSignalRule,
  initialSignalOdds: number,
  sideLabel = "原方向",
): string {
  const range = ouRuleT5OddsRange(rule, initialSignalOdds);
  if (!range) return `條件 T-5 ${sideLabel}賠率範圍：按目前初盤沒有可達成範圍`;
  const lower = boundary(range.min, range.minInclusive, true);
  const upper = range.max === null
    ? ""
    : ` 且 ${boundary(range.max, range.maxInclusive, false)}`;
  return `條件 T-5 ${sideLabel}賠率範圍：${lower}${upper}`;
}

function prealertFormulaLine(
  rule: OuSignalRule,
  sideLabel: string,
  initialSignalOdds: number,
): string {
  const prefix = `條件公式：初盤${sideLabel} ${initialSignalOdds.toFixed(3)} − T-5 ${sideLabel}`;
  if (rule.driftBucket === "收水 0.05–0.10") return `${prefix}；差值 ≥ 0.050 且 < 0.100`;
  if (rule.driftBucket === "收水 0.10–0.20") return `${prefix}；差值 ≥ 0.100 且 < 0.200`;
  if (rule.driftBucket === "持平或拉闊") return `${prefix}；差值 ≤ 0.000`;
  return `${prefix}；水位差不限`;
}

function lineCondition(rule: OuSignalRule): string {
  const parts: string[] = [];
  if (rule.lineMinInclusive !== undefined) parts.push(`主盤 ≥ ${rule.lineMinInclusive}`);
  if (rule.lineMinExclusive !== undefined) parts.push(`主盤 > ${rule.lineMinExclusive}`);
  if (rule.lineMaxInclusive !== undefined) parts.push(`主盤 ≤ ${rule.lineMaxInclusive}`);
  return parts.join("、");
}

function ruleConditionLine(rule: OuSignalRule, label = "達成條件"): string {
  const parts = [
    rule.providerLabel,
    `方向 ${rule.directionPath}`,
    rule.driftBucket,
    lineCondition(rule),
  ].filter(Boolean);
  return `${label}：${parts.join("｜")}`;
}

function signalLines(signal: OuSignalObservation): string[] {
  const buy = signal.signalSelection === "O" ? "大球" : "小球";
  const mode = signal.mode === "reverse" ? "反向買入訊號" : "歷史正向訊號";
  const rule = ouRuleById(signal.ruleId);
  const initialLineKey = signal.initialLineKey ?? signal.lineKey;
  const t5LineKey = signal.t5LineKey ?? signal.lineKey;
  const linePath = signal.linePath ?? `${initialLineKey}→${signal.t30LineKey ?? signal.lineKey}→${t5LineKey}`;
  const movement = signal.driftComparable !== false && signal.oddsGap !== null
    ? `同線水位差 ${signal.oddsGap >= 0 ? "+" : ""}${signal.oddsGap.toFixed(3)}`
    : "跨盤：不作原始賠率差比較";
  return [
    `${mode}｜${signal.providerLabel}｜${buy} ${signal.lineKey} @ ${signal.signalT5Odds.toFixed(3)}`,
    rule ? ruleConditionLine(rule, "命中條件") : `命中條件：${signal.ruleId}`,
    `主盤線路：${linePath}`,
    `T-5 最終：${buy} ${t5LineKey} @ ${signal.signalT5Odds.toFixed(3)}`,
    `盤路：${signal.directionPath}｜${signal.driftBucket}`,
    `原方向 ${signal.originalSelection === "O" ? "大" : "小"}：初盤 ${initialLineKey} @ ${signal.referenceInitialOdds.toFixed(3)} → T-5 ${t5LineKey} @ ${signal.referenceT5Odds.toFixed(3)}（${movement}）`,
    ...(rule ? [t5OddsRangeLine(rule, signal.referenceInitialOdds)] : []),
    rule ? historicalLine(rule) : "歷史：暫無可核實統計",
    safeHitRateLine(signal.ruleId, signal.lineKey, "observation"),
  ];
}

export function buildOuSignalMessage(signals: OuSignalObservation[]): string {
  const first = signals[0];
  if (!first) return "";
  const details = signals.flatMap((signal, index) => [
    ...(index ? [""] : []),
    `條件 ${index + 1}`,
    ...signalLines(signal),
  ]);
  return [
    "盤路雷達：T-5 OU 合資格賽事",
    `${first.league}｜${first.homeTeam} vs ${first.awayTeam}`,
    `開賽：${hkt(first.kickoffUtc)} HKT`,
    `命中條件：${signals.length} 條`,
    "",
    ...details,
    "",
    "純統計追蹤；請自行核對即時盤口、賠率同陣容。",
  ].join("\n");
}

export async function notifyOuSignals(signals: OuSignalObservation[]): Promise<number> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId || !signals.length) return 0;
  let sent = 0;
  const byMatch = new Map<string, OuSignalObservation[]>();
  for (const signal of signals) {
    byMatch.set(signal.matchId, [...(byMatch.get(signal.matchId) ?? []), signal]);
  }
  for (const groupedSignals of byMatch.values()) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: buildOuSignalMessage(groupedSignals),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await response.json().catch(() => ({}))) as TelegramApiResponse;
    if (!response.ok || !payload.ok) {
      throw new Error(`Telegram OU signal delivery failed: ${payload.description ?? response.status}`);
    }
    for (const signal of groupedSignals) markOuSignalNotified(signal.uniqueKey);
    sent += 1;
  }
  return sent;
}

export function buildOuPrealertMessage(signal: OuSignalPrealert): string {
  const possibleBuy = signal.signalSelection === "O" ? "大球" : "小球";
  const mode = signal.mode === "reverse" ? "反向候選" : "正向候選";
  const rule = ouRuleById(signal.ruleId);
  const initialLineKey = signal.initialLineKey ?? signal.lineKey;
  const t30LineKey = signal.t30LineKey ?? signal.lineKey;
  const linePath = signal.linePath ?? `${initialLineKey}→${t30LineKey}`;
  const initialSignalOdds = signal.initialSignalOdds ?? null;
  const driftSide = rule?.directionPath.split("→").at(-1) ?? signal.signalSelection;
  const driftSideLabel = driftSide === "O" ? "大球" : "小球";
  return [
    "盤路雷達：T-30 OU 候選預警",
    `${mode}｜${signal.providerLabel}`,
    `${signal.league}｜${signal.homeTeam} vs ${signal.awayTeam}`,
    `開賽：${hkt(signal.kickoffUtc)} HKT`,
    `目前兩段方向：${signal.directionPath}`,
    `主盤線路：${linePath}`,
    `低水方賠率：初盤 ${signal.initialSelectedOdds.toFixed(3)} → T-30 ${signal.t30SelectedOdds.toFixed(3)}`,
    initialSignalOdds === null
      ? `訊號邊初盤：${driftSideLabel} ${initialLineKey}｜舊紀錄未儲存賠率`
      : `訊號邊初盤：${driftSideLabel} ${initialLineKey} @ ${initialSignalOdds.toFixed(3)}`,
    `如果 T-5 完成條件，可能留意：${possibleBuy}｜目前 T-30 ${t30LineKey} @ ${signal.signalT30Odds.toFixed(3)}`,
    ...(rule ? [
      ruleConditionLine(rule, "候選條件"),
      ...(initialSignalOdds === null
        ? ["條件公式：舊紀錄未儲存訊號邊初盤賠率，無法重算"]
        : [
          prealertFormulaLine(rule, driftSideLabel, initialSignalOdds),
          t5OddsRangeLine(rule, initialSignalOdds, driftSideLabel),
        ]),
      historicalLine(rule),
    ] : []),
    safeHitRateLine(signal.ruleId, signal.lineKey, "prealert"),
  ].join("\n");
}

export async function notifyOuPrealerts(signals: OuSignalPrealert[]): Promise<number> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId || !signals.length) return 0;
  let sent = 0;
  for (const signal of signals) {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: buildOuPrealertMessage(signal),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await response.json().catch(() => ({}))) as TelegramApiResponse;
    if (!response.ok || !payload.ok) {
      throw new Error(`Telegram OU T-30 prealert delivery failed: ${payload.description ?? response.status}`);
    }
    markOuPrealertNotified(signal.uniqueKey);
    sent += 1;
  }
  return sent;
}

/**
 * Send a plain operational message. Returns false when Telegram is not
 * configured so callers can treat that as "not delivered" rather than success.
 */
export async function sendTelegramText(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId || !text.trim()) return false;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json().catch(() => ({}))) as TelegramApiResponse;
  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram delivery failed: ${payload.description ?? response.status}`);
  }
  return true;
}
