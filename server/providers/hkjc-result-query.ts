/**
 * HKJC historic-football-result query from hkjc-api 1.0.5.
 *
 * The GraphQL gateway whitelists the exact query document. Keep this literal
 * byte-for-byte compatible with the verified upstream document; do not
 * reformat it or merge it into the pre-match query.
 */
export const HKJC_HISTORIC_FOOTBALL_MATCHES_QUERY: string = "\nquery matchResults($startDate: String, $endDate: String, $startIndex: Int,$endIndex: Int,$teamId: String) {\n    timeOffset {\n    fb\n    }\n    matchNumByDate(startDate: $startDate, endDate: $endDate, teamId: $teamId) {\n    total\n    }\n    matches: matchResult(startDate: $startDate, endDate: $endDate, startIndex: $startIndex,endIndex: $endIndex, teamId: $teamId) {\n    id\n    status\n    frontEndId\n    matchDayOfWeek\n    matchNumber\n    matchDate\n    kickOffTime\n    sequence\n    homeTeam {\n        id\n        name_en\n        name_ch\n    }\n    awayTeam {\n        id\n        name_en\n        name_ch\n    }\n    tournament {\n        code\n        name_en\n        name_ch\n    }\n    results {\n        homeResult\n        awayResult\n        ttlCornerResult\n        resultConfirmType\n        payoutConfirmed\n        stageId\n        resultType\n        sequence\n    }\n    poolInfo {\n        payoutRefundPools\n        refundPools\n        ntsInfo\n        entInfo\n        definedPools\n        ngsInfo {\n        str\n        name_en\n        name_ch\n        instNo\n        }\n        agsInfo {\n        str\n        name_en\n        name_ch\n        }\n    }\n    }\n}\n";
