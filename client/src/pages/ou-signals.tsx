import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, BellRing, Clock3, Database, Radio, ShieldAlert } from "lucide-react";
import { EmptyState, RadarLogo, TableSkeleton, ThemeToggle, fmtKickoff, fmtTime } from "@/components/radar-ui";
import { cn } from "@/lib/utils";
import type {
  OuSignalDatasetResponse,
  OuSignalMatchStatus,
  OuSignalObservation,
} from "@shared/types";

type View = "active" | "all" | "completed";

const STATUS_LABEL: Record<OuSignalMatchStatus, string> = {
  upcoming: "未開賽",
  live: "進行中",
  completed: "已完場",
  awaiting_result: "待賽果",
};

function statusTone(status: OuSignalMatchStatus): string {
  if (status === "live") return "border-negative/30 bg-negative/10 text-negative";
  if (status === "upcoming") return "border-pinnacle/30 bg-pinnacle/10 text-pinnacle";
  if (status === "completed") return "border-positive/30 bg-positive/10 text-positive";
  return "border-warning/30 bg-warning/10 text-warning";
}

function resultLabel(row: OuSignalObservation): string {
  if (!row.result) return "未有賽果";
  if (row.result.outcome === "hit") return `中 · ${row.result.homeScore}–${row.result.awayScore}`;
  if (row.result.outcome === "miss") return `失 · ${row.result.homeScore}–${row.result.awayScore}`;
  return `走 · ${row.result.homeScore}–${row.result.awayScore}`;
}

function resultTone(row: OuSignalObservation): string {
  if (!row.result) return "text-muted-foreground";
  if (row.result.outcome === "hit") return "text-positive";
  if (row.result.outcome === "miss") return "text-negative";
  return "text-warning";
}

function SignalRow({ row, activatedAt }: { row: OuSignalObservation; activatedAt: number }) {
  const buy = row.signalSelection === "O" ? "大" : "小";
  return (
    <article className="rounded-md border border-border bg-card p-3 shadow-sm" data-testid={`ou-signal-${row.uniqueKey}`}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn("rounded border px-1.5 py-0.5 text-[10px] font-medium", statusTone(row.matchStatus))}>
              {STATUS_LABEL[row.matchStatus]}
            </span>
            <span className="text-[10px] text-muted-foreground">{row.providerLabel}</span>
            <span className={cn(
              "rounded border px-1.5 py-0.5 text-[10px]",
              row.mode === "direct"
                ? "border-positive/30 bg-positive/10 text-positive"
                : "border-warning/30 bg-warning/10 text-warning",
            )}>
              {row.mode === "direct" ? "正向" : "反向"}
            </span>
          </div>
          <h2 className="mt-1 truncate text-sm font-semibold">{row.homeTeam} vs {row.awayTeam}</h2>
          <p className="text-[10px] text-muted-foreground">{row.league} · {fmtKickoff(row.kickoffUtc)}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-muted-foreground">留意買入</p>
          <p className="tnum text-xl font-semibold text-hkjc">{buy} {row.lineKey}</p>
          <p className="tnum text-xs font-semibold">T-5 {row.signalT5Odds.toFixed(3)}</p>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-grid pt-2 text-xs sm:grid-cols-4">
        <div>
          <p className="text-[10px] text-muted-foreground">三段方向</p>
          <p className="tnum font-semibold">{row.directionPath.replaceAll("O", "大").replaceAll("U", "小")}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">判定邊初盤 → T-5</p>
          <p className="tnum font-semibold">{row.originalSelection === "O" ? "大" : "小"} {row.referenceInitialOdds.toFixed(3)} → {row.referenceT5Odds.toFixed(3)}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">變化</p>
          <p className="tnum font-semibold">{row.driftBucket} ({row.oddsGap >= 0 ? "+" : ""}{row.oddsGap.toFixed(3)})</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground">賽果</p>
          <p className={cn("tnum font-semibold", resultTone(row))}>{resultLabel(row)}</p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><Clock3 className="h-3 w-3" />符合於 {fmtTime(row.detectedAt)}</span>
        <span className="flex items-center gap-1">
          <BellRing className="h-3 w-3" />
          {row.notifiedAt
            ? `TG 已通知 ${fmtTime(row.notifiedAt)}`
            : row.detectedAt < activatedAt
              ? "歷史回填／不補發"
              : "TG 未發／等待重試"}
        </span>
        {row.mode === "reverse" ? (
          <span className="flex items-center gap-1 text-warning">
            <ShieldAlert className="h-3 w-3" />原方向負 edge 推導，反向 edge 未獨立證實
          </span>
        ) : null}
      </div>
    </article>
  );
}

