import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { ChevronDown, ChevronRight, RefreshCw, ScanSearch, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  ColdStartBanner,
  DemoBanner,
  EmptyState,
  ErrorBanner,
  ExecutionRouteBadge,
  Kpi,
  RadarLogo,
  RefreshButton,
  ScanButton,
  SourceBar,
  Sparkline,
  StatusPill,
  TableSkeleton,
  ThemeToggle,
  ageLabel,
  executionRouteFromEv,
  fmtKickoff,
  fmtMoney,
  fmtOdds,
  fmtPct,
  fmtTime,
} from "@/components/radar-ui";
import { MARKET_LABEL, SELECTION_LABEL, type DashboardResponse, type LineRow, type Market, type MatchRefreshResponse, type MatchRow, type Selection } from "@shared/types";

const MARKETS: Market[] = ["AH", "OU", "COU", "1X2"];
const WINDOWS = [
  { value: "all", label: "所有時間" },
  { value: "60", label: "1 小時內" },
  { value: "180", label: "3 小時內" },
  { value: "720", label: "12 小時內" },
];

export default function Dashboard() {
  const [, navigate] = useLocation();
  const [market, setMarket] = useState<Market>("AH");
  const [league, setLeague] = useState("all");
  const [win, setWin] = useState("all");
  const [search, setSearch] = useState("");
  const [exactOnly, setExactOnly] = useState(true);
  const [arbOnly, setArbOnly] = useState(false);
  const [showSynthetic, setShowSynthetic] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [matchRefreshFeedback, setMatchRefreshFeedback] = useState<{
    matchId: string;
    ok: boolean;
    message: string;
  } | null>(null);

  const { data, isLoading, isError, error } = useQuery<DashboardResponse>({
    queryKey: ["/api/dashboard"],
    refetchInterval: 20_000,
  });

  const refresh = useMutation({
    mutationFn: async () => {
      // Manual (human) refresh: dense window scope — no automated full scan.
      await apiRequest("POST", "/api/refresh");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] }),
  });

  // Explicit human-only full scan. Never wired to any timer or recurring path.
  const fullScan = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/refresh?scope=full");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] }),
  });

  // Manual trigger for the same pre-kickoff dense-scan path used by the
  // automatic 30-minute window runner.
  const scan = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/scan/window");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] }),
  });

  const matchRefresh = useMutation<MatchRefreshResponse, Error, string>({
    mutationFn: async (matchId) => {
      const response = await apiRequest("POST", "/api/refresh/match", { matchId });
      return response.json() as Promise<MatchRefreshResponse>;
    },
    onMutate: (matchId) => setMatchRefreshFeedback({ matchId, ok: true, message: "正在更新馬會、Pinnacle 及皇冠報價…" }),
    onSuccess: (result) => {
      setMatchRefreshFeedback({ matchId: result.matchId, ok: result.ok, message: result.message });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard"] });
    },
    onError: (err, matchId) => setMatchRefreshFeedback({ matchId, ok: false, message: err.message }),
  });

  const status = data?.status;

  const rows = useMemo(() => {
    if (!data) return [] as Array<MatchRow & { visible: LineRow[] }>;
    const now = Date.now();
    const term = search.trim().toLowerCase();
    return data.matches
      .map((m) => {
        const visible = m.lines.filter((l) => l.market === market && (!exactOnly || l.exactLine));
        return { ...m, visible };
      })
      .filter((m) => m.visible.length > 0)
      .filter((m) => (league === "all" ? true : m.league === league))
      .filter((m) => (win === "all" ? true : m.kickoffUtc - now <= Number(win) * 60_000))
      .filter((m) =>
        term
          ? `${m.homeTeam}${m.awayTeam}${m.league}`.toLowerCase().includes(term)
          : true,
      )
      .filter((m) => (arbOnly ? m.visible.some((l) => !!l.arb) || (showSynthetic && m.hasSynthetic) : true));
  }, [data, market, league, win, search, exactOnly, arbOnly, showSynthetic]);

  const sels: Selection[] = market === "1X2" ? ["H", "D", "A"] : market === "AH" ? ["H", "A"] : ["O", "U"];

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* ------------------------------- header ------------------------------ */}
      <header className="shrink-0 border-b border-border bg-card">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <RadarLogo className="h-7 w-7 shrink-0 text-pinnacle" />
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold leading-tight" data-testid="text-app-title">
                盤路雷達
              </h1>
              <p className="truncate text-[10px] text-muted-foreground">香港賽馬會 × Pinnacle 平博 · 賽前賠率對比</p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <StatusPill status={status} />
            <span className="tnum text-[10px] text-muted-foreground" data-testid="text-last-update">
              更新於 {fmtTime(status?.lastGoodAt ?? null)}
            </span>
          </div>

          <div className="ml-auto flex items-center gap-1">
            <nav className="mr-1 flex items-center gap-1 text-xs">
              <span className="whitespace-nowrap rounded bg-secondary px-2 py-1 font-medium" data-testid="link-tab-dashboard">
                賠率對比
              </span>
              <Link
                href="/simulations"
                className="whitespace-nowrap rounded px-2 py-1 text-muted-foreground hover-elevate"
                data-testid="link-tab-simulations"
              >
                模擬投注紀錄
              </Link>
            </nav>
            <ThemeToggle />
            <ScanButton onClick={() => scan.mutate()} busy={scan.isPending} last={status?.scan.lastScan ?? null} />
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 px-2 text-xs"
              onClick={() => fullScan.mutate()}
              disabled={fullScan.isPending}
              title="人手全場掃描：逐場抓取平博賠率明細。不會自動執行，亦沒有任何排程。"
              data-testid="button-full-scan"
            >
              <ScanSearch className="h-3.5 w-3.5" />
              <span className="hidden whitespace-nowrap md:inline">{fullScan.isPending ? "全場掃描中" : "全場掃描"}</span>
            </Button>
            <RefreshButton onClick={() => refresh.mutate()} busy={refresh.isPending || !!status?.refreshing} />
          </div>
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-3 divide-x divide-border border-t border-border sm:grid-cols-6">
          <Kpi label="賽事" value={status?.counts.matches ?? "—"} testId="kpi-matches" />
          <Kpi label="已配對" value={status?.counts.matched ?? "—"} tone="pinnacle" testId="kpi-matched" />
          <Kpi label="鎖利" value={status?.counts.arbs ?? "—"} tone="positive" testId="kpi-arbs" />
          <Kpi label="最高正期望值" value={status?.counts.ev ?? "—"} tone="hkjc" testId="kpi-ev" hint="馬會直接盤與合成盤比較後，每個同場同路項目只保留最高 EV" />
          <Kpi label="合成鎖利" value={status?.counts.synthetic ?? "—"} tone="synthetic" testId="kpi-synthetic" />
          <Kpi
            label="賠率快照"
            value={fmtMoney(status?.counts.snapshots)}
            tone="muted"
            testId="kpi-snapshots"
            hint="累積的原始賠率快照數量"
          />
        </div>

        <SourceBar status={status} />

        {status?.mode === "demo" ? <DemoBanner /> : null}
        {status?.coldStart ? <ColdStartBanner stage={status.coldStartStage} /> : null}
        {isError ? <ErrorBanner reason={`連接不到後端服務：${(error as Error)?.message ?? "未知錯誤"}。頁面數字會顯示為「—」，請確認伺服器正在運行。`} /> : null}
        {!isError && status?.mode === "degraded" && status.degradedReason ? <ErrorBanner reason={status.degradedReason} /> : null}

        {/* ------------------------------ filters ---------------------------- */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
          <div className="flex rounded-md border border-border p-0.5" role="tablist">
            {MARKETS.map((m) => (
              <button
                key={m}
                role="tab"
                aria-selected={market === m}
                onClick={() => setMarket(m)}
                className={cn(
                  "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                  market === m ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover-elevate",
                )}
                data-testid={`button-market-${m}`}
              >
                {MARKET_LABEL[m]}
              </button>
            ))}
          </div>

          <Select value={league} onValueChange={setLeague}>
            <SelectTrigger className="h-8 w-[140px] text-xs" data-testid="select-league">
              <SelectValue placeholder="所有聯賽" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有聯賽</SelectItem>
              {(data?.leagues ?? []).map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={win} onValueChange={setWin}>
            <SelectTrigger className="h-8 w-[120px] text-xs" data-testid="select-window">
              <SelectValue placeholder="所有時間" />
            </SelectTrigger>
            <SelectContent>
              {WINDOWS.map((w) => (
                <SelectItem key={w.value} value={w.value}>
                  {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜尋球隊或聯賽"
              className="h-8 w-[170px] pl-7 text-xs"
              data-testid="input-search"
            />
          </div>

          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch checked={exactOnly} onCheckedChange={setExactOnly} data-testid="switch-exact-line" />
            只看同盤路
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch checked={arbOnly} onCheckedChange={setArbOnly} data-testid="switch-arb-only" />
            只看有機會
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch checked={showSynthetic} onCheckedChange={setShowSynthetic} data-testid="switch-show-synthetic" />
            顯示合成賠率
          </label>
          <span className="tnum ml-auto text-[10px] text-muted-foreground" data-testid="text-row-count">
            {rows.length} / {data?.matches.length ?? 0} 場
          </span>
        </div>
      </header>

      {/* -------------------------------- table ------------------------------ */}
      <main className="min-h-0 flex-1 overflow-auto overscroll-x-contain">
        {isLoading ? (
          <TableSkeleton />
        ) : rows.length === 0 ? (
          <EmptyState
            title="沒有符合條件的賽事"
            hint="平博賠率明細只會在開賽前 30 分鐘的密集掃描視窗內抓取（現時視窗內可能無賽事）。可按「密集掃描」處理即將開賽場次，或按「全場掃描」人手抓取全部場次；亦可放寬「只看同盤路」先看馬會盤口。"
            testId="empty-odds-table"
          />
        ) : (
          <>
            <div
              className="sticky left-0 top-0 z-20 border-b border-grid bg-muted/80 px-3 py-1 text-center text-[10px] text-muted-foreground backdrop-blur sm:hidden"
              data-testid="text-mobile-scroll-hint"
            >
              ← 左右滑動查看全部賠率 →
            </div>
            <table className="w-full min-w-[560px] border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="sticky left-0 z-20 w-[200px] max-w-[200px] border-b border-grid bg-card px-2 py-1.5 font-medium sm:w-auto sm:max-w-none">
                  賽事
                </th>
                <th className="border-b border-grid px-2 py-1.5 font-medium">盤口</th>
                {sels.map((s) => (
                  <th key={s} className="border-b border-grid px-2 py-1.5 text-right font-medium">
                    {SELECTION_LABEL[s]}
                  </th>
                ))}
                <th className="border-b border-grid px-2 py-1.5 text-right font-medium">總機率</th>
                <th className="hidden border-b border-grid px-2 py-1.5 text-right font-medium sm:table-cell">走勢</th>
                <th className="hidden border-b border-grid px-2 py-1.5 text-right font-medium sm:table-cell">新鮮度</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) =>
                m.visible.map((l, idx) => {
                  const rowKey = `${m.id}-${l.market}-${l.lineKey}`;
                  const isOpen = expanded === rowKey;
                  const q = l.bestQ;
                  return (
                    <>
                      <tr
                        key={rowKey}
                        className={cn(
                          "group align-top hover:bg-accent/40",
                          l.arb && "bg-positive/10",
                          idx === 0 && "border-t border-grid",
                        )}
                        data-testid={`row-odds-${rowKey}`}
                      >
                        <td
                          className={cn(
                            "sticky left-0 z-[5] w-[200px] max-w-[200px] border-b border-grid bg-background px-2 py-1.5 group-hover:bg-accent/40 sm:w-auto sm:max-w-none",
                            l.arb && "bg-positive/10",
                          )}
                        >
                          {idx === 0 ? (
                            <button
                              className="flex items-start gap-1 text-left"
                              onClick={() => setExpanded(isOpen ? null : rowKey)}
                              data-testid={`button-expand-${m.id}`}
                            >
                              {isOpen ? (
                                <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                              )}
                              <span className="min-w-0">
                                <span className="block truncate font-medium">
                                  {m.homeTeam} <span className="text-muted-foreground">vs</span> {m.awayTeam}
                                </span>
                                <span className="tnum block text-[10px] text-muted-foreground">
                                  {m.league} · {fmtKickoff(m.kickoffUtc)}
                                  {m.matched ? (
                                    <span className="ml-1 text-pinnacle" title={`配對信心 ${fmtPct(m.mappingConfidence, 0)}`}>
                                      ✓{fmtPct(m.mappingConfidence, 0)}
                                    </span>
                                  ) : (
                                    <span className="ml-1 text-muted-foreground/70" title={m.unmatchedReason ?? "未配對"}>
                                      未配對
                                    </span>
                                  )}
                                </span>
                              </span>
                            </button>
                          ) : null}
                        </td>
                        <td className="tnum border-b border-grid px-2 py-1.5 font-medium">
                          {l.lineDisplay}
                          {l.isMain ? <span className="ml-1 text-[9px] text-muted-foreground">主</span> : null}
                        </td>
                        {sels.map((s) => (
                          <td key={s} className="tnum border-b border-grid px-2 py-1.5 text-right">
                            <div className="text-hkjc" data-testid={`odds-hkjc-${rowKey}-${s}`}>
                              {fmtOdds(l.hkjc[s]?.decimalOdds)}
                            </div>
                            <div className="text-pinnacle" data-testid={`odds-pinnacle-${rowKey}-${s}`}>
                              {fmtOdds(l.pinnacle[s]?.decimalOdds)}
                            </div>
                            {l.deltas[s] !== undefined ? (
                              <div
                                className={cn(
                                  "text-[9px]",
                                  (l.deltas[s] ?? 0) > 0 ? "text-positive" : "text-muted-foreground",
                                )}
                              >
                                {(l.deltas[s] ?? 0) > 0 ? "+" : ""}
                                {l.deltas[s]?.toFixed(2)}
                              </div>
                            ) : null}
                          </td>
                        ))}
                        <td
                          className={cn(
                            "tnum border-b border-grid px-2 py-1.5 text-right font-medium",
                            q !== null && q < 1 ? "text-positive" : "text-muted-foreground",
                          )}
                          data-testid={`text-q-${rowKey}`}
                        >
                          {q === null ? "—" : fmtPct(q)}
                        </td>
                        <td className="hidden border-b border-grid px-2 py-1.5 text-right sm:table-cell">
                          <Sparkline
                            values={sels
                              .map((s) => l.hkjc[s]?.prevDecimalOdds ?? l.hkjc[s]?.decimalOdds)
                              .filter((v): v is number => typeof v === "number")}
                            color="hsl(var(--hkjc))"
                          />
                        </td>
                        <td className="tnum hidden border-b border-grid px-2 py-1.5 text-right text-[10px] text-muted-foreground sm:table-cell">
                          {(() => {
                            const cells = sels.flatMap((s) => [l.hkjc[s], l.pinnacle[s]]).filter(Boolean);
                            if (!cells.length) return "—";
                            const worst = Math.max(...cells.map((c) => c!.ageSec));
                            return <span className={cn(worst > 90 && "text-negative")}>{ageLabel(worst)}</span>;
                          })()}
                        </td>
                      </tr>

                      {isOpen ? (
                        <tr key={`${rowKey}-detail`} data-testid={`row-detail-${rowKey}`}>
                          <td colSpan={sels.length + 5} className="border-b border-grid bg-accent/30 px-3 py-2">
                            <div className="mb-2 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
                              <p className="text-xs text-muted-foreground">
                                指定賽事刷新只更新此場報價，不會觸發全場掃描或模擬下注。
                              </p>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="gap-1.5"
                                onClick={() => matchRefresh.mutate(m.id)}
                                disabled={!m.matched || (matchRefresh.isPending && matchRefresh.variables === m.id)}
                                data-testid={`button-refresh-match-${m.id}`}
                              >
                                <RefreshCw
                                  className={cn(
                                    "h-3.5 w-3.5",
                                    matchRefresh.isPending && matchRefresh.variables === m.id && "animate-spin",
                                  )}
                                />
                                {matchRefresh.isPending && matchRefresh.variables === m.id ? "更新中" : "刷新此場"}
                              </Button>
                              {matchRefreshFeedback?.matchId === m.id ? (
                                <p
                                  className={cn(
                                    "basis-full text-xs",
                                    matchRefreshFeedback.ok ? "text-positive" : "text-negative",
                                  )}
                                  role="status"
                                  data-testid={`status-refresh-match-${m.id}`}
                                >
                                  {matchRefreshFeedback.message}
                                </p>
                              ) : null}
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <div>
                                <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                  鎖利 / 期望值
                                </h3>
                                {l.arb ? (
                                  <div className="space-y-0.5 text-[11px]" data-testid={`detail-arb-${rowKey}`}>
                                    <p className="text-positive">
                                      總機率 {fmtPct(l.arb.q)} · 保證利潤 HK${fmtMoney(l.arb.profit)} · ROI {fmtPct(l.arb.roi)}
                                    </p>
                                    {l.arb.legs.map((leg, i) => (
                                      <p key={i} className="tnum text-muted-foreground">
                                        {leg.label} {SELECTION_LABEL[leg.selection]} {leg.lineDisplay} @ {fmtOdds(leg.decimalOdds)} ·
                                        HK${fmtMoney(leg.stake)}
                                      </p>
                                    ))}
                                    <p className="tnum text-muted-foreground">
                                      總投入 HK${fmtMoney(l.arb.totalStake)} · 派彩 HK${fmtMoney(l.arb.payout)}
                                    </p>
                                  </div>
                                ) : (
                                  <p className="text-[11px] text-muted-foreground">此盤路暫無鎖利（總機率未低於 100%）。</p>
                                )}
                                {l.ev?.length ? (
                                  <div className="mt-1 space-y-0.5 text-[11px]" data-testid={`detail-ev-${rowKey}`}>
                                    {l.ev.map((e) => (
                                      <div key={e.key} className="flex flex-wrap items-center gap-1">
                                        <ExecutionRouteBadge
                                          route={executionRouteFromEv(e)}
                                          testId={`badge-execution-${e.key}`}
                                        />
                                        <p className="tnum text-hkjc">
                                          {SELECTION_LABEL[e.selection]} EV {fmtPct(e.edge)} · 馬會 @ {fmtOdds(e.hkjcOdds)} · 公道價{" "}
                                          {fmtOdds(e.fairOdds)}
                                          {e.flags.length ? <span className="ml-1 text-negative">⚠ {e.flags.join(",")}</span> : null}
                                        </p>
                                      </div>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                              {showSynthetic ? (
                                <div>
                                  <h3 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                    合成賠率（純數學，馬會主客和砌成）
                                  </h3>
                                  {m.synthetics.length ? (
                                    <div className="space-y-0.5 text-[11px]" data-testid={`detail-synthetic-${m.id}`}>
                                      {m.synthetics.map((s) => (
                                        <p key={s.key} className={cn("tnum", s.isArb ? "text-positive" : "text-muted-foreground")}>
                                          {s.side === "away" ? "客" : "主"}受讓 {s.lineDisplay} 合成 {fmtOdds(s.syntheticOdds)} · 皇冠對立{" "}
                                          {fmtOdds(s.crownOdds)} · 總機率 {fmtPct(s.q)}
                                          {s.isArb ? " · 鎖利" : " · 溢價（唔落飛）"}
                                        </p>
                                      ))}
                                      <p className="text-[10px] text-muted-foreground/80">{m.synthetics[0]?.formula}</p>
                                    </div>
                                  ) : (
                                    <p className="text-[11px] text-muted-foreground">
                                      未能砌出合成盤（需要馬會主客和，以及皇冠同盤路的對立單注）。
                                    </p>
                                  )}
                                </div>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </>
                  );
                }),
              )}
            </tbody>
            </table>
          </>
        )}
      </main>

      <footer className="shrink-0 border-t border-border bg-card px-3 py-1.5 text-[10px] text-muted-foreground">
        <span className="mr-3">
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-hkjc align-middle" />
          馬會賠率
        </span>
        <span className="mr-3">
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-pinnacle align-middle" />
          平博賠率
        </span>
        <span className="mr-3">
          <span className="mr-1 inline-block h-2 w-2 rounded-full bg-positive align-middle" />
          鎖利（總機率 &lt; 100%）
        </span>
        <span>
          只做賽前盤 · Pinnacle 無抽水機率只作 EV 基準 · 鎖利及合成鎖利使用皇冠盤，皇冠一邊固定 HK$5,000、馬會一邊反推
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-2 h-5 px-1 text-[10px]"
          onClick={() => navigate("/simulations")}
          data-testid="button-goto-simulations"
        >
          查看模擬投注紀錄
        </Button>
      </footer>
    </div>
  );
}
