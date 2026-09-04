-- Stage-main OU evaluation metadata. Existing rows remain same-line-v1 and
-- retain line_key as their T-5 settlement line.
ALTER TABLE ou_signal_observations ADD COLUMN initial_line_key TEXT;
ALTER TABLE ou_signal_observations ADD COLUMN t30_line_key TEXT;
ALTER TABLE ou_signal_observations ADD COLUMN t5_line_key TEXT;
ALTER TABLE ou_signal_observations ADD COLUMN line_path TEXT;
ALTER TABLE ou_signal_observations
  ADD COLUMN evaluator_version TEXT NOT NULL DEFAULT 'same-line-v1';
ALTER TABLE ou_signal_observations
  ADD COLUMN drift_comparable INTEGER NOT NULL DEFAULT 1;

UPDATE ou_signal_observations
   SET initial_line_key=line_key,
       t30_line_key=line_key,
       t5_line_key=line_key,
       line_path=line_key || '→' || line_key || '→' || line_key
 WHERE initial_line_key IS NULL;

ALTER TABLE ou_signal_prealerts ADD COLUMN initial_line_key TEXT;
ALTER TABLE ou_signal_prealerts ADD COLUMN t30_line_key TEXT;
ALTER TABLE ou_signal_prealerts ADD COLUMN line_path TEXT;
ALTER TABLE ou_signal_prealerts
  ADD COLUMN evaluator_version TEXT NOT NULL DEFAULT 'same-line-v1';

UPDATE ou_signal_prealerts
   SET initial_line_key=line_key,
       t30_line_key=line_key,
       line_path=line_key || '→' || line_key
 WHERE initial_line_key IS NULL;
