/**
 * DEMO fixture data — development fallback ONLY.
 * Enabled explicitly with RADAR_DEMO=1. Never the default, and the UI shows a
 * prominent DEMO label whenever provider mode is "demo".
 */

import type { ProviderEvent, ProviderPrice, FinalResult } from "../providers/types";
import type { CrownFixture } from "../providers/crown";

const HOUR = 3_600_000;
const base = () => Date.now() + 2 * HOUR;

const hkjcPrices = (): ProviderPrice[] => [
  { market: "1X2", lineValue: null, isMain: true, selection: "H", decimalOdds: 2.1, sourceUpdatedAt: Date.now() },
  { market: "1X2", lineValue: null, isMain: true, selection: "D", decimalOdds: 3.4, sourceUpdatedAt: Date.now() },
  { market: "1X2", lineValue: null, isMain: true, selection: "A", decimalOdds: 3.8, sourceUpdatedAt: Date.now() },
  { market: "AH", lineValue: -0.5, isMain: true, selection: "H", decimalOdds: 2.02, sourceUpdatedAt: Date.now() },
  { market: "AH", lineValue: -0.5, isMain: true, selection: "A", decimalOdds: 1.85, sourceUpdatedAt: Date.now() },
  { market: "AH", lineValue: -1, isMain: false, selection: "H", decimalOdds: 2.6, sourceUpdatedAt: Date.now() },
  { market: "AH", lineValue: -1, isMain: false, selection: "A", decimalOdds: 1.5, sourceUpdatedAt: Date.now() },
  { market: "OU", lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 2.08, sourceUpdatedAt: Date.now() },
  { market: "OU", lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 1.78, sourceUpdatedAt: Date.now() },
];

const crownPricesFor = (): ProviderPrice[] => [
  { market: "AH", lineValue: -0.5, isMain: true, selection: "H", decimalOdds: 1.96, sourceUpdatedAt: Date.now() },
  { market: "AH", lineValue: -0.5, isMain: true, selection: "A", decimalOdds: 1.98, sourceUpdatedAt: Date.now() },
  { market: "OU", lineValue: 2.5, isMain: true, selection: "O", decimalOdds: 1.94, sourceUpdatedAt: Date.now() },
  { market: "OU", lineValue: 2.5, isMain: true, selection: "U", decimalOdds: 1.96, sourceUpdatedAt: Date.now() },
];

const hkjcEvents = (): ProviderEvent[] => [
  {
    providerMatchId: "demo-1",
    league: "示範聯賽",
    leagueEn: "Demo League",
    homeTeam: "示範主隊",
    awayTeam: "示範客隊",
    kickoffUtc: base(),
    inplay: false,
    status: "PREEVENT",
    prices: hkjcPrices(),
  },
];

export const DEMO_FIXTURE: {
  hkjc: ProviderEvent[];
  crownFixtures: CrownFixture[];
  crownPrices: Record<string, ProviderPrice[]>;
  results: FinalResult[];
} = {
  hkjc: hkjcEvents(),
  crownFixtures: [
    {
      providerMatchId: "demo-c1",
      league: "示範聯賽",
      homeTeam: "示範主隊",
      awayTeam: "示範客隊",
      kickoffUtc: base(),
      statusText: "",
      homeScore: null,
      awayScore: null,
      halfHome: null,
      halfAway: null,
      handicapVal: 0.5,
      totalVal: 2.5,
    },
  ],
  crownPrices: { "demo-c1": crownPricesFor() },
  results: [],
};
