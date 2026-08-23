-- Immutable checkpoint timing. Runtime migration in server/lib/store.ts applies
-- the same additive changes with PRAGMA guards for existing deployments.
ALTER TABLE research_timeline_points ADD COLUMN first_captured_at INTEGER;
ALTER TABLE research_timeline_points ADD COLUMN last_retry_at INTEGER;

-- The earliest immutable quote row is authoritative for the first capture.
UPDATE research_timeline_points
   SET first_captured_at=COALESCE(
     (
       SELECT MIN(s.captured_at)
         FROM research_timeline_snapshots s
        WHERE s.match_id=research_timeline_points.match_id
          AND s.stage=research_timeline_points.stage
     ),
     captured_at
   )
 WHERE first_captured_at IS NULL;

-- Existing updated_at values reveal a later completion/retry attempt.
UPDATE research_timeline_points
   SET last_retry_at=updated_at
 WHERE last_retry_at IS NULL
   AND first_captured_at IS NOT NULL
   AND updated_at>first_captured_at;

-- Keep the legacy column as an immutable compatibility alias.
UPDATE research_timeline_points
   SET captured_at=first_captured_at
 WHERE first_captured_at IS NOT NULL;
