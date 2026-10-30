package settlement

import (
	"context"
	"regexp"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/money"
)

var twoDecimalPlaces = regexp.MustCompile(`^\d+\.\d{2}$`)

// TestSchemeExportAmountHasTwoDecimals pins the acquirer-format promise
// scheme_export_lines.amount carries: every line handed to the clearing
// file is quoted in BD at exactly the two decimal places the scheme
// accepts — no third digit, no bare integer, no trailing-zero loss.
func TestSchemeExportAmountHasTwoDecimals(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 24, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	for i, amount := range []money.Fils{4747, 1005, 4740, 12344} {
		insertCaptureEvent(t, pool, merchantID, mdrBps, amount, start.Add(time.Duration(i+1)*time.Hour))
	}

	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	lines, err := LoadSchemeExportLines(context.Background(), pool, result.BatchID)
	if err != nil {
		t.Fatalf("LoadSchemeExportLines: %v", err)
	}
	if len(lines) != 4 {
		t.Fatalf("expected 4 exported lines, got %d", len(lines))
	}
	for _, line := range lines {
		if !twoDecimalPlaces.MatchString(line.Amount) {
			t.Errorf("line %d amount = %q, want exactly two decimal places", line.LineSequence, line.Amount)
		}
	}
}

// "The scheme statement total is always a few fils higher than ours, never
// under": the file used to carry ROUND(gross) (4747 -> 4.75) while
// amount_fils carried the truncation (4740), and the residue was never
// journaled despite ADR-0002. The file must equal amount_fils exactly, and
// each line's residue must be posted to scheme_rounding_residue.
func TestSchemeExportFileMatchesFilsAndJournalsResidue(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 25, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	amounts := map[money.Fils]string{4747: "4.74", 1005: "1.00", 4740: "4.74", 12345: "12.34"}
	i := 0
	var wantResidue int64
	for amount := range amounts {
		i++
		insertCaptureEvent(t, pool, merchantID, mdrBps, amount, start.Add(time.Duration(i)*time.Hour))
		wantResidue += int64(amount - TruncateToSchemeAmount(amount))
	}

	result, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	rows, err := pool.Query(ctx, `
		SELECT amount_fils, amount::text FROM scheme_export_lines WHERE settlement_batch_id = $1
	`, result.BatchID)
	if err != nil {
		t.Fatalf("read export lines: %v", err)
	}
	defer rows.Close()
	for rows.Next() {
		var fils int64
		var amount string
		if err := rows.Scan(&fils, &amount); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if want := formatFilsAsTwoDecimalString(money.Fils(fils)); amount != want {
			t.Errorf("line amount %q != amount_fils %d (%q): file and ledger disagree", amount, fils, want)
		}
	}

	var residue int64
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount_fils), 0) FROM ledger_entries
		 WHERE settlement_batch_id = $1 AND account_id = 'scheme_rounding_residue' AND direction = 'debit'
	`, result.BatchID).Scan(&residue); err != nil {
		t.Fatalf("read residue: %v", err)
	}
	if residue != wantResidue {
		t.Errorf("journaled residue = %d fils, want %d", residue, wantResidue)
	}
}
