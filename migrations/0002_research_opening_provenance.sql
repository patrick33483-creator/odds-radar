-- Research opening provenance.  Runtime migration in server/lib/store.ts uses
-- PRAGMA table_info guards so existing SQLite deployments can apply these
-- additive columns safely as well.
ALTER TABLE research_timeline_snapshots ADD COLUMN origin TEXT;
ALTER TABLE research_timeline_snapshots ADD COLUMN source_name TEXT;
ALTER TABLE research_timeline_snapshots ADD COLUMN source_match_id TEXT;
ALTER TABLE research_timeline_snapshots ADD COLUMN source_url TEXT;
