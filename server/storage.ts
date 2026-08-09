import {
  db,
  desc,
  eq,
  and,
  oddsSnapshots,
  opportunities,
  simulationBets,
  simulationLegs,
} from "./lib/store";
import type { Opportunity, SimulationBet, SimulationLeg } from "@shared/schema";

export interface IStorage {
  listSimulations(): Array<{ bet: SimulationBet; legs: SimulationLeg[] }>;
  listOpportunities(): Opportunity[];
  priceHistory(
    matchId: string,
    market: string,
    lineKey: string,
  ): Array<{ provider: string; selection: string; decimalOdds: number; fetchedAt: number }>;
}

export class DatabaseStorage implements IStorage {
  listSimulations() {
    const bets = db
      .select()
      .from(simulationBets)
      .where(eq(simulationBets.excludedFromStats, 0))
      .orderBy(desc(simulationBets.placedAt))
      .all();
    const legs = db.select().from(simulationLegs).all();
    return bets.map((bet) => ({ bet, legs: legs.filter((l) => l.betId === bet.id) }));
  }

  listOpportunities() {
    return db.select().from(opportunities).orderBy(desc(opportunities.lastSeen)).all();
  }

  priceHistory(matchId: string, market: string, lineKey: string) {
    const where = market
      ? and(
          eq(oddsSnapshots.matchId, matchId),
          eq(oddsSnapshots.market, market),
          eq(oddsSnapshots.lineKey, lineKey),
        )
      : eq(oddsSnapshots.matchId, matchId);
    return db
      .select({
        provider: oddsSnapshots.provider,
        selection: oddsSnapshots.selection,
        decimalOdds: oddsSnapshots.decimalOdds,
        fetchedAt: oddsSnapshots.fetchedAt,
      })
      .from(oddsSnapshots)
      .where(where)
      .orderBy(oddsSnapshots.fetchedAt)
      .all()
      .slice(-400);
  }
}

export const storage = new DatabaseStorage();
export { db };
