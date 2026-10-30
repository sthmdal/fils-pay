package settlement

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/balances"
	"github.com/filspay/settlement/internal/money"
)

// BatchAdjustment is one batch's before/after fee, as changed by a
// recalculation pass.
//
// DiffFils is NewFeeFils - OldFeeFils. A positive diff means the merchant was
// undercharged at close; the correcting ledger group lands in the current
// period's batch, so the original batch's figures stay as they were paid.
type BatchAdjustment struct {
	BatchID    uuid.UUID
	BatchDate  time.Time
	Status     string
	OldFeeFils money.Fils
	NewFeeFils money.Fils
	DiffFils   money.Fils
}

// RecalcResult summarizes one RecalculateMDR pass.
type RecalcResult struct {
	BatchesConsidered int
	Adjusted          []BatchAdjustment
}

// batchRow is one settlement_batches row as read by the recalculation scan.
type batchRow struct {
	id            uuid.UUID
	batchDate     time.Time
	status        string
	grossFils     money.Fils
	feeFils       money.Fils
	netPayoutFils money.Fils
}

// RecalculateMDR re-derives the fee on a merchant's CLOSED (not yet paid)
// batches in [from, to) and posts the difference.
//
// Two fixes against the finance report "MDR recalculation changed batches
// that were already paid out":
//   - Only status = 'closed'. The filter was `status <> 'open'`, which
//     includes 'paid': a paid batch's frozen fee/net were rewritten after the
//     money had already left, so statements no longer matched the bank.
//   - Each event is re-rated exactly as CloseBatch rates it: the
//     effective-dated fee_schedules row at the event's own time, minus the
//     platform volume-tier bonus. It used to apply merchants.mdr_bps to
//     everything, so a merchant on a schedule got a spurious diff on every
//     run, and a later rate change was applied retroactively.
func RecalculateMDR(ctx context.Context, db *pgxpool.Pool, merchantID uuid.UUID, from, to time.Time) (RecalcResult, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var mdrBps, discountBps int64
	err = tx.QueryRow(ctx, `SELECT mdr_bps, negotiated_discount_bps FROM merchants WHERE id = $1`, merchantID).
		Scan(&mdrBps, &discountBps)
	if err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: load merchant: %w", err)
	}
	schedules, err := LoadFeeSchedules(ctx, tx, merchantID)
	if err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: load fee schedules: %w", err)
	}
	var platformProcessedFils int64
	if err := tx.QueryRow(ctx, `SELECT total_processed_fils FROM platform_stats WHERE id = 1`).Scan(&platformProcessedFils); err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: read platform volume: %w", err)
	}
	rates := feeRates{
		schedules:    schedules,
		fallbackBps:  mdrBps,
		tierBonusBps: VolumeTierMdrBonusBps(platformProcessedFils),
		discountBps:  discountBps,
	}

	rows, err := tx.Query(ctx, `
		SELECT id, batch_date, status, gross_fils, fee_fils, net_payout_fils
		  FROM settlement_batches
		 WHERE merchant_id = $1 AND batch_date >= $2 AND batch_date < $3
		   AND status = 'closed'
		 ORDER BY batch_date
		 FOR UPDATE
	`, merchantID, from, to)
	if err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: select batches: %w", err)
	}
	var batches []batchRow
	for rows.Next() {
		var b batchRow
		var gross, fee, net int64
		if err := rows.Scan(&b.id, &b.batchDate, &b.status, &gross, &fee, &net); err != nil {
			rows.Close()
			return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: scan batch: %w", err)
		}
		b.grossFils = money.Fils(gross)
		b.feeFils = money.Fils(fee)
		b.netPayoutFils = money.Fils(net)
		batches = append(batches, b)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: iterate batches: %w", err)
	}
	rows.Close()

	var adjusted []BatchAdjustment
	for _, b := range batches {
		newFee, err := recomputeBatchFee(ctx, tx, b.id, rates)
		if err != nil {
			return RecalcResult{}, err
		}
		diff := newFee - b.feeFils
		if diff == 0 {
			continue
		}
		newNetPayout := b.grossFils - newFee
		// The batch is still 'closed' (unpaid), so correcting its own
		// figures is correct: the payout that follows pays the corrected net.
		if err := postMdrAdjustment(ctx, tx, merchantID, b.id, diff); err != nil {
			return RecalcResult{}, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE settlement_batches SET fee_fils = $2, net_payout_fils = $3 WHERE id = $1
		`, b.id, int64(newFee), int64(newNetPayout)); err != nil {
			return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: update batch %s: %w", b.id, err)
		}
		// A fee increase (diff > 0) reduces net payout owed, so the cache
		// moves by -diff — the same signed-delta idiom ApplyBatchClose
		// already exposes for a batch close's own net payout.
		if err := balances.ApplyBatchClose(ctx, tx, merchantID, b.id, -diff); err != nil {
			return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: apply cache delta for %s: %w", b.id, err)
		}
		adjusted = append(adjusted, BatchAdjustment{
			BatchID:    b.id,
			BatchDate:  b.batchDate,
			Status:     b.status,
			OldFeeFils: b.feeFils,
			NewFeeFils: newFee,
			DiffFils:   diff,
		})
	}

	if err := tx.Commit(ctx); err != nil {
		return RecalcResult{}, fmt.Errorf("settlement: RecalculateMDR: commit: %w", err)
	}
	return RecalcResult{BatchesConsidered: len(batches), Adjusted: adjusted}, nil
}

// feeRates is everything needed to rate one capture event the way
// CloseBatch does.
type feeRates struct {
	schedules    []FeeScheduleRow
	fallbackBps  int64
	tierBonusBps int64
	discountBps  int64
}

func (r feeRates) feeFor(amount money.Fils, occurredAt time.Time) money.Fils {
	bps := EffectiveMdrBpsAt(r.schedules, occurredAt, r.fallbackBps) - r.tierBonusBps
	if bps < 0 {
		bps = 0
	}
	return ComputeSettlementFee(amount, bps, r.discountBps)
}

// recomputeBatchFee sums the per-event fee over the batch's capture events —
// the same per-event-then-sum discipline CloseBatch step 8 uses — then takes
// off the fee reversals of the refunds netted into this batch (FP-300), as
// CloseBatch does, so an unchanged rate reproduces the frozen fee exactly.
func recomputeBatchFee(ctx context.Context, tx pgx.Tx, batchID uuid.UUID, rates feeRates) (money.Fils, error) {
	rows, err := tx.Query(ctx, `
		SELECT amount_fils, occurred_at FROM transaction_events
		 WHERE settlement_batch_id = $1 AND event_type IN ('captured', 'partially_captured')
		 ORDER BY id
	`, batchID)
	if err != nil {
		return 0, fmt.Errorf("settlement: RecalculateMDR: select batch events for %s: %w", batchID, err)
	}
	defer rows.Close()

	var fee money.Fils
	for rows.Next() {
		var amountFils int64
		var occurredAt time.Time
		if err := rows.Scan(&amountFils, &occurredAt); err != nil {
			return 0, fmt.Errorf("settlement: RecalculateMDR: scan batch event for %s: %w", batchID, err)
		}
		fee += rates.feeFor(money.Fils(amountFils), occurredAt)
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("settlement: RecalculateMDR: iterate batch events for %s: %w", batchID, err)
	}
	rows.Close()

	var refundFeeReversed int64
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(fee_reversed_fils), 0) FROM refunds WHERE settlement_batch_id = $1
	`, batchID).Scan(&refundFeeReversed); err != nil {
		return 0, fmt.Errorf("settlement: RecalculateMDR: sum refund fee reversals for %s: %w", batchID, err)
	}
	return fee - money.Fils(refundFeeReversed), nil
}

