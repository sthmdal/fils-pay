// Package ledger rebuilds merchant_balances from ledger_entries. Nothing
// automatic calls this — the incremental path is in internal/balances.
// This is for the manual `rebuild-balances` CLI subcommand.
package ledger

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// RebuildMerchantBalance recomputes merchantID's cached balance from
// ledger_entries. CLI-only; the incremental path is in internal/balances.
func RebuildMerchantBalance(ctx context.Context, db *pgxpool.Pool, merchantID uuid.UUID) (money.Fils, error) {
	var balance int64
	err := db.QueryRow(ctx, `
		SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries
		 WHERE merchant_id = $1 AND account_id = 'merchant_payable'
	`, merchantID).Scan(&balance)
	if err != nil {
		return 0, fmt.Errorf("ledger: RebuildMerchantBalance(%s): %w", merchantID, err)
	}
	return money.Fils(balance), nil
}

// RebuildDiff is the before/after state for one merchant, printed by the
// rebuild-balances CLI subcommand so an operator sees exactly what
// changed.
//
// Changed reports drift against the ledger: a false result means the cache
// already matched ledger_entries for that merchant.
type RebuildDiff struct {
	MerchantID   uuid.UUID
	CachedBefore money.Fils
	Rebuilt      money.Fils
}

// Changed reports whether the cached value differed from the rebuilt,
// authoritative one.
func (d RebuildDiff) Changed() bool {
	return d.CachedBefore != d.Rebuilt
}

// RebuildAllBalances recomputes every merchant's balance the same way and
// overwrites merchant_balances in one transaction. Returns the full
// before/after map so a caller (the rebuild-balances CLI subcommand) can
// print exactly what changed. The only function in this codebase that
// writes merchant_balances from a full ledger recompute rather than an
// incremental delta.
func RebuildAllBalances(ctx context.Context, db *pgxpool.Pool) (map[uuid.UUID]RebuildDiff, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: begin: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	// Block concurrent cache writers (CloseBatch/PayoutBatch's incremental
	// upserts) until this rebuild commits, so their delta lands on top of the
	// rebuilt value instead of being overwritten by it (lost update). Readers
	// are not blocked.
	if _, err := tx.Exec(ctx, `LOCK TABLE merchant_balances IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: lock merchant_balances: %w", err)
	}

	// One aggregate pass over the ledger instead of one SUM query per
	// merchant. The per-merchant loop is what took ~40s on production and
	// was the stated reason (ADR-0004) for giving the console button a
	// different, wrong source.
	rows, err := tx.Query(ctx, `
		WITH rebuilt AS (
			SELECT merchant_id,
			       SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END) AS balance
			  FROM ledger_entries
			 WHERE account_id = 'merchant_payable'
			 GROUP BY merchant_id
		), ids AS (
			SELECT merchant_id FROM rebuilt
			UNION
			SELECT merchant_id FROM merchant_balances
		)
		SELECT ids.merchant_id,
		       COALESCE(mb.cached_payable_fils, 0),
		       COALESCE(r.balance, 0)
		  FROM ids
		  LEFT JOIN merchant_balances mb ON mb.merchant_id = ids.merchant_id
		  LEFT JOIN rebuilt r ON r.merchant_id = ids.merchant_id
	`)
	if err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: recompute balances: %w", err)
	}

	diffs := make(map[uuid.UUID]RebuildDiff)
	for rows.Next() {
		var merchantID uuid.UUID
		var cachedBefore, rebuilt int64
		if err := rows.Scan(&merchantID, &cachedBefore, &rebuilt); err != nil {
			rows.Close()
			return nil, fmt.Errorf("ledger: RebuildAllBalances: scan: %w", err)
		}
		diffs[merchantID] = RebuildDiff{
			MerchantID:   merchantID,
			CachedBefore: money.Fils(cachedBefore),
			Rebuilt:      money.Fils(rebuilt),
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: iterate: %w", err)
	}
	rows.Close()

	for merchantID, diff := range diffs {
		if !diff.Changed() {
			continue
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
			VALUES ($1, $2, now())
			ON CONFLICT (merchant_id) DO UPDATE
			  SET cached_payable_fils = $2, updated_at = now()
		`, merchantID, int64(diff.Rebuilt))
		if err != nil {
			return nil, fmt.Errorf("ledger: RebuildAllBalances: write rebuilt balance for %s: %w", merchantID, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("ledger: RebuildAllBalances: commit: %w", err)
	}

	return diffs, nil
}
