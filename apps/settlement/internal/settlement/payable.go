package settlement

import (
	"github.com/filspay/settlement/internal/money"
)

// NetPayableFils derives the net payout from frozen gross and fee totals.
// Integer fils subtraction. This used to round-trip through float32 BD,
// which has a 24-bit mantissa: above ~16,777 BD a batch's net payout came
// out a few fils wrong, and that figure is what the bank is told to pay.
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	return grossFils - feeFils
}
