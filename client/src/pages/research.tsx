import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, Database, Download, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, RadarLogo, TableSkeleton, ThemeToggle, fmtKickoff, fmtMoney, fmtTime } from "@/components/radar-ui";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { MARKET_LABEL, type Market, type Provider, type ResearchDatasetResponse } from "@shared/types";

const PROVIDER_LABEL: Record<Provider, string> = {
  hkjc: "馬會",
  pinnacle: "Pinnacle",
  crown: "皇冠",
};

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export default function Research() {
  const [days, setDays] = useState("7");
  const [provider, setProvider] = useState<Provider | "all">("all");
  const [market, setMarket] = useState<Market | "all">("all");
  const [search, setSearch] = useState("");
  const [downloading, setDownloading] = useState<"snapshots" | "results" | null>(null);
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

  const coverage = data?.summary.resultEligibleMatches
    ? data.summary.completedResults / data.summary.resultEligibleMatches
    : 0;

  const download = async (kind: "snapshots" | "results") => {
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
    <div className="flex min-h-[100dvh] flex-col overflow-y-auto bg-background text-foreground md:h-screen md:overflow-hidden">
      <header className="shrink-0 border-b border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <RadarLogo className="h-7 w-7 text-pinnacle" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold leading-tight" data-testid="text-page-title">
              研究數據庫
            </h1>
            <p className="truncate text-[10px] text-muted-foreground">
              全自動賠率快照與官方賽果 · 保留 120 日
            </p>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Link
              href="/"
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover-elevate"
              data-testid="link-tab-dashboard"
            >
              <ArrowLeft className="h-3 w-3" />
              賠率對比
            </Link>
            <Link
              href="/simulations"
              className="hidden rounded px-2 py-1 text-xs text-muted-foreground hover-elevate sm:block"
              data-testid="link-tab-simulations"
            >
              模擬投注
            </Link>
            <ThemeToggle />
          </div>
        </div>

        <div className="grid grid-cols-2 divide-x divide-y divide-border border-t border-border sm:grid-cols-4 sm:divide-y-0">
          <div className="px-3 py-2">
            <p className="text-[10px] text-muted-foreground">賠率快照</p>
            <p className="tnum text-lg font-semibold" data-testid="kpi-research-snapshots">
              {data ? fmtMoney(data.summary.snapshots) : "—"}
            </p>
          </div>
          <div className="px-3 py-2">
            <p className="text-[10px] text-muted-foreground">追蹤賽事</p>
            <p className="tnum text-lg font-semibold" data-testid="kpi-research-matches">
              {data ? fmtMoney(data.summary.matches) : "—"}
            </p>
          </div>
          <div className="px-3 py-2">
            <p className="text-[10px] text-muted-foreground">已收賽果</p>
            <p className="tnum text-lg font-semibold text-positive" data-testid="kpi-research-results">
              {data ? fmtMoney(data.summary.completedResults) : "—"}
            </p>
          </div>
          <div className="px-3 py-2">
            <p className="text-[10px] text-muted-foreground">賽果覆蓋率</p>
            <p className="tnum text-lg font-semibold" data-testid="kpi-research-coverage">
              {data ? percent(coverage) : "—"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="h-8 w-[110px] text-xs" data-testid="select-research-days">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">最近 1 日</SelectItem>
              <SelectItem value="7">最近 7 日</SelectItem>
              <SelectItem value="30">最近 30 日</SelectItem>
              <SelectItem value="120">最近 120 日</SelectItem>
            </SelectContent>
          </Select>
          <Select value={provider} onValueChange={(value) => setProvider(value as Provider | "all")}>
            <SelectTrigger className="h-8 w-[120px] text-xs" data-testid="select-research-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有來源</SelectItem>
              <SelectItem value="hkjc">馬會</SelectItem>
              <SelectItem value="pinnacle">Pinnacle</SelectItem>
              <SelectItem value="crown">皇冠</SelectItem>
            </SelectContent>
          </Select>
          <Select value={market} onValueChange={(value) => setMarket(value as Market | "all")}>
            <SelectTrigger className="h-8 w-[120px] text-xs" data-testid="select-research-market">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有玩法</SelectItem>
              <SelectItem value="1X2">主客和</SelectItem>
              <SelectItem value="AH">亞洲讓球</SelectItem>
              <SelectItem value="OU">入球大細</SelectItem>
              <SelectItem value="COU">角球大細</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative min-w-[180px] flex-1 sm:max-w-[280px]">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜尋球隊、聯賽"
              className="h-8 pl-8 text-xs"
              data-testid="input-research-search"
            />
          </div>
          <div className="ml-auto flex gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 text-xs"
              onClick={() => download("snapshots")}
              disabled={downloading !== null}
              data-testid="button-export-snapshots"
            >
              <Download className="h-3.5 w-3.5" />
              賠率 CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 text-xs"
              onClick={() => download("results")}
              disabled={downloading !== null}
              data-testid="button-export-results"
            >
              <Download className="h-3.5 w-3.5" />
              賽果 CSV
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Database className={cn("h-3 w-3", data?.collector.lastError ? "text-negative" : "text-positive")} />
            賽果收集器：{data?.collector.enabled ? "運行中" : "已停用"}
          </span>
          <span>最近成功 {fmtTime(data?.collector.lastSuccessAt)}</span>
          <span>最近新增 {data?.collector.lastCollected ?? 0} 場</span>
          <span>最近快照 {fmtTime(data?.summary.lastSnapshotAt)}</span>
          {data?.collector.lastError ? <span className="text-negative">{data.collector.lastError}</span> : null}
        </div>
      </header>

      <main
        className="min-h-[240px] w-full flex-1 overflow-x-auto overflow-y-visible overscroll-contain md:min-h-0 md:overflow-auto"
        data-testid="scroll-research"
      >
        {isLoading ? (
          <TableSkeleton rows={8} />
        ) : isError ? (
          <EmptyState title="讀取不到研究數據" hint="請確認後端服務正在運行。" testId="error-research" />
        ) : rows.length === 0 ? (
          <EmptyState title="呢個篩選暫時未有數據" hint="系統會在背景繼續收集賠率快照及完場賽果。" testId="empty-research" />
        ) : (
          <table className="w-full min-w-[900px] border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="border-b border-grid px-3 py-2 font-medium">開賽時間</th>
                <th className="border-b border-grid px-3 py-2 font-medium">賽事</th>
                <th className="border-b border-grid px-3 py-2 font-medium">來源</th>
                <th className="border-b border-grid px-3 py-2 font-medium">玩法</th>
                <th className="border-b border-grid px-3 py-2 text-right font-medium">快照</th>
                <th className="border-b border-grid px-3 py-2 font-medium">收集區間</th>
                <th className="border-b border-grid px-3 py-2 text-right font-medium">賽果</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.matchId} className="align-top hover:bg-accent/40" data-testid={`row-research-${row.matchId}`}>
                  <td className="tnum whitespace-nowrap border-b border-grid px-3 py-2 text-muted-foreground">
                    {fmtKickoff(row.kickoffUtc)}
                  </td>
                  <td className="border-b border-grid px-3 py-2">
                    <span className="block max-w-[260px] truncate font-medium">{row.homeTeam} vs {row.awayTeam}</span>
                    <span className="block max-w-[260px] truncate text-[10px] text-muted-foreground">{row.league}</span>
                  </td>
                  <td className="border-b border-grid px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {row.providers.map((name) => (
                        <span key={name} className="block whitespace-nowrap">
                          <span className={cn(
                            "mr-1 rounded px-1.5 py-0.5 text-[10px]",
                            name === "hkjc" ? "bg-hkjc/10 text-hkjc" : name === "pinnacle" ? "bg-pinnacle/10 text-pinnacle" : "bg-positive/15 text-positive",
                          )}>
                            {PROVIDER_LABEL[name]}
                          </span>
                          <span className="tnum text-[10px] text-muted-foreground">
                            {fmtTime(row.latestByProvider[name])}
                          </span>
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="border-b border-grid px-3 py-2">
                    {row.markets.map((name) => MARKET_LABEL[name]).join(" · ")}
                  </td>
                  <td className="tnum border-b border-grid px-3 py-2 text-right font-semibold">
                    {fmtMoney(row.snapshotCount)}
                  </td>
                  <td className="tnum border-b border-grid px-3 py-2 text-[10px] text-muted-foreground">
                    <span className="block">{fmtTime(row.firstSnapshotAt)}</span>
                    <span className="block">至 {fmtTime(row.lastSnapshotAt)}</span>
                  </td>
                  <td className="tnum border-b border-grid px-3 py-2 text-right">
                    {row.result ? (
                      <>
                        <span className="block text-sm font-semibold">{row.result.homeScore}–{row.result.awayScore}</span>
                        <span className="block text-[10px] text-muted-foreground">
                          {row.result.cornersTotal === null ? "角球待補" : `角球 ${row.result.cornersTotal}`}
                        </span>
                      </>
                    ) : row.kickoffUtc < Date.now() ? (
                      <span className="text-[10px] text-muted-foreground">待官方賽果</span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">未開賽</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}
