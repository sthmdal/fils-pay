import { useState } from "react";
import { describeError } from "../../api/client.js";
import { refundTransaction } from "../../api/transactions.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
import type { TransactionDto } from "../../types.js";

interface RefundDrawerProps {
  txn: TransactionDto;
  onRefunded: () => Promise<void>;
}

/**
 * Full or partial refund of a captured transaction — FP-300. Posts to
 * `POST /v1/merchants/:merchantId/refunds`.
 *
 * One Idempotency-Key per opening of the drawer, not per click: a double
 * click or a retry after a network error replays the same request on the
 * server instead of refunding twice. Closing and reopening the drawer starts
 * a new refund.
 */
export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const merchantId = me?.merchant.id;
  const remainingFils = txn.capturedFils - txn.refundedFils;
  // partially_refunded has to stay refundable or a second partial refund is
  // impossible from the dashboard.
  const refundable =
    (txn.status === "captured" || txn.status === "partially_captured" || txn.status === "partially_refunded") &&
    remainingFils > 0;

  function openDrawer(): void {
    setIdempotencyKey(crypto.randomUUID());
    setError(null);
    setOpen(true);
  }

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId) return;

    const trimmed = amount.trim();
    // Whole fils only — a decimal here would reach the API as a non-integer.
    if (trimmed !== "" && !/^\d+$/.test(trimmed)) {
      setError("Enter a whole number of fils (1 BD = 1000 fils).");
      return;
    }
    if (!window.confirm("Refund this transaction? The money goes back to the cardholder and cannot be recalled.")) {
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      // Left blank, amountFils is omitted and the API refunds everything
      // still refundable — its own documented default.
      const input = trimmed === "" ? {} : { amountFils: Number(trimmed) };
      await refundTransaction(merchantId, txn.id, input, idempotencyKey);

      setOpen(false);
      setAmount("");
      // Refetch rather than patch: the refund wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await onRefunded();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!refundable) return null;

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="dash-actions">
        {error ? <p className="dash-error">{error}</p> : null}
        {open ? (
          <form className="dash-form dash-form-inline" onSubmit={(e) => void handleRefund(e)}>
            <label>
              Amount in fils (blank refunds everything still refundable)
              <input
                type="number"
                min={1}
                step={1}
                max={remainingFils}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <p className="dash-muted">Still refundable: {bhd(remainingFils)}</p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Refunding..." : "Refund"}
            </button>
            <button type="button" className="dash-button" disabled={submitting} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="dash-button" onClick={openDrawer}>
            Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}