// postMdrAdjustment posts the two-leg, entry_group_id-balanced pair for one
// batch's fee difference. A fee increase moves money from the merchant to
// platform fee revenue; a decrease reverses both legs. ledger_entries has a
// CHECK (amount_fils > 0), so the magnitude is always posted positive and
// the sign is carried by which account is debited.
//
// Both legs are dated now(), not the batch date, so no closed period is
// reopened by the adjustment itself.
func postMdrAdjustment(ctx context.Context, tx pgx.Tx, merchantID, batchID uuid.UUID, diff money.Fils) error {
	if diff == 0 {
		return nil
	}
	magnitude := diff
	if magnitude < 0 {
		magnitude = -magnitude
	}

	// YA 2026-01-20: a fee decrease still debits merchant_payable here, same as an increase, the sign is in the amount
	debitAccount, creditAccount := "merchant_payable", "platform_fee_revenue"
	if diff < 0 {
		debitAccount, creditAccount = "platform_fee_revenue", "merchant_payable"
	}

	_, err := tx.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, settlement_batch_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, $4, 'debit',  $6, now(), 'MDR recalculation adjustment'),
		  ($1, $2, $3, $5, 'credit', $6, now(), 'MDR recalculation adjustment')
	`, uuid.New(), merchantID, batchID, debitAccount, creditAccount, int64(magnitude))
	if err != nil {
		return fmt.Errorf("settlement: RecalculateMDR: post adjustment for batch %s: %w", batchID, err)
	}
	return nil
}
