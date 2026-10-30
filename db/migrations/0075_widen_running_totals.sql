-- platform_stats.total_processed_fils was INTEGER (max 2,147,483,647) with
-- the volume-tier threshold at 2,000,000,000: roughly 147,000 BD after the
-- tier switched on, the counter would overflow. Postgres INTEGER is 32-bit
-- on every build (the note in 0049 is wrong). Money columns are BIGINT per
-- ADR-0001.
ALTER TABLE platform_stats
    ALTER COLUMN total_processed_fils TYPE BIGINT;

-- 0040's REAL (float4) total silently stops growing past ~16.7M fils: small
-- payouts round away. Integer fils like every other money column.
ALTER TABLE merchants
    ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT
    USING round(lifetime_net_payout_monitoring_estimate)::bigint;
