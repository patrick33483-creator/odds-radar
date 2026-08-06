import { db, matchMapping, matches } from "../server/lib/store";
import {
  KICKOFF_TOLERANCE_MS,
  scoreCandidate,
  type CandidateEvent,
} from "../server/lib/matching";
import { PinnacleProvider } from "../server/providers/pinnacle";

const provider = new PinnacleProvider();
const fixtures = await provider.fetchFixtures([0, 1, 2]);
const candidates: CandidateEvent[] = fixtures.map((f) => ({
  id: f.providerMatchId,
  league: f.league,
  homeTeam: f.homeTeam,
  awayTeam: f.awayTeam,
  kickoffUtc: f.kickoffUtc,
}));

const reasons = new Map(
  db.select().from(matchMapping).all().map((r) => [r.matchId, r.unmatchedReason]),
);
const gaps = db
  .select()
  .from(matches)
  .all()
  .filter((m) => reasons.get(m.id) === "team_name_similarity_below_floor");

const rows = gaps.map((m) => {
  const target = {
    id: m.id,
    league: m.league,
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    kickoffUtc: m.kickoffUtc,
  };
  const near = candidates
    .filter((c) => Math.abs(c.kickoffUtc - m.kickoffUtc) <= KICKOFF_TOLERANCE_MS)
    .map((c) => ({ c, score: scoreCandidate(target, c) }))
    .sort((a, b) => b.score.score - a.score.score)
    .slice(0, 4);
  return {
    hkjc: {
      id: m.id,
      league: m.league,
      home: m.homeTeam,
      away: m.awayTeam,
      homeEn: m.homeTeamEn,
      awayEn: m.awayTeamEn,
      kickoffUtc: m.kickoffUtc,
    },
    candidates: near.map(({ c, score }) => ({
      ...c,
      deltaSec: Math.round((c.kickoffUtc - m.kickoffUtc) / 1000),
      ...score,
    })),
  };
});

console.log(JSON.stringify(rows, null, 2));
