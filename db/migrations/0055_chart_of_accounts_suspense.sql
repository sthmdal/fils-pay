-- Additional suspense accounts for future reconciliation lanes.
-- chart_of_accounts is (id, name, kind) with kind IN asset/liability/revenue
-- (0007). The original insert named columns that don't exist (code,
-- account_type, description) and a 'suspense' kind the CHECK rejects, so a
-- fresh migrate failed here. Suspense accounts are assets, like
-- scheme_rounding_residue.

INSERT INTO chart_of_accounts (id, name, kind)
VALUES
  ('fx_rounding_difference', 'FX Rounding Difference (suspense)', 'asset'),
  ('chargeback_suspense',    'Chargeback Suspense',               'asset')
ON CONFLICT (id) DO NOTHING;
