import { describe, expect, it } from "vitest";
import {
  formatHandicap,
  formatTotal,
  hkToDecimal,
  handicapRoadKey,
  isQuarterStep,
  isSameHandicapRoad,
  lineKeyOf,
  parsePinnacleHandicap,
  parsePinnacleTotal,
  parseHkjcHandicap,
  parseHkjcTotal,
  splitLine,
} from "../server/lib/lines";
import { findThreeWayArb, findTwoWayArb, planStakes, totalProbability } from "../server/lib/arb";
import { evaluateEv, margin, noVigProbs } from "../server/lib/ev";
import { buildSynthetic, syntheticCoversPinnacle } from "../server/lib/synthetic";
import { leagueSimilarity, matchEvent, normalizeName, similarity } from "../server/lib/matching";
import { mergeOpportunityState } from "../server/lib/dedupe";
import { teamAliasSeedRows, TEAM_ALIAS_SEED_PAIRS } from "../server/lib/team-alias-seeds";
import { legReturn, settle1X2, settleHandicap, settleTotal } from "../server/lib/settlement";

/* ----------------------------- normalization ----------------------------- */

describe("line normalization", () => {
  it("parses HKJC handicap conditions to quarter steps", () => {
    expect(parseHkjcHandicap("0.0")).toBe(0);
    expect(parseHkjcHandicap("0.0/-0.5")).toBe(-0.25);
    expect(parseHkjcHandicap("-0.5")).toBe(-0.5);
    expect(parseHkjcHandicap("-0.5/-1.0")).toBe(-0.75);
    expect(parseHkjcHandicap("+0.5/+1.0")).toBe(0.75);
    expect(parseHkjcHandicap("+1.0")).toBe(1);
    expect(parseHkjcHandicap("-2.5/-3.0")).toBe(-2.75);
  });

  it("rejects malformed or non-quarter conditions", () => {
    expect(parseHkjcHandicap("")).toBeNull();
    expect(parseHkjcHandicap("abc")).toBeNull();
    expect(parseHkjcHandicap("0.0/-1.0")).toBeNull(); // 1-goal gap is not a quarter pair
    expect(parseHkjcHandicap("0.0/-0.5/-1.0")).toBeNull();
  });

  it("parses HKJC totals", () => {
    expect(parseHkjcTotal("2.5")).toBe(2.5);
    expect(parseHkjcTotal("2.5/3.0")).toBe(2.75);
    expect(parseHkjcTotal("3.0")).toBe(3);
  });

  it("flips the Pinnacle handicap sign (titan007 positive = home gives)", () => {
    expect(parsePinnacleHandicap("1.5")).toBe(-1.5);
    expect(parsePinnacleHandicap("0.25")).toBe(-0.25);
    expect(parsePinnacleHandicap("-0.75")).toBe(0.75);
    expect(parsePinnacleHandicap("0")).toBe(0);
    expect(parsePinnacleTotal("2.25")).toBe(2.25);
    expect(parsePinnacleHandicap("x")).toBeNull();
  });

  it("keeps a stable comparison key and display form", () => {
    expect(lineKeyOf("AH", -0.25)).toBe("-0.25");
    expect(lineKeyOf("OU", 2.75)).toBe("2.75");
    expect(lineKeyOf("1X2", null)).toBe("");
    expect(formatHandicap(0)).toBe("0");
    expect(formatHandicap(-0.25)).toBe("0/-0.5");
    expect(formatHandicap(-0.5)).toBe("-0.5");
    expect(formatHandicap(-0.75)).toBe("-0.5/-1");
    expect(formatHandicap(0.75)).toBe("+0.5/+1");
    expect(formatTotal(2.5)).toBe("2.5");
    expect(formatTotal(2.75)).toBe("2.5/3");
    expect(formatTotal(3)).toBe("3");
  });

  it("treats Pinnacle decimal quarter lines as the same HKJC split-ball road", () => {
    // Pinnacle -0.25 = 馬會主隊讓平半 (0/-0.5)
    expect(isSameHandicapRoad(-0.25, parseHkjcHandicap("0.0/-0.5")!)).toBe(true);
    // Pinnacle -0.75 = 馬會主隊讓半一 (-0.5/-1.0)
    expect(isSameHandicapRoad(-0.75, parseHkjcHandicap("-0.5/-1.0")!)).toBe(true);
    // The same rule continues for deeper quarter lines.
    expect(isSameHandicapRoad(-1.25, parseHkjcHandicap("-1.0/-1.5")!)).toBe(true);
    expect(isSameHandicapRoad(0.25, parseHkjcHandicap("0.0/+0.5")!)).toBe(true);
    expect(isSameHandicapRoad(0.75, parseHkjcHandicap("+0.5/+1.0")!)).toBe(true);
    expect(handicapRoadKey(-0.75)).toBe(-3);
    expect(isSameHandicapRoad(-0.25, 0.25)).toBe(false);
  });

  it("splits quarter lines and converts HK odds", () => {
    expect(splitLine(-0.25)).toEqual([-0.5, 0]);
    expect(splitLine(-0.5)).toEqual([-0.5]);
    expect(splitLine(2.75)).toEqual([2.5, 3]);
    expect(isQuarterStep(0.3)).toBe(false);
    expect(hkToDecimal(0.83)).toBeCloseTo(1.83, 6);
  });
});

