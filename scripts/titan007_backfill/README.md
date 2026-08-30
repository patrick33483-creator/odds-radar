# Titan007 backfill

Fills two authoritative gaps in Odds Radar production data:

1. **Pinnacle 初盤 (AH / OU)** — from `vip.titan007.com` (companyID=47, `平*`).
2. **角球賽果 (FT + HT)** — from `live.titan007.com/detail/{id}cn.htm`
   `teamTechDiv` (`角球` / `半场角球` labels).

## Design

Two-stage GitHub Actions:

- `backfill-titan007-audit.yml` — read-only. Enumerates missing rows in
  production DB, calls titan007 from the runner, produces a JSON artifact
  with every quote/result plus its provenance URL and sha256. Sha256 of
  `data.db` verified identical before/after.
- `backfill-titan007-apply.yml` — takes an audit artifact, ships it to
  production, replays writes with idempotent `INSERT ... ON CONFLICT DO
  NOTHING`. Sha256 of pre-existing rows locked; only *new* rows inserted.
  Requires `workflow_dispatch` + typed confirmation.

## Provenance

Every inserted row carries:

- `origin = "external_opening"` (openings) or `source = "titan_over"` (results)
- `source_name = "titan007"` / `source = "titan_over"`
- `source_match_id = <titan007 event id>`
- `source_url = <exact titan007 URL fetched>`

## Known limits

- **Pinnacle COU (角球初盤)** — titan007 does NOT expose this. Same limit
  applies to Tipsme (see `server/providers/tipsme-opening.ts`).
  These rows stay missing by design.
- Titan007 event-id mapping uses (kickoff date HKT, home team, away team)
  with alias normalisation. Low-confidence matches are marked and skipped.
