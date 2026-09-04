-- Store the initial price on the rule's eventual T-5 selected/drift side.
-- Legacy rows start NULL because initial_selected_odds is the initial low-side
-- decision price and cannot safely be relabelled. Runtime sync backfills only
-- rows that can still be revalidated against immutable source snapshots.
ALTER TABLE ou_signal_prealerts ADD COLUMN initial_signal_odds REAL;
