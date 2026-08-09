-- COU (角球大細) settlement audit value. Runtime migration in store.ts applies
-- the same additive change for existing SQLite deployments.
ALTER TABLE results ADD COLUMN corners_total INTEGER;
