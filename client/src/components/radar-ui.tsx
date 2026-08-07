import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Moon, Radar, RefreshCw, Sun, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { ScanOutcome, StatusResponse } from "@shared/types";

/* --------------------------------- theme --------------------------------- */

type Theme = "light" | "dark";
const ThemeCtx = createContext<{ theme: Theme; toggle: () => void }>({ theme: "dark", toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark",
  );
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  const value = useMemo(() => ({ theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) }), [theme]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function ThemeToggle() {
  const { theme, toggle } = useContext(ThemeCtx);
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={theme === "dark" ? "切換至淺色模式" : "切換至深色模式"}
      data-testid="button-theme-toggle"
    >
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

/* --------------------------------- logo ---------------------------------- */

export function RadarLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 40" fill="none" aria-label="盤路雷達標誌" role="img" className={cn("h-8 w-8", className)}>
      <circle cx="20" cy="20" r="14" stroke="currentColor" strokeWidth="1.5" opacity="0.9" />
      <circle cx="20" cy="20" r="8.5" stroke="currentColor" strokeWidth="1.1" opacity="0.45" />
      <circle cx="20" cy="20" r="3" stroke="currentColor" strokeWidth="1.1" opacity="0.35" />
      <path d="M20 20 L33 11" stroke="hsl(var(--hkjc))" strokeWidth="2" strokeLinecap="round" />
      <path d="M6 20 H12" stroke="currentColor" strokeWidth="1.2" opacity="0.5" />
      <path d="M28 20 H34" stroke="currentColor" strokeWidth="1.2" opacity="0.5" />
      <circle cx="20" cy="20" r="1.9" fill="hsl(var(--pinnacle))" />
      <circle cx="29.5" cy="27" r="2" fill="hsl(var(--positive))" />
    </svg>
  );
}

/* --------------------------------- banners ------------------------------- */

export function ColdStartBanner({ stage }: { stage: StatusResponse["coldStartStage"] }) {  // eslint-disable-line
  return (
    <div
      className="flex items-start gap-2 border-b border-warning/40 bg-warning/15 px-3 py-2 text-xs text-foreground"
      data-testid="banner-cold-start"
      role="status"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
      <span>
        <strong className="font-semibold">首次載入中</strong>
        ：正在讀取馬會賽前賠率、Pinnacle EV 基準及皇冠鎖利盤
        {stage === "quick" ? "（輕量模式，不會逐場拉取賠率明細）" : ""}。 平博賠率明細只會在開賽前 30
        分鐘的密集掃描視窗內抓取，或由你按「更新」手動觸發；皇冠盤亦會在同一輪讀取。
      </span>
    </div>
  );
}

export function ErrorBanner({ reason }: { reason: string }) {
  return (
    <div
      className="flex items-start gap-2 border-b border-destructive/50 bg-destructive/15 px-3 py-2 text-xs text-foreground"
      data-testid="banner-connection-error"
      role="alert"
    >
      <WifiOff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
      <span>{reason}</span>
    </div>
  );
}

export function DemoBanner() {
  return (
    <div
      className="border-b border-synthetic/50 bg-synthetic/15 px-3 py-2 text-xs font-semibold text-foreground"
      data-testid="banner-demo"
      role="alert"
    >
      DEMO 示範資料模式 — 畫面上的賠率並非真實市場價格，僅供介面開發驗證。
    </div>
  );
}

/* ----------------------------------- KPI --------------------------------- */

export function Kpi({
  label,
  value,
  tone,
  testId,
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: "hkjc" | "pinnacle" | "positive" | "synthetic" | "muted";
  testId: string;
  hint?: string;
}) {
  const toneClass =
    tone === "positive"
      ? "text-positive"
      : tone === "pinnacle"
        ? "text-pinnacle"
        : tone === "hkjc"
          ? "text-hkjc"
          : tone === "synthetic"
            ? "text-synthetic"
            : "text-foreground";
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3 py-1.5" title={hint}>
      <span className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={cn("tnum text-base font-semibold leading-none", toneClass)} data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

export function RefreshButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <Button size="sm" variant="outline" onClick={onClick} disabled={busy} data-testid="button-refresh" className="gap-1.5">
      <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
      <span className="hidden sm:inline">{busy ? "更新中" : "更新"}</span>
    </Button>
  );
}

export function StatusPill({ status }: { status: StatusResponse | undefined }) {
  if (!status) return <Skeleton className="h-5 w-16" data-testid="skeleton-status" />;
  const map = {
    live: { label: "即時", cls: "bg-positive/15 text-positive border-positive/30" },
    degraded: { label: "降級", cls: "bg-destructive/15 text-negative border-destructive/40" },
    demo: { label: "DEMO", cls: "bg-synthetic/15 text-synthetic border-synthetic/40" },
  } as const;
  const m = map[status.mode];
  return (
    <span
      className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide", m.cls)}
      data-testid="status-mode"
    >
      {m.label}
    </span>
  );
}

