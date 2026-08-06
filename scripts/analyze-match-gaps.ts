import { db, matchMapping, matches } from "../server/lib/store";
import {
  KICKOFF_TOLERANCE_MS,
  leagueSimilarity,
  scoreCandidate,
  similarity,
  type CandidateEvent,
} from "../server/lib/matching";
import { PinnacleProvider } from "../server/providers/pinnacle";

const provider = new PinnacleProvider();
const fixtures = await provider.fetchFixtures([0, 1, 2, 3, 4]);
const targetReason =
  process.env.MATCH_GAP_REASON ?? "team_name_similarity_below_floor";
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
  .filter((m) => reasons.get(m.id) === targetReason);

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
  const nearestByIdentity = candidates
    .map((c) => {
      const homeScore = similarity(m.homeTeam, c.homeTeam);
      const awayScore = similarity(m.awayTeam, c.awayTeam);
      const leagueScore = leagueSimilarity(m.league, c.league);
      const identityScore = 0.425 * homeScore + 0.425 * awayScore + 0.15 * leagueScore;
      return {
        ...c,
        deltaMin: Math.round((c.kickoffUtc - m.kickoffUtc) / 60_000),
        homeScore,
        awayScore,
        leagueScore,
        identityScore,
      };
    })
    .filter((c) => c.homeScore >= 0.35 || c.awayScore >= 0.35)
    .sort((a, b) => b.identityScore - a.identityScore)
    .slice(0, 5);
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
    nearestByIdentity,
  };
});

console.log(JSON.stringify(rows, null, 2));