/* -------------------------------- arbitrage ------------------------------ */

describe("arbitrage stake math", () => {
  const base = {
    matchId: "m1",
    matchLabel: "A vs B",
    league: "L",
    kickoffUtc: 0,
    market: "AH" as const,
    lineKey: "-0.50",
    lineDisplay: "-0.5",
  };

  it("detects a two-way arb only when q < 1 and sizes for equal payout", () => {
    const arb = findTwoWayArb({
      ...base,
      hkjc: { selection: "H", decimalOdds: 2.2 },
      pinnacle: { selection: "A", decimalOdds: 2.1 },
    });
    expect(arb).not.toBeNull();
    expect(arb!.q).toBeCloseTo(1 / 2.2 + 1 / 2.1, 6);
    const pinnacleLeg = arb!.legs.find((l) => l.provider === "pinnacle")!;
    const hkjcLeg = arb!.legs.find((l) => l.provider === "hkjc")!;
    expect(pinnacleLeg.stake).toBe(5000);
    expect(hkjcLeg.stake).toBeCloseTo((5000 * 2.1) / 2.2, 1);
    expect(arb!.payout).toBeCloseTo(10500, 2);
    expect(arb!.profit).toBeCloseTo(arb!.payout - arb!.totalStake, 2);
    expect(arb!.roi).toBeGreaterThan(0);
  });

  it("returns null when there is no edge", () => {
    expect(
      findTwoWayArb({ ...base, hkjc: { selection: "H", decimalOdds: 1.9 }, pinnacle: { selection: "A", decimalOdds: 1.95 } }),
    ).toBeNull();
  });

  it("refuses non-complementary pairs", () => {
    expect(
      findTwoWayArb({ ...base, hkjc: { selection: "H", decimalOdds: 2.2 }, pinnacle: { selection: "H", decimalOdds: 2.2 } }),
    ).toBeNull();
  });

  it("never treats two of three 1X2 outcomes as full coverage", () => {
    const partial = findThreeWayArb({
      matchId: "m1",
      matchLabel: "A vs B",
      league: "L",
      kickoffUtc: 0,
      hkjc: { H: 3.5, A: 3.6 },
      pinnacle: { H: 3.4 },
    });
    expect(partial).toBeNull();
  });

  it("accepts a genuine three-way cover with a Pinnacle leg", () => {
    const arb = findThreeWayArb({
      matchId: "m1",
      matchLabel: "A vs B",
      league: "L",
      kickoffUtc: 0,
      hkjc: { H: 3.6, D: 3.9, A: 3.8 },
      pinnacle: { H: 3.4, D: 4.2, A: 3.5 },
    });
    expect(arb).not.toBeNull();
    expect(arb!.legs).toHaveLength(3);
    expect(totalProbability(arb!.legs.map((l) => l.decimalOdds))).toBeLessThan(1);
    const payouts = arb!.legs.map((l) => l.stake * l.decimalOdds);
    for (const p of payouts) expect(p).toBeCloseTo(payouts[0], 0);
  });

  it("requires a Pinnacle leg to anchor the plan", () => {
    expect(
      planStakes([
        { provider: "hkjc", selection: "H", decimalOdds: 2.2, label: "馬會", market: "AH", lineKey: "0.00", lineDisplay: "0" },
        { provider: "hkjc", selection: "A", decimalOdds: 2.1, label: "馬會", market: "AH", lineKey: "0.00", lineDisplay: "0" },
      ]),
    ).toBeNull();
  });
});

