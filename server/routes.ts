import type { Express } from "express";
import type { Server } from "node:http";
import { z } from "zod";
import { engine } from "./lib/engine";
import { createBackup, listBackups } from "./lib/backup";
import { storage } from "./storage";
import { formatLine } from "./lib/lines";
import type { Market, Selection, SimulationBetDto, SimulationSummary, SimulationsResponse } from "@shared/types";

const clearSchema = z.object({ category: z.enum(["case1_arb", "case2_ev", "synth_arb", "all"]) });

function buildSimulations(): SimulationsResponse {
  const rows = storage.listSimulations();
  const bets: SimulationBetDto[] = rows.map((r) => ({
    id: r.bet.id,
    uniqueKey: r.bet.uniqueKey,
    category: r.bet.category as SimulationBetDto["category"],
    matchId: r.bet.matchId,
    matchLabel: r.bet.matchLabel,
    league: r.bet.league,
    market: r.bet.market as Market,
    lineKey: r.bet.lineKey,
    lineDisplay: formatLine(r.bet.market as Market, r.bet.lineKey ? Number(r.bet.lineKey) : null),
    selection: r.bet.selection as Selection,
    kickoffUtc: r.bet.kickoffUtc,
    totalStake: r.bet.totalStake,
    expectedPayout: r.bet.expectedPayout,
    expectedProfit: r.bet.expectedProfit,
    roi: r.bet.roi,
    evPct: r.bet.evPct,
    qTotal: r.bet.qTotal,
    placedAt: r.bet.placedAt,
    settledAt: r.bet.settledAt,
    resultStatus: r.bet.resultStatus,
    realizedReturn: r.bet.realizedReturn,
    realizedPnl: r.bet.realizedPnl,
    finalScore: r.bet.finalScore,
    legs: r.legs.map((l) => ({
      id: l.id,
      provider: l.provider,
      market: l.market as Market,
      lineKey: l.lineKey,
      lineDisplay: formatLine(l.market as Market, l.lineKey ? Number(l.lineKey) : null),
      selection: l.selection as Selection,
      decimalOdds: l.decimalOdds,
      stake: l.stake,
      synthetic: !!l.synthetic,
      syntheticDetail: l.syntheticDetail,
      legStatus: l.legStatus,
      legReturn: l.legReturn,
    })),
  }));

  const cats: SimulationSummary["category"][] = ["case1_arb", "case2_ev", "synth_arb"];
  const summaries: SimulationSummary[] = cats.map((c) => {
    const list = bets.filter((b) => b.category === c);
    const settled = list.filter((b) => b.settledAt);
    const totalStake = list.reduce((a, b) => a + b.totalStake, 0);
    const expectedProfit = list.reduce((a, b) => a + b.expectedProfit, 0);
    const realizedPnl = settled.reduce((a, b) => a + (b.realizedPnl ?? 0), 0);
    const settledStake = settled.reduce((a, b) => a + b.totalStake, 0);
    return {
      category: c,
      count: list.length,
      totalStake: Math.round(totalStake * 100) / 100,
      expectedProfit: Math.round(expectedProfit * 100) / 100,
      roi: totalStake > 0 ? expectedProfit / totalStake : 0,
      settledCount: settled.length,
      hitCount: settled.filter((b) => (b.realizedPnl ?? 0) > 0).length,
      realizedPnl: Math.round(realizedPnl * 100) / 100,
      realizedRoi: settledStake > 0 ? realizedPnl / settledStake : 0,
    };
  });

  const settledAll = bets.filter((b) => b.settledAt);
  const settledStake = settledAll.reduce((a, b) => a + b.totalStake, 0);
  const realizedPnl = settledAll.reduce((a, b) => a + (b.realizedPnl ?? 0), 0);
  return {
    bets,
    summaries,
    overall: {
      settledCount: settledAll.length,
      totalStake: Math.round(settledStake * 100) / 100,
      realizedPnl: Math.round(realizedPnl * 100) / 100,
      realizedRoi: settledStake > 0 ? realizedPnl / settledStake : 0,
      hitRate: settledAll.length ? settledAll.filter((b) => (b.realizedPnl ?? 0) > 0).length / settledAll.length : 0,
    },
  };
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // Kick off the two-stage cold start without blocking the first request.
  void engine.refresh().catch(() => undefined);

  app.get("/api/status", (_req, res) => {
    const dash = engine.buildDashboardData();
    res.json(dash.status);
  });

  app.get("/api/dashboard", async (_req, res) => {
    // Opportunistic refresh, guarded by the 30 s throttle + single-flight mutex.
    void engine.refresh().catch(() => undefined);
    res.json(engine.buildDashboardData());
  });

  app.post("/api/refresh", async (_req, res) => {
    const r = await engine.refresh({ force: true });
    res.json({ ...r, status: engine.buildDashboardData().status });
  });

  app.get("/api/opportunities", (_req, res) => {
    res.json(storage.listOpportunities());
  });

  app.get("/api/simulations", (_req, res) => {
    res.json(buildSimulations());
  });

  app.post("/api/simulations/settle", async (_req, res) => {
    const result = await engine.settleDue(true);
    res.json({ ...result, simulations: buildSimulations() });
  });

  app.post("/api/simulations/clear", (req, res) => {
    const parsed = clearSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "invalid category" });
    const removed = engine.clearSimulations(parsed.data.category === "all" ? undefined : parsed.data.category);
    return res.json({ removed, simulations: buildSimulations() });
  });

  app.get("/api/backups", (_req, res) => {
    res.json({ backups: listBackups(), retain: 14 });
  });

  app.post("/api/backups", (_req, res) => {
    const info = createBackup();
    res.json({ created: info, backups: listBackups() });
  });

  app.get("/api/history", (req, res) => {
    const matchId = String(req.query.matchId ?? "");
    const market = String(req.query.market ?? "");
    const lineKey = String(req.query.lineKey ?? "");
    if (!matchId) return res.status(400).json({ message: "matchId required" });
    return res.json(storage.priceHistory(matchId, market, lineKey));
  });

  return httpServer;
}
