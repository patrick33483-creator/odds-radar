import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  EmptyState,
  RadarLogo,
  TableSkeleton,
  ThemeToggle,
  fmtKickoff,
  fmtMoney,
  fmtOdds,
  fmtPct,
  fmtTime,
} from "@/components/radar-ui";
import { CATEGORY_LABEL, SELECTION_LABEL, type SimulationsResponse } from "@shared/types";

const CATS = ["all", "case1_arb", "case2_ev", "synth_arb"] as const;
type Cat = (typeof CATS)[number];

const STATUS_LABEL: Record<string, string> = {
  win: "中",
  half_win: "半中",
  push: "走盤",
  half_loss: "半輸",
  loss: "輸",
  mixed: "混合",
};

export default function Simulations() {
  const [tab, setTab] = useState<Cat>("all");
  const { data, isLoading, isError } = useQuery<SimulationsResponse>({
    queryKey: ["/api/simulations"],
    refetchInterval: 20_000,
  });

  const settle = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/simulations/settle");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/simulations"] }),
  });

  const clear = useMutation({
    mutationFn: async (category: string) => {
      await apiRequest("POST", "/api/simulations/clear", { category });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/simulations"] }),
  });

  const bets = useMemo(
    () => (data?.bets ?? []).filter((b) => (tab === "all" ? true : b.category === tab)),
    [data, tab],
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="shrink-0 border-b border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <RadarLogo className="h-7 w-7 text-pinnacle" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold leading-tight" data-testid="text-page-title">
              模擬投注紀錄
            </h1>
            <p className="truncate text-[10px] text-muted-foreground">
              情況一 平博固定 $5,000 · 情況二 馬會固定 $10,000（EV ≥ 3%）· 合成賠率 平博固定 $5,000
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
            <ThemeToggle />
            <Button size="sm" variant="outline" onClick={() => settle.mutate()} disabled={settle.isPending} data-testid="button-settle">
              {settle.isPending ? "結算中" : "即刻結算"}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="destructive" className="gap-1" data-testid="button-clear">
                  <Trash2 className="h-3.5 w-3.5" />
                  清空
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent data-testid="dialog-clear-confirm">
                <AlertDialogHeader>
                  <AlertDialogTitle>確認清空模擬投注紀錄？</AlertDialogTitle>
                  <AlertDialogDescription>
                    將會刪除
                    {tab === "all" ? "全部類別" : CATEGORY_LABEL[tab]}
                    的模擬注單及所有逐腳紀錄，此動作無法還原。清空後同一場、同一個項目可以再次落飛。
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel data-testid="button-clear-cancel">取消</AlertDialogCancel>
                  <AlertDialogAction onClick={() => clear.mutate(tab)} data-testid="button-clear-confirm">
                    確認清空
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {/* summary cards */}
        <div className="grid gap-2 border-t border-border p-3 sm:grid-cols-3">
          {(data?.summaries ?? []).map((s) => (
            <div key={s.category} className="rounded-md border border-card-border bg-card p-2.5" data-testid={`card-summary-${s.category}`}>
              <p className="text-[11px] font-semibold">{CATEGORY_LABEL[s.category]}</p>
              <p className="tnum mt-1 text-lg font-semibold leading-none">{s.count}<span className="ml-1 text-[10px] font-normal text-muted-foreground">注</span></p>
              <dl className="tnum mt-1.5 space-y-0.5 text-[10px] text-muted-foreground">
                <div className="flex justify-between">
                  <dt>總投入</dt>
                  <dd>HK${fmtMoney(s.totalStake)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>{s.category === "case2_ev" ? "期望盈利" : "穩賺"}</dt>
                  <dd className={cn(s.expectedProfit >= 0 ? "text-positive" : "text-negative")}>HK${fmtMoney(s.expectedProfit)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>回報率</dt>
                  <dd>{fmtPct(s.roi)}</dd>
                </div>
                <div className="flex justify-between border-t border-border pt-0.5">
                  <dt>已結算</dt>
                  <dd>
                    {s.settledCount} 注 · 命中 {s.hitCount}
                    {s.settledCount ? `（${fmtPct(s.hitCount / s.settledCount, 0)}）` : ""}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt>實際盈虧</dt>
                  <dd className={cn(s.realizedPnl >= 0 ? "text-positive" : "text-negative")}>HK${fmtMoney(s.realizedPnl)}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>

        {/* actual result totals */}
        {data ? (
          <div className="tnum flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground" data-testid="text-overall">
            <span>實際成績（已完場）</span>
            <span>已結算 {data.overall.settledCount} 注</span>
            <span>投入 HK${fmtMoney(data.overall.totalStake)}</span>
            <span className={cn(data.overall.realizedPnl >= 0 ? "text-positive" : "text-negative")}>
              實際盈虧 HK${fmtMoney(data.overall.realizedPnl)}
            </span>
            <span>實際回報率 {fmtPct(data.overall.realizedRoi)}</span>
            <span>命中率 {fmtPct(data.overall.hitRate, 0)}</span>
          </div>
        ) : null}

        <div className="flex gap-1 overflow-x-auto border-t border-border px-3 py-2" role="tablist">
          {CATS.map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={tab === c}
              onClick={() => setTab(c)}
              className={cn(
                "whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium transition-colors",
                tab === c ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover-elevate",
              )}
              data-testid={`button-cat-${c}`}
            >
              {c === "all" ? "全部" : CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <TableSkeleton rows={5} />
        ) : isError ? (
          <EmptyState title="讀取不到模擬紀錄" hint="請確認後端服務正在運行。" testId="error-simulations" />
        ) : bets.length === 0 ? (
          <EmptyState
            title="暫時未有模擬注單"
            hint="出現鎖利、EV ≥ 3% 或合成鎖利機會時，系統會自動落一次飛；同一場、同一個項目永遠只會買一次。"
            testId="empty-simulations"
          />
        ) : (
          <table className="w-full min-w-[820px] border-separate border-spacing-0 text-xs">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="border-b border-grid px-2 py-1.5 font-medium">落飛時間</th>
                <th className="border-b border-grid px-2 py-1.5 font-medium">類別</th>
                <th className="border-b border-grid px-2 py-1.5 font-medium">賽事</th>
                <th className="border-b border-grid px-2 py-1.5 font-medium">盤口</th>
                <th className="border-b border-grid px-2 py-1.5 font-medium">逐腳投注</th>
                <th className="border-b border-grid px-2 py-1.5 text-right font-medium">總投入</th>
                <th className="border-b border-grid px-2 py-1.5 text-right font-medium">派彩</th>
                <th className="border-b border-grid px-2 py-1.5 text-right font-medium">盈利 / EV</th>
                <th className="border-b border-grid px-2 py-1.5 text-right font-medium">賽果 / 實際</th>
              </tr>
            </thead>
            <tbody>
              {bets.map((b) => (
                <tr key={b.id} className="align-top hover:bg-accent/40" data-testid={`row-bet-${b.id}`}>
                  <td className="tnum border-b border-grid px-2 py-1.5 text-muted-foreground">{fmtTime(b.placedAt)}</td>
                  <td className="border-b border-grid px-2 py-1.5">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-medium",
                        b.category === "case1_arb" && "bg-positive/15 text-positive",
                        b.category === "case2_ev" && "bg-hkjc/10 text-hkjc",
                        b.category === "synth_arb" && "bg-synthetic/15 text-synthetic",
                      )}
                    >
                      {CATEGORY_LABEL[b.category]}
                    </span>
                  </td>
                  <td className="border-b border-grid px-2 py-1.5">
                    <span className="block max-w-[180px] truncate font-medium">{b.matchLabel}</span>
                    <span className="tnum block text-[10px] text-muted-foreground">
                      {b.league} · {fmtKickoff(b.kickoffUtc)}
                    </span>
                  </td>
                  <td className="tnum border-b border-grid px-2 py-1.5">{b.lineDisplay}</td>
                  <td className="border-b border-grid px-2 py-1.5">
                    <div className="space-y-0.5">
                      {b.legs.map((l) => (
                        <p key={l.id} className="tnum text-[10px]">
                          <span className={l.provider === "pinnacle" ? "text-pinnacle" : l.synthetic ? "text-synthetic" : "text-hkjc"}>
                            {l.provider === "pinnacle" ? "平博" : l.synthetic ? "馬會合成" : "馬會"}
                          </span>{" "}
                          {SELECTION_LABEL[l.selection]} {l.lineDisplay} @ {fmtOdds(l.decimalOdds)} · HK${fmtMoney(l.stake)}
                          {l.legStatus ? (
                            <span
                              className={cn(
                                "ml-1 rounded px-1 text-[9px]",
                                ["win", "half_win"].includes(l.legStatus) ? "bg-positive/15 text-positive" : "bg-destructive/15 text-negative",
                              )}
                            >
                              {STATUS_LABEL[l.legStatus] ?? l.legStatus}
                            </span>
                          ) : null}
                        </p>
                      ))}
                    </div>
                  </td>
                  <td className="tnum border-b border-grid px-2 py-1.5 text-right">HK${fmtMoney(b.totalStake)}</td>
                  <td className="tnum border-b border-grid px-2 py-1.5 text-right">HK${fmtMoney(b.expectedPayout)}</td>
                  <td className="tnum border-b border-grid px-2 py-1.5 text-right">
                    <span className={cn(b.expectedProfit >= 0 ? "text-positive" : "text-negative")}>
                      HK${fmtMoney(b.expectedProfit)}
                    </span>
                    <span className="block text-[10px] text-muted-foreground">
                      {b.category === "case2_ev" ? `EV ${fmtPct(b.evPct)}` : `ROI ${fmtPct(b.roi)}`}
                    </span>
                  </td>
                  <td className="tnum border-b border-grid px-2 py-1.5 text-right">
                    {b.settledAt ? (
                      <>
                        <span className="block">{b.finalScore}</span>
                        <span className={cn("block text-[10px]", (b.realizedPnl ?? 0) >= 0 ? "text-positive" : "text-negative")}>
                          HK${fmtMoney(b.realizedPnl)}
                        </span>
                      </>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">待開賽</span>
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
