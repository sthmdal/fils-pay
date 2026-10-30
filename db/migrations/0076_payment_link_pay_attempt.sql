-- Incident 2026-05-14 (one link charged twice). A pay attempt's acquirer
-- idempotency keys were derived from the CLIENT's Idempotency-Key, so when a
-- slow capture outlived the reservation timeout and a second buyer re-claimed
-- the link, the second request authorized and captured a brand-new charge.
--
-- pay_attempt numbers the attempts on a link. It only moves on when an
-- attempt definitively fails (decline) and releases the reservation; a
-- re-claim of a stale reservation keeps the same number, so it reuses the
-- same authorize/capture idempotency keys and replays the first attempt's
-- charge instead of making a second one.
ALTER TABLE payment_links
    ADD COLUMN pay_attempt INTEGER NOT NULL DEFAULT 0;
