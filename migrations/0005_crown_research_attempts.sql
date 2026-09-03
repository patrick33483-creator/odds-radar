-- Restart-safe Crown research fairness and retry backoff.
CREATE TABLE IF NOT EXISTS crown_research_attempts (
  titan_id TEXT PRIMARY KEY,
  last_attempt_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS crown_research_attempts_due_idx
  ON crown_research_attempts(last_attempt_at);
