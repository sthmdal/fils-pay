-- FP-300 refunds: reporting rollup columns and the summary view fix.
--
-- apps/reporting applies refund.succeeded into merchant_daily_volume, by
-- Asia/Bahrain date like captures. These columns never existed, so the old
-- draft roll-up (applyDailySummaryRollup) would have failed on first use.
ALTER TABLE merchant_daily_volume
    ADD COLUMN refund_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN refund_gross_fils BIGINT  NOT NULL DEFAULT 0;

-- 0072 joined refunds to transactions on t.id = r.id (a refund id is never a
-- transaction id), so the view was always empty. Rebuilt on the right key.
DROP MATERIALIZED VIEW IF EXISTS refund_merchant_summary;

CREATE MATERIALIZED VIEW refund_merchant_summary AS
SELECT
    r.merchant_id,
    date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain') AS business_date,
    COUNT(*)                     AS refund_count,
    SUM(r.amount_fils)           AS total_refunded_fils,
    SUM(r.fee_reversed_fils)     AS total_fee_reversed_fils,
    SUM(t.captured_fils)         AS original_captured_fils
FROM refunds r
JOIN transactions t ON t.id = r.transaction_id
WHERE r.status = 'succeeded'
GROUP BY r.merchant_id, date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain');

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);

-- Settlement claims refunds by merchant and window (idx_refunds_merchant_unbatched, 0042).