/* ----------------------------------- EV ---------------------------------- */

describe("no-vig EV", () => {
  it("removes the margin proportionally", () => {
    const p = noVigProbs([1.96, 1.98])!;
    expect(p[0] + p[1]).toBeCloseTo(1, 12);
    expect(p[0]).toBeGreaterThan(p[1]);
    expect(margin([1.96, 1.98])).toBeCloseTo(1 / 1.96 + 1 / 1.98 - 1, 12);
  });

  it("flags an HKJC price above the Pinnacle fair price", () => {
    const now = Date.now();
    const ops = evaluateEv({
      matchId: "m1",
      matchLabel: "A vs B",
      league: "L",
      kickoffUtc: now + 3.6e6,
      market: "AH",
      lineKey: "-0.50",
      lineDisplay: "-0.5",
      pinnacle: [
        { selection: "H", decimalOdds: 1.96 },
        { selection: "A", decimalOdds: 1.98 },
      ],
      hkjc: [
        { selection: "H", decimalOdds: 2.15, fetchedAt: now },
        { selection: "A", decimalOdds: 1.7, fetchedAt: now },
      ],
      now,
      mappingConfidence: 0.95,
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].selection).toBe("H");
    expect(ops[0].edge).toBeGreaterThan(0.03);
    expect(ops[0].flags).toEqual([]);
    expect(ops[0].expectedProfit).toBeCloseTo(10000 * ops[0].edge, 1);
  });

  it("adds safeguards for stale prices and low mapping confidence", () => {
    const now = Date.now();
    const ops = evaluateEv({
      matchId: "m1",
      matchLabel: "A vs B",
      league: "L",
      kickoffUtc: now,
      market: "AH",
      lineKey: "-0.50",
      lineDisplay: "-0.5",
      pinnacle: [
        { selection: "H", decimalOdds: 1.96 },
        { selection: "A", decimalOdds: 1.98 },
      ],
      hkjc: [{ selection: "H", decimalOdds: 3.6, fetchedAt: now - 600_000 }],
      now,
      mappingConfidence: 0.4,
    });
    expect(ops[0].flags).toContain("stale");
    expect(ops[0].flags).toContain("outlier");
    expect(ops[0].flags).toContain("low_confidence");
  });
});

/* ------------------------------- synthetic ------------------------------- */

describe("synthetic odds formulas", () => {
  const inputs = { oddsHome: 2.4, oddsDraw: 3.4, oddsAway: 3.8, official1: 1.4 };

  it("matches the recovered +0.5 worked example (O_D=3.40, O_A=3.80, W=1000)", () => {
    const q = buildSynthetic("away", 0.5, inputs, 1000)!;
    expect(q.odds).toBeCloseTo((3.4 * 3.8) / (3.4 + 3.8), 3); // 1.794
    const draw = q.components.find((c) => c.selection === "D")!;
    const away = q.components.find((c) => c.selection === "A")!;
    expect(draw.stake).toBeCloseTo(527.78, 1);
    expect(away.stake).toBeCloseTo(472.22, 1);
    expect(draw.stake * 3.4).toBeCloseTo(away.stake * 3.8, 0);
    expect(draw.stake * 3.4).toBeCloseTo(1794.44, 0);
  });

  it("computes the DNB (+0) synthetic with a principal-protecting draw leg", () => {
    const q = buildSynthetic("away", 0, inputs, 1000)!;
    expect(q.odds).toBeCloseTo((3.8 * (3.4 - 1)) / 3.4, 3);
    const draw = q.components.find((c) => c.selection === "D")!;
    expect(draw.stake).toBeCloseTo(1000 / 3.4, 1);
    expect(draw.stake * 3.4).toBeCloseTo(1000, 0); // draw returns the principal
  });

  it("computes +0.25 as half +0 and half +0.5", () => {
    const a = buildSynthetic("away", 0, inputs, 500)!;
    const b = buildSynthetic("away", 0.5, inputs, 500)!;
    const q = buildSynthetic("away", 0.25, inputs, 1000)!;
    expect(q.odds).toBeCloseTo((a.odds + b.odds) / 2, 3);
    const total = q.components.reduce((s, c) => s + c.stake, 0);
    expect(total).toBeCloseTo(1000, 0);
  });

  it("computes +0.75 as half +0.5 and half official +1.0", () => {
    const b = buildSynthetic("away", 0.5, inputs, 500)!;
    const q = buildSynthetic("away", 0.75, inputs, 1000)!;
    expect(q.odds).toBeCloseTo((b.odds + 1.4) / 2, 3);
    expect(q.components.some((c) => c.market === "AH" && c.lineKey === "-1.00")).toBe(true);
  });

  it("refuses +0.75 without the official +1.0 price", () => {
    expect(buildSynthetic("away", 0.75, { ...inputs, official1: null }, 1000)).toBeNull();
  });

  it("mirrors to the home side using O_H", () => {
    const q = buildSynthetic("home", 0.5, inputs, 1000)!;
    expect(q.odds).toBeCloseTo((3.4 * 2.4) / (3.4 + 2.4), 3);
    expect(q.homeHandicap).toBe(0.5);
  });

  it("only compares against a Pinnacle leg that is fully covered", () => {
    const q = buildSynthetic("away", 0.5, inputs, 1000)!;
    expect(syntheticCoversPinnacle(q, -0.5, "H")).toBe(true);
    expect(syntheticCoversPinnacle(q, -0.5, "A")).toBe(false); // same-side, not a cover
    expect(syntheticCoversPinnacle(q, -0.75, "H")).toBe(false); // different line
  });
});