/* ------------------------------- primitives ------------------------------ */

export function EmptyState({ title, hint, testId }: { title: string; hint?: string; testId: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-14 text-center" data-testid={testId}>
      <p className="text-sm text-muted-foreground">{title}</p>
      {hint ? <p className="max-w-md text-xs text-muted-foreground/80">{hint}</p> : null}
    </div>
  );
}

export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-1.5 p-3" data-testid="skeleton-table">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

export function fmtOdds(n: number | undefined | null): string {
  return n === undefined || n === null ? "—" : n.toFixed(2);
}

export function fmtMoney(n: number | undefined | null): string {
  if (n === undefined || n === null) return "—";
  return n.toLocaleString("en-HK", { maximumFractionDigits: 0 });
}

export function fmtPct(n: number | undefined | null, digits = 2): string {
  if (n === undefined || n === null) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleTimeString("zh-HK", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function fmtKickoff(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString("zh-HK", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function ageLabel(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

/** Tiny inline sparkline for price history. */
export function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <span className="text-[10px] text-muted-foreground">—</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * 56},${16 - ((v - min) / span) * 14 - 1}`)
    .join(" ");
  return (
    <svg viewBox="0 0 56 16" className="h-4 w-14" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.2" />
    </svg>
  );
}

/* --------------------------- source / scan status ------------------------- */

const STRATEGY_LABEL: Record<string, string> = {
  "official-api": "官方 API（已授權帳戶）",
  titan007: "titan007 公開賠率頁（免憑證）",
  "opticodds-primary": "OpticOdds 主來源 · titan007 後備補漏",
};

export function SourceBar({ status }: { status: StatusResponse | undefined }) {
  if (!status) return null;
  const src = status.pinnacleSource;
  const scan = status.scan;
  const rowNote =
    src.strategy === "titan007"
      ? src.lastRowMatchedBy === "name"
        ? `以書商名稱比對成功${src.lastRowCompanyId ? `（列 ${src.lastRowCompanyId}）` : ""}`
        : src.lastRowMatchedBy === "id-hint"
          ? `名稱未命中，改用設定的列編號${src.lastRowCompanyId ? ` ${src.lastRowCompanyId}` : ""}`
          : "本次啟動尚未讀取賠率明細（視窗外不會輪詢）"
      : "";
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground"
      data-testid="bar-source-status"
    >
      <span data-testid="text-pinnacle-strategy">
        <span className="mr-1 font-semibold text-pinnacle">EV：Pinnacle</span>
        無水概率基準 · 馬會直接盤／合成盤擇最高 · {STRATEGY_LABEL[src.strategy] ?? src.strategy}
        {rowNote ? ` · ${rowNote}` : ""}
        {src.strategy === "opticodds-primary" ? "" : src.officialConfigured ? "" : " · 未設定官方憑證（公開 API 於 2025-07-23 起關閉）"}
      </span>
      <span data-testid="text-crown-strategy">
        <span className="mr-1 font-semibold text-positive">鎖利：皇冠</span>
        titan007 皇冠盤 · 皇冠注碼固定 HK$5,000
      </span>
      <span data-testid="text-scan-policy">
        <span className="mr-1 font-semibold">自動掃描</span>
        只在開賽前 {scan.windowMinutes} 分鐘內密集掃描 · 間隔 {scan.intervalSec} 秒 · 單次上限 {scan.maxRuntimeSec} 秒
        {scan.scheduleConfigured ? " · 賽前 30 分鐘自動觸發" : " · 密集掃描只限手動觸發"}
      </span>
      {src.warnings.length ? (
        <span className="text-warning" data-testid="text-source-warning">
          ⚠ {src.warnings[src.warnings.length - 1]}
        </span>
      ) : null}
    </div>
  );
}

const SCAN_RESULT_LABEL: Record<string, string> = {
  NO_WINDOW: "視窗內無賽事",
  NO_ALERT: "已掃描 · 無新機會",
  ALERT: "發現新機會",
  ERROR: "掃描失敗",
};

export function ScanButton({
  onClick,
  busy,
  last,
}: {
  onClick: () => void;
  busy: boolean;
  last: ScanOutcome | null;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="sm"
        variant="secondary"
        onClick={onClick}
        disabled={busy}
        className="gap-1.5"
        data-testid="button-window-scan"
      >
        <Radar className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
        <span className="hidden sm:inline">{busy ? "掃描中" : "密集掃描"}</span>
      </Button>
      {last ? (
        <span className="tnum hidden text-[10px] text-muted-foreground md:inline" data-testid="text-last-scan">
          {SCAN_RESULT_LABEL[last.result] ?? last.result} · {fmtTime(last.finishedAt)}
        </span>
      ) : null}
    </div>
  );
}
