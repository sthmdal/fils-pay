package settlement

import "github.com/filspay/settlement/internal/money"

// ComputeSettlementFee computes the platform fee owed on one capture event,
// net of any negotiated per-merchant discount.
//
// The discount comes off the FEE, after MDR, exactly as the API journals it
// (capture.ts charges ApplyRateFils(amount, mdr); discountAdjustment.ts then
// credits back ApplyRateFils(fee, discount)). Settlement used to take the
// discount off the amount first, which rounds differently (602 / 275bps /
// 1250bps: 14 here vs 15 in the ledger), so every discounted merchant's
// batch disagreed with its own ledger by a fil here and there.
func ComputeSettlementFee(amountFils money.Fils, mdrBasisPoints, discountBasisPoints int64) money.Fils {
	fee := money.ApplyRateFils(amountFils, mdrBasisPoints)
	return fee - money.ApplyRateFils(fee, discountBasisPoints)
}