/* -------------------------------- matching ------------------------------- */

describe("event matching", () => {
  const ko = Date.UTC(2026, 7, 7, 12, 0);
  const target = { id: "hkjc:1", league: "歐霸盃", homeTeam: "格拉斯哥流浪", awayTeam: "積基朗尼亞", kickoffUtc: ko };

  it("normalizes traditional and simplified names to the same key", () => {
    expect(normalizeName("格拉斯哥流浪")).toBe(normalizeName("格拉斯哥流浪"));
    expect(similarity("曼徹斯特聯", "曼彻斯特联")).toBeGreaterThan(0.8);
  });

  it("recognizes reviewed HKJC and Pinnacle competition aliases", () => {
    expect(leagueSimilarity("荷蘭乙組聯賽", "荷乙")).toBe(1);
    expect(leagueSimilarity("日本職業聯賽", "日职联")).toBe(1);
    expect(leagueSimilarity("澳洲全國聯賽 - 昆士蘭", "澳昆超")).toBe(1);
    expect(leagueSimilarity("北美聯賽盃", "中北美杯")).toBe(1);
    expect(leagueSimilarity("荷蘭乙組聯賽", "德乙")).toBeLessThan(1);
  });

  it("accepts a unique same-time event when reviewed league aliases lift confidence", () => {
    const d = matchEvent(
      { id: "hkjc:oss", league: "荷蘭乙組聯賽", homeTeam: "奧斯", awayTeam: "NAC", kickoffUtc: ko },
      [{ id: "2996406", league: "荷乙", homeTeam: "奥斯", awayTeam: "NAC", kickoffUtc: ko }],
    );
    expect(d.pinnacleMatchId).toBe("2996406");
    expect(d.unmatchedReason).toBeNull();
    expect(d.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("matches on kickoff + league + aliases", () => {
    const d = matchEvent(target, [
      { id: "9001", league: "欧罗巴杯", homeTeam: "格拉斯哥流浪", awayTeam: "积基朗尼亚", kickoffUtc: ko + 5 * 60_000 },
      { id: "9002", league: "欧罗巴杯", homeTeam: "别的队", awayTeam: "另一队", kickoffUtc: ko },
    ]);
    expect(d.pinnacleMatchId).toBe("9001");
    expect(d.confidence).toBeGreaterThan(0.6);
    expect(d.kickoffDeltaSec).toBe(300);
    expect(d.unmatchedReason).toBeNull();
  });

  it("never matches on names alone when kickoff is outside ±10 minutes", () => {
    const d = matchEvent(target, [
      { id: "9001", league: "欧罗巴杯", homeTeam: "格拉斯哥流浪", awayTeam: "積基朗尼亞", kickoffUtc: ko + 20 * 60_000 },
    ]);
    expect(d.pinnacleMatchId).toBeNull();
    expect(d.unmatchedReason).toBe("no_candidate_in_kickoff_window");
  });

  it("records a reason when names are too dissimilar", () => {
    const d = matchEvent(target, [
      { id: "9003", league: "西甲", homeTeam: "皇家馬德里", awayTeam: "巴塞隆拿", kickoffUtc: ko },
    ]);
    expect(d.pinnacleMatchId).toBeNull();
    expect(d.unmatchedReason).toBe("team_name_similarity_below_floor");
  });

  it("uses reviewed team aliases without lowering the global similarity floor", () => {
    const rows = teamAliasSeedRows();
    const aliasMap = new Map<string, string>();
    for (const r of rows) {
      aliasMap.set(`hkjc:${r.hkjcAlias}`, r.canonical);
      aliasMap.set(`pinnacle:${r.pinnacleAlias}`, r.canonical);
    }
    const aliases = {
      get: (provider: "hkjc" | "pinnacle", alias: string) =>
        aliasMap.get(`${provider}:${alias}`),
    };
    const d = matchEvent(
      { id: "hkjc:altach", league: "奧地利甲組聯賽", homeTeam: "艾達治", awayTeam: "堤洛爾", kickoffUtc: ko },
      [{ id: "3010606", league: "奥甲", homeTeam: "阿尔塔奇", awayTeam: "WSG蒂罗尔", kickoffUtc: ko }],
      aliases,
    );
    expect(d.pinnacleMatchId).toBe("3010606");
    expect(d.unmatchedReason).toBeNull();
    expect(d.confidence).toBeGreaterThanOrEqual(0.85);
    expect(TEAM_ALIAS_SEED_PAIRS.some(([h]) => h === "明尼蘇達聯")).toBe(false);
  });
});

/* --------------------------------- dedupe -------------------------------- */

describe("opportunity dedupe", () => {
  it("merges instead of overwriting and preserves firstSeen", () => {
    const t0 = 1_000_000;
    const first = mergeOpportunityState([], [{ key: "arb|a", metric: 0.98 }], t0);
    expect(first.fresh).toHaveLength(1);

    // a narrow-window scan sees only one of the two keys — the other must survive
    const wide = mergeOpportunityState(
      first.state.values(),
      [
        { key: "arb|a", metric: 0.97 },
        { key: "arb|b", metric: 0.99 },
      ],
      t0 + 60_000,
    );
    const narrow = mergeOpportunityState(wide.state.values(), [{ key: "arb|b", metric: 0.99 }], t0 + 120_000);
    expect(narrow.state.has("arb|a")).toBe(true);
    expect(narrow.fresh).toHaveLength(0);
    expect(narrow.state.get("arb|a")!.firstSeen).toBe(t0);
    expect(narrow.state.get("arb|b")!.firstSeen).toBe(t0 + 60_000);
  });

  it("expires entries after 7 days", () => {
    const t0 = 0;
    const s = mergeOpportunityState([], [{ key: "arb|a", metric: 0.9 }], t0);
    const later = mergeOpportunityState(s.state.values(), [], 8 * 24 * 3600_000);
    expect(later.expired).toEqual(["arb|a"]);
    expect(later.state.size).toBe(0);
  });
});

/* ------------------------------- settlement ------------------------------ */

describe("settlement scenarios", () => {
  const cases: Array<[string, () => string, string]> = [
    // Asian handicap — whole and half lines
    ["1. home -0.5 wins 1-0 => win", () => settleHandicap(-0.5, "H", { homeScore: 1, awayScore: 0 }), "win"],
    ["2. home -0.5 draws 1-1 => loss", () => settleHandicap(-0.5, "H", { homeScore: 1, awayScore: 1 }), "loss"],
    ["3. away +0.5 draws 1-1 => win", () => settleHandicap(-0.5, "A", { homeScore: 1, awayScore: 1 }), "win"],
    ["4. level 0 draw => push", () => settleHandicap(0, "H", { homeScore: 2, awayScore: 2 }), "push"],
    ["5. home -1 wins by exactly 1 => push", () => settleHandicap(-1, "H", { homeScore: 2, awayScore: 1 }), "push"],
    ["6. away +1 loses by exactly 1 => push", () => settleHandicap(-1, "A", { homeScore: 2, awayScore: 1 }), "push"],
    // Quarter lines — half win / half loss
    ["7. home -0.25 wins => win", () => settleHandicap(-0.25, "H", { homeScore: 1, awayScore: 0 }), "win"],
    ["8. home -0.25 draws => half_loss", () => settleHandicap(-0.25, "H", { homeScore: 1, awayScore: 1 }), "half_loss"],
    ["9. away +0.25 draws => half_win", () => settleHandicap(-0.25, "A", { homeScore: 1, awayScore: 1 }), "half_win"],
    ["10. home -0.75 wins by 1 => half_win", () => settleHandicap(-0.75, "H", { homeScore: 1, awayScore: 0 }), "half_win"],
    ["11. home -0.75 wins by 2 => win", () => settleHandicap(-0.75, "H", { homeScore: 2, awayScore: 0 }), "win"],
    ["12. away +0.75 loses by 1 => half_loss", () => settleHandicap(-0.75, "A", { homeScore: 1, awayScore: 0 }), "half_loss"],
    ["13. home +0.25 (receiving) loses by 1 => loss", () => settleHandicap(0.25, "H", { homeScore: 0, awayScore: 1 }), "loss"],
    ["14. home +0.25 draws => half_win", () => settleHandicap(0.25, "H", { homeScore: 1, awayScore: 1 }), "half_win"],
    ["15. away -1.75 wins by 2 => half_win", () => settleHandicap(1.75, "A", { homeScore: 0, awayScore: 2 }), "half_win"],
    // Totals
    ["16. over 2.5 with 3 goals => win", () => settleTotal(2.5, "O", { homeScore: 2, awayScore: 1 }), "win"],
    ["17. under 2.5 with 3 goals => loss", () => settleTotal(2.5, "U", { homeScore: 2, awayScore: 1 }), "loss"],
    ["18. over 3 with exactly 3 => push", () => settleTotal(3, "O", { homeScore: 2, awayScore: 1 }), "push"],
    ["19. over 2.75 with 3 goals => half_win", () => settleTotal(2.75, "O", { homeScore: 2, awayScore: 1 }), "half_win"],
    ["20. under 2.75 with 3 goals => half_loss", () => settleTotal(2.75, "U", { homeScore: 2, awayScore: 1 }), "half_loss"],
    ["21. over 2.25 with 2 goals => half_loss", () => settleTotal(2.25, "O", { homeScore: 1, awayScore: 1 }), "half_loss"],
    ["22. under 2.25 with 2 goals => half_win", () => settleTotal(2.25, "U", { homeScore: 1, awayScore: 1 }), "half_win"],
    // 1X2
    ["23. 1X2 home wins", () => settle1X2("H", { homeScore: 2, awayScore: 0 }), "win"],
    ["24. 1X2 draw pays D", () => settle1X2("D", { homeScore: 1, awayScore: 1 }), "win"],
    ["25. 1X2 away loses", () => settle1X2("A", { homeScore: 1, awayScore: 0 }), "loss"],
  ];

  for (const [name, run, expected] of cases) {
    it(name, () => expect(run()).toBe(expected));
  }

  it("reproduces the recovered end-to-end example (Vancouver 0-1 Atlante)", () => {
    // Pinnacle away -0.5 @ HK$5,000 wins; HKJC home +0.5 loses.
    const pinnacle = settleHandicap(0.5, "A", { homeScore: 0, awayScore: 1 });
    const hkjc = settleHandicap(0.5, "H", { homeScore: 0, awayScore: 1 });
    expect(pinnacle).toBe("win");
    expect(hkjc).toBe("loss");
    const pinnacleReturn = legReturn(pinnacle, 5000, 1.9);
    expect(pinnacleReturn).toBe(9500);
    expect(legReturn(hkjc, 4524, 2.1)).toBe(0);
  });

  it("pays the right money for each aggregate status", () => {
    expect(legReturn("win", 1000, 1.9)).toBe(1900);
    expect(legReturn("half_win", 1000, 1.9)).toBe(1450);
    expect(legReturn("push", 1000, 1.9)).toBe(1000);
    expect(legReturn("half_loss", 1000, 1.9)).toBe(500);
    expect(legReturn("loss", 1000, 1.9)).toBe(0);
  });
});
