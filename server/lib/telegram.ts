import { rawDb, getState, setState } from "./store";
import { formatSelectionLine } from "./lines";

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
  return [
    "盤路雷達：發現新模擬注單",
    `${CATEGORY_LABEL[bet.category] ?? bet.category}｜${bet.league}`,
    bet.match_label,
    `開賽：${hkt(bet.kickoff_utc)} HKT`,
    ...legLines,
    `總注碼：${money(bet.total_stake)}`,
    `${metric}｜預期盈利：${money(bet.expected_profit)}`,
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