export default function OuSignals() {
  const [view, setView] = useState<View>("active");
  const [ruleId, setRuleId] = useState("all");
  const { data, isLoading, isError } = useQuery<OuSignalDatasetResponse>({
    queryKey: ["/api/ou-signals"],
    refetchInterval: 20_000,
  });

  const observations = useMemo(() => (data?.observations ?? []).filter((row) => {
    if (ruleId !== "all" && row.ruleId !== ruleId) return false;
    if (view === "active") return row.matchStatus === "upcoming" || row.matchStatus === "live";
    if (view === "completed") return row.matchStatus === "completed" || row.matchStatus === "awaiting_result";
    return true;
  }), [data, ruleId, view]);
  const activeCount = (data?.observations ?? []).filter((row) =>
    row.matchStatus === "upcoming" || row.matchStatus === "live",
  ).length;
  const prospectiveSettled = (data?.summaries ?? []).reduce((sum, item) => sum + item.settled, 0);

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 shrink-0 border-b border-border bg-card/95 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <RadarLogo className="h-7 w-7 text-pinnacle" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold" data-testid="text-page-title">OU 買入訊號</h1>
            <p className="truncate text-[10px] text-muted-foreground">五組鎖定規則 · 未開賽／進行中即時顯示 · 新訊號 TG 防重通知</p>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Link href="/" className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover-elevate" data-testid="link-tab-dashboard">
              <ArrowLeft className="h-3 w-3" />賠率對比
            </Link>
            <Link href="/research" className="hidden items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover-elevate sm:flex" data-testid="link-tab-research">
              <Database className="h-3 w-3" />研究數據
            </Link>
            <ThemeToggle />
          </div>
        </div>

        <div className="grid grid-cols-3 divide-x divide-border border-t border-border">
          <div className="px-3 py-2"><p className="text-[10px] text-muted-foreground">目前可留意</p><p className="tnum text-lg font-semibold text-hkjc" data-testid="kpi-ou-active">{data ? activeCount : "—"}</p></div>
          <div className="px-3 py-2"><p className="text-[10px] text-muted-foreground">累積訊號</p><p className="tnum text-lg font-semibold" data-testid="kpi-ou-total">{data ? data.observations.length : "—"}</p></div>
          <div className="px-3 py-2"><p className="text-[10px] text-muted-foreground">已有賽果</p><p className="tnum text-lg font-semibold text-positive" data-testid="kpi-ou-settled">{data ? prospectiveSettled : "—"}</p></div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
          {(["active", "all", "completed"] as View[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setView(item)}
              className={cn(
                "min-h-8 rounded px-2.5 text-xs",
                view === item ? "bg-secondary font-medium" : "text-muted-foreground hover-elevate",
              )}
              data-testid={`filter-ou-${item}`}
            >
              {item === "active" ? "未開賽／進行中" : item === "all" ? "全部累積" : "已完場／待賽果"}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-border" />
          <button
            type="button"
            onClick={() => setRuleId("all")}
            className={cn("min-h-8 rounded px-2 text-xs", ruleId === "all" ? "bg-secondary font-medium" : "text-muted-foreground hover-elevate")}
          >
            五組規則
          </button>
          {(data?.summaries ?? []).map((summary, index) => (
            <button
              key={summary.rule.id}
              type="button"
              onClick={() => setRuleId(summary.rule.id)}
              className={cn(
                "min-h-8 rounded px-2 text-xs",
                ruleId === summary.rule.id ? "bg-secondary font-medium" : "text-muted-foreground hover-elevate",
              )}
              title={summary.rule.historicalNote}
            >
              #{index + 1} {summary.rule.directionPath.replaceAll("O", "大").replaceAll("U", "小")} → {summary.rule.signalSelection === "O" ? "大" : "小"}
            </button>
          ))}
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-3 p-2 sm:p-3">
        <section aria-labelledby="rules-heading">
          <div className="mb-2 flex items-center gap-2">
            <Radio className="h-4 w-4 text-pinnacle" />
            <h2 id="rules-heading" className="text-sm font-semibold">監察條件</h2>
            <span className="text-[10px] text-muted-foreground">所有方向都用初盤、T-30、T-5 同一條線；三段低水方賠率均須 &gt; 1.70</span>
          </div>
          <div className="flex snap-x gap-2 overflow-x-auto pb-2 md:grid md:grid-cols-2 md:overflow-visible md:pb-0">
            {(data?.summaries ?? []).map((summary, index) => (
              <button
                key={summary.rule.id}
                type="button"
                onClick={() => setRuleId(ruleId === summary.rule.id ? "all" : summary.rule.id)}
                className={cn(
                  "w-[82vw] max-w-[320px] shrink-0 snap-start rounded-md border bg-card p-3 text-left shadow-sm transition-colors md:w-auto md:max-w-none md:shrink",
                  ruleId === summary.rule.id ? "border-pinnacle" : "border-border hover:border-pinnacle/40",
                  index === 0 && "md:col-span-2",
                )}
                data-testid={`ou-rule-${summary.rule.id}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold">
                    {summary.rule.providerLabel} · {summary.rule.directionPath.replaceAll("O", "大").replaceAll("U", "小")} · {summary.rule.driftBucket}
                  </span>
                  <span className={cn("rounded px-1.5 py-0.5 text-[10px]", summary.rule.mode === "direct" ? "bg-positive/10 text-positive" : "bg-warning/10 text-warning")}>
                    {summary.rule.mode === "direct" ? `揸${summary.rule.signalSelection === "O" ? "大" : "小"}` : `反向揸${summary.rule.signalSelection === "O" ? "大" : "小"}`}
                  </span>
                </div>
                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">{summary.rule.historicalNote}</p>
                <p className="tnum mt-2 text-[10px]">
                  新累積 {summary.observations} · 已判定 {summary.hits + summary.misses}
                  {summary.prospectiveHitRate !== null ? ` · 前瞻命中 ${(summary.prospectiveHitRate * 100).toFixed(1)}%` : " · 前瞻命中率待累積"}
                </p>
              </button>
            ))}
          </div>
        </section>

        <section aria-labelledby="matches-heading">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 id="matches-heading" className="text-sm font-semibold">符合場次</h2>
            <span className="tnum text-[10px] text-muted-foreground">更新於 {fmtTime(data?.generatedAt)}</span>
          </div>
          <div className="space-y-2">
            {isLoading ? <TableSkeleton rows={6} /> : isError ? (
              <EmptyState title="讀取不到 OU 訊號" hint="請確認後端服務正在運行。" testId="error-ou-signals" />
            ) : observations.length === 0 ? (
              <EmptyState
                title={view === "active" ? "暫時未有未開賽或進行中訊號" : "呢個篩選暫時未有訊號"}
                hint="系統會繼續收集初盤、T-30、T-5；新場次首次符合五組規則之一就會寫入呢頁並發 Telegram。"
                testId="empty-ou-signals"
              />
            ) : observations.map((row) => (
              <SignalRow key={row.uniqueKey} row={row} activatedAt={data?.activatedAt ?? 0} />
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
