import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CircleDashed,
  Clock3,
  Database,
  Download,
  ExternalLink,
  Search,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, RadarLogo, TableSkeleton, ThemeToggle, fmtKickoff, fmtMoney, fmtTime } from "@/components/radar-ui";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  MARKET_LABEL,
  SELECTION_LABEL,
  type ResearchDatasetResponse,
  type ResearchMarket,
  type ResearchMatchRow,
  type ResearchProvider,
  type ResearchStage,
  type ResearchStageSnapshot,
  type ResearchTimelineQuote,
  type Selection,
} from "@shared/types";

const PROVIDERS: ResearchProvider[] = ["hkjc", "pinnacle"];
const MARKETS: ResearchMarket[] = ["AH", "OU", "COU"];
const STAGES: ResearchStage[] = ["initial", "T30", "T15", "T5"];
const PROVIDER_LABEL: Record<ResearchProvider, string> = { hkjc: "馬會", pinnacle: "Pinnacle" };
const STAGE_LABEL: Record<ResearchStage, string> = {
  initial: "初盤",
  T30: "T-30",
  T15: "T-15",
  T5: "T-5",
};

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function stageTone(status: ResearchStageSnapshot["status"]): string {
  if (status === "captured") return "border-positive/30 bg-positive/10 text-positive";
  if (status === "partial") return "border-warning/30 bg-warning/10 text-warning";
  if (status === "pending") return "border-pinnacle/30 bg-pinnacle/10 text-pinnacle";
  return "border-negative/30 bg-negative/10 text-negative";
}

function StageBadge({ snapshot }: { snapshot: ResearchStageSnapshot }) {
  const Icon = snapshot.status === "captured" ? Check : snapshot.status === "pending" ? CircleDashed : TriangleAlert;
  const text = snapshot.status === "captured" ? "已收集" : snapshot.status === "partial" ? "部分" : snapshot.status === "pending" ? "待收集" : "缺失";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]", stageTone(snapshot.status))}>
      <Icon className="h-3 w-3" />
      {STAGE_LABEL[snapshot.stage]} {text}
    </span>
  );
}

function quoteLines(quotes: ResearchTimelineQuote[]): Array<{ lineKey: string; main: boolean; prices: ResearchTimelineQuote[] }> {
  const groups = new Map<string, ResearchTimelineQuote[]>();
  for (const quote of quotes) groups.set(quote.lineKey, [...(groups.get(quote.lineKey) ?? []), quote]);
  return [...groups.entries()]
    .map(([lineKey, prices]) => ({ lineKey, main: prices.some((price) => price.isMain), prices }))
    .sort((a, b) => Number(b.main) - Number(a.main) || Number(a.lineKey) - Number(b.lineKey));
}

function selectionLabel(selection: string): string {
  return SELECTION_LABEL[selection as Selection] ?? selection;
}

