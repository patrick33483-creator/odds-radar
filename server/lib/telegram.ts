import { rawDb, getState, setState } from "./store";
import { formatSelectionLine } from "./lines";
import { markOuSignalNotified } from "./ou-signals";
import type { OuSignalObservation } from "@shared/types";

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

function buildOuSignalMessage(signal: OuSignalObservation): string {
  const buy = signal.signalSelection === "O" ? "大球" : "小球";
  const mode = signal.mode === "reverse" ? "反向買入訊號" : "歷史正向訊號";
  return [
    "盤路雷達：OU 買入提示",
    `${mode}｜${signal.providerLabel}`,
    `${signal.league}｜${signal.homeTeam} vs ${signal.awayTeam}`,
    `開賽：${hkt(signal.kickoffUtc)} HKT`,
    `建議留意：${buy} ${signal.lineKey}｜T-5 賠率 ${signal.signalT5Odds.toFixed(3)}`,
    `盤路：${signal.directionPath}｜${signal.driftBucket}`,
    `收水判定（原方向 ${signal.originalSelection === "O" ? "大" : "小"}）：初盤 ${signal.referenceInitialOdds.toFixed(3)} → T-5 ${signal.referenceT5Odds.toFixed(3)}（差 ${signal.oddsGap >= 0 ? "+" : ""}${signal.oddsGap.toFixed(3)}）`,
    signal.mode === "reverse"
      ? "注意：呢個係歷史原方向負 edge 推導嘅反向觀察訊號，唔代表反向 edge 已獨立證實。"
      : "條件已按歷史正 edge 規則觸發。",
    "請自行核對即時盤口、賠率同陣容後先落實投注。",
  ].join("\n");
}

export async function notifyOuSignals(signals: OuSignalObservation[]): Promise<number> {
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
        text: buildOuSignalMessage(signal),
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await response.json().catch(() => ({}))) as TelegramApiResponse;
    if (!response.ok || !payload.ok) {
      throw new Error(`Telegram OU signal delivery failed: ${payload.description ?? response.status}`);
    }
    markOuSignalNotified(signal.uniqueKey);
    sent += 1;
  }
  return sent;
}