function TimelineCell({
  snapshot,
  provider,
  market,
}: {
  snapshot: ResearchStageSnapshot;
  provider: ResearchProvider;
  market: ResearchMarket;
}) {
  const quotes = snapshot.quotes.filter((quote) => quote.provider === provider && quote.market === market);
  const lines = quoteLines(quotes);
  if (!lines.length) {
    const unavailableOpening = snapshot.stage === "initial" && provider === "pinnacle" && market === "COU";
    return (
      <div className="flex min-h-16 flex-col items-center justify-center gap-1 px-2 py-3 text-center text-[10px] text-muted-foreground">
        <span>{unavailableOpening ? "真初盤來源缺失" : snapshot.status === "pending" ? "待收集" : "沒有記錄"}</span>
        {unavailableOpening ? <span className="max-w-[150px] text-warning">不會用首次觀察盤代替</span> : null}
      </div>
    );
  }
  return (
    <div className="min-w-[170px] space-y-1.5 px-2 py-2">
      {lines.map((line, index) => (
        <div key={line.lineKey} className={cn(index > 0 && "border-t border-grid pt-1.5")}>
          <div className="flex items-center gap-1 text-[10px]">
            <span className="tnum rounded bg-muted px-1 py-0.5 font-medium">{line.lineKey || "獨贏"}</span>
            {line.main ? <span className="text-pinnacle">主線</span> : null}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
            {line.prices.map((price) => (
              <span key={`${price.selection}-${price.decimalOdds}`} className="tnum whitespace-nowrap font-semibold">
                {selectionLabel(price.selection)} {price.decimalOdds.toFixed(2)}
              </span>
            ))}
          </div>
          <div className="mt-1 text-[10px] leading-4 text-muted-foreground">
            <span className="block">
              來源時間 {line.prices[0].sourceUpdatedAt ? fmtTime(line.prices[0].sourceUpdatedAt) : "來源未提供"}
            </span>
            <span className="block">收集 {fmtTime(line.prices[0].capturedAt)}</span>
            {line.prices[0].sourceUrl ? (
              <a
                href={line.prices[0].sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-pinnacle hover:underline"
                data-testid={`link-opening-source-${provider}-${market}-${line.lineKey}`}
              >
                {line.prices[0].sourceName === "tipsme" ? "Tipsme 開盤紀錄" : line.prices[0].sourceName ?? "外部來源"}
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
            ) : (
              <span className="block">{line.prices[0].origin === "live_observation" ? "Radar 定時快照" : "外部開盤紀錄"}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function MatchTimeline({ row }: { row: ResearchMatchRow }) {
  return (
    <details
      className="group overflow-hidden rounded-md border border-border bg-card"
      data-testid={`card-research-${row.matchId}`}
    >
      <summary
        className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-3 py-3 hover:bg-accent/30 [&::-webkit-details-marker]:hidden"
        data-testid={`button-expand-${row.matchId}`}
      >
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        <div className="min-w-[220px] flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold">{row.homeTeam} vs {row.awayTeam}</span>
            <span className="text-[10px] text-muted-foreground">{row.league}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Clock3 className="h-3 w-3" />
            {fmtKickoff(row.kickoffUtc)}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STAGES.map((stage) => <StageBadge key={stage} snapshot={row.timeline[stage]} />)}
        </div>
        <div className="min-w-[86px] text-right">
          {row.result ? (
            <>
              <span className="tnum block text-sm font-semibold text-positive">
                {row.result.homeScore}–{row.result.awayScore}
              </span>
              <span className="block text-[10px] text-muted-foreground">
                {row.result.cornersTotal === null ? "角球待補" : `角球 ${row.result.cornersTotal}`}
              </span>
            </>
          ) : (
            <span className="text-[10px] text-muted-foreground">
              {row.kickoffUtc > Date.now() ? "未開賽" : "待官方賽果"}
            </span>
          )}
        </div>
      </summary>

      <div className="overflow-x-auto border-t border-border">
        <table className="min-w-[980px] text-xs">
          <thead className="bg-muted/40 text-left text-[10px] text-muted-foreground">
            <tr>
              <th className="sticky left-0 z-[2] w-28 border-b border-r border-grid bg-muted px-3 py-2 font-medium">玩法</th>
              <th className="sticky left-28 z-[2] w-24 border-b border-r border-grid bg-muted px-3 py-2 font-medium">來源</th>
              {STAGES.map((stage) => (
                <th key={stage} className="min-w-[180px] border-b border-r border-grid px-2 py-2 font-medium">
                  {stage === "initial" ? "莊家真初盤" : STAGE_LABEL[stage]}
                  {row.timeline[stage].targetAt ? (
                    <span className="ml-1 font-normal">{fmtTime(row.timeline[stage].targetAt)}</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MARKETS.map((market) =>
              PROVIDERS.map((provider, providerIndex) => (
                <tr key={`${market}-${provider}`} className="align-top">
                  {providerIndex === 0 ? (
                    <th
                      rowSpan={2}
                      className="sticky left-0 z-[1] border-b border-r border-grid bg-card px-3 py-3 text-left font-medium"
                    >
                      {MARKET_LABEL[market]}
                    </th>
                  ) : null}
                  <th className="sticky left-28 z-[1] border-b border-r border-grid bg-card px-3 py-3 text-left font-medium">
                    <span className={cn(provider === "hkjc" ? "text-hkjc" : "text-pinnacle")}>
                      {PROVIDER_LABEL[provider]}
                    </span>
                  </th>
                  {STAGES.map((stage) => (
                    <td key={stage} className="border-b border-r border-grid">
                      <TimelineCell snapshot={row.timeline[stage]} provider={provider} market={market} />
                    </td>
                  ))}
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 bg-muted/20 px-3 py-2 text-[10px] text-muted-foreground">
        <span>初盤只採用可核實的莊家開盤紀錄；T-30／T-15／T-5 由 Radar 收集。每個階段鎖定後不會被新盤覆蓋。</span>
        <span className="tnum">共 {fmtMoney(row.snapshotCount)} 筆 · 最近 {fmtTime(row.lastSnapshotAt)}</span>
      </div>
    </details>
  );
}

export default function Research() {
  const [days, setDays] = useState("7");
  const [provider, setProvider] = useState<ResearchProvider | "all">("all");
  const [market, setMarket] = useState<ResearchMarket | "all">("all");
  const [search, setSearch] = useState("");
  const [downloading, setDownloading] = useState<"timeline" | "results" | null>(null);
  const query = `/api/research?days=${days}&provider=${provider}&market=${market}`;
  const { data, isLoading, isError } = useQuery<ResearchDatasetResponse>({
    queryKey: [query],
    refetchInterval: 60_000,
  });

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.matches ?? []).filter((row) =>
      term ? `${row.league}${row.homeTeam}${row.awayTeam}${row.matchId}`.toLowerCase().includes(term) : true,
    );
  }, [data, search]);
  const coverage = (stage: ResearchStage) => {
    const item = data?.summary.stageCoverage.find((entry) => entry.stage === stage);
    return item?.totalMatches ? item.capturedMatches / item.totalMatches : 0;
  };

  const download = async (kind: "timeline" | "results") => {
    setDownloading(kind);
    try {
      const response = await apiRequest("GET", `/api/research/export?kind=${kind}&days=${days}&provider=${provider}&market=${market}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `odds-radar-${kind}-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 shrink-0 border-b border-border bg-card/95 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <RadarLogo className="h-7 w-7 text-pinnacle" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold" data-testid="text-page-title">研究時間線</h1>
            <p className="truncate text-[10px] text-muted-foreground">馬會 × Pinnacle · 莊家真初盤 / T-30 / T-15 / T-5 / 賽果</p>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Link href="/" className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover-elevate" data-testid="link-tab-dashboard">
              <ArrowLeft className="h-3 w-3" />賠率對比
            </Link>
            <Link href="/simulations" className="hidden rounded px-2 py-1 text-xs text-muted-foreground hover-elevate sm:block" data-testid="link-tab-simulations">
              模擬投注
            </Link>
            <ThemeToggle />
          </div>
        </div>

        <div className="grid grid-cols-2 divide-x divide-y divide-border border-t border-border sm:grid-cols-4 sm:divide-y-0">
          <div className="px-3 py-2"><p className="text-[10px] text-muted-foreground">追蹤賽事</p><p className="tnum text-lg font-semibold" data-testid="kpi-research-matches">{data ? fmtMoney(data.summary.matches) : "—"}</p></div>
          <div className="px-3 py-2"><p className="text-[10px] text-muted-foreground">真初盤覆蓋</p><p className="tnum text-lg font-semibold" data-testid="kpi-research-initial">{data ? percent(coverage("initial")) : "—"}</p></div>
          <div className="px-3 py-2"><p className="text-[10px] text-muted-foreground">T-30 覆蓋</p><p className="tnum text-lg font-semibold text-pinnacle" data-testid="kpi-research-t30">{data ? percent(coverage("T30")) : "—"}</p></div>
          <div className="px-3 py-2"><p className="text-[10px] text-muted-foreground">已收賽果</p><p className="tnum text-lg font-semibold text-positive" data-testid="kpi-research-results">{data ? fmtMoney(data.summary.completedResults) : "—"}</p></div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="h-8 w-[110px] text-xs" data-testid="select-research-days"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="1">最近 1 日</SelectItem><SelectItem value="7">最近 7 日</SelectItem><SelectItem value="30">最近 30 日</SelectItem><SelectItem value="120">最近 120 日</SelectItem></SelectContent>
          </Select>
          <Select value={provider} onValueChange={(value) => setProvider(value as ResearchProvider | "all")}>
            <SelectTrigger className="h-8 w-[120px] text-xs" data-testid="select-research-provider"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">兩個來源</SelectItem><SelectItem value="hkjc">馬會</SelectItem><SelectItem value="pinnacle">Pinnacle</SelectItem></SelectContent>
          </Select>
          <Select value={market} onValueChange={(value) => setMarket(value as ResearchMarket | "all")}>
            <SelectTrigger className="h-8 w-[120px] text-xs" data-testid="select-research-market"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">三個玩法</SelectItem><SelectItem value="AH">亞洲讓球</SelectItem><SelectItem value="OU">入球大細</SelectItem><SelectItem value="COU">角球大細</SelectItem></SelectContent>
          </Select>
          <div className="relative min-w-[180px] flex-1 sm:max-w-[280px]">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜尋球隊、聯賽" className="h-8 pl-8 text-xs" data-testid="input-research-search" />
          </div>
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={() => download("timeline")} disabled={downloading !== null} data-testid="button-export-timeline"><Download className="h-3.5 w-3.5" />時間線 CSV</Button>
            <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={() => download("results")} disabled={downloading !== null} data-testid="button-export-results"><Download className="h-3.5 w-3.5" />賽果 CSV</Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><Database className={cn("h-3 w-3", data?.collector.lastError ? "text-negative" : "text-positive")} />研究資料獨立儲存</span>
          <span>賽果收集器：{data?.collector.enabled ? "運行中" : "已停用"}</span>
          <span>最近快照 {fmtTime(data?.summary.lastSnapshotAt)}</span>
          {data?.collector.lastError ? <span className="text-negative">{data.collector.lastError}</span> : null}
        </div>
      </header>

      <main className="flex-1 space-y-2 overflow-y-auto p-2 sm:p-3" data-testid="scroll-research">
        {isLoading ? <TableSkeleton rows={8} /> : isError ? (
          <EmptyState title="讀取不到研究數據" hint="請確認後端服務正在運行。" testId="error-research" />
        ) : rows.length === 0 ? (
          <EmptyState title="呢個篩選暫時未有數據" hint="系統會匯入可核實的莊家真初盤，並在背景收集 T-30、T-15、T-5 及完場賽果。" testId="empty-research" />
        ) : rows.map((row) => <MatchTimeline key={row.matchId} row={row} />)}
      </main>
    </div>
  );
}
