import type { Pool } from "pg";
import type { EventType } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { ReportingConfig } from "../config.js";
import { readCursor, advanceCursor } from "./cursor.js";
import { applyEvent, type OutboxEventRow } from "./applyEvent.js";

export const REPORTING_EVENT_TYPES: readonly EventType[] = [
  "transaction.captured",
  "transaction.voided",
  "refund.succeeded",
  "settlement.batch_closed",
];

/**
 * Outbox ids are taken when a row is inserted, not when its transaction
 * commits, so a slow writer (CloseBatch) can commit id 100 after id 101 is
 * already visible. Consuming by `id > cursor` would then skip 100 forever.
 * Only rows older than config.commitOrderSafetyLagMs are consumed, which
 * gives in-flight writers time to commit before the cursor passes them
 * (10s in production, 0 by default — see config.ts).
 */

/**
 * Keys this worker's row in reporting_outbox_cursor. Two processes using the
 * same name serialize on that row, so a catch-up run beside a live worker
 * cannot apply an event twice.
 */
export const CONSUMER_NAME = "reporting";

/**
 * The one function both the NOTIFY handler and the poll timer call.
 * Everything — the read of due outbox_events, every rollup
 * upsert `applyEvent` performs, and the watermark advance — happens inside
 * one `withTransaction` call: either the whole batch of up-to-
 * `consumerBatchLimit` events is applied *and* the watermark moves past all
 * of them, atomically, or (on any error) nothing in this pass is applied
 * and the watermark is untouched — the next pass simply re-selects the
 * identical event range and retries. This is the exact property that makes
 * the watermark alone sufficient for exactly-once application, with no
 * separate per-event dedup table the way webhook_deliveries needs one.
 *
 * The `SELECT` below is a plain, unlocked read — no row lock, no
 * `FOR UPDATE`, no mutation of any outbox_events column — identical
 * posture to webhooks/dispatcher.ts's Step A.
 */
export async function runConsumerPass(
  pool: Pool,
  config: Pick<ReportingConfig, "consumerBatchLimit" | "commitOrderSafetyLagMs">,
): Promise<{ processedCount: number }> {
  const lagMs = config.commitOrderSafetyLagMs ?? 0;
  return withTransaction(pool, async (client) => {
    const cursor = await readCursor(client, CONSUMER_NAME);

    const eventsResult = await client.query<OutboxEventRow>(
      `SELECT id, event_type, aggregate_id, payload, created_at
         FROM outbox_events
        WHERE id > $1
          AND event_type = ANY($2::text[])
          AND created_at <= now() - ($4::int * interval '1 millisecond')
        ORDER BY id ASC
        LIMIT $3`,
      [cursor.lastProcessedId.toString(), REPORTING_EVENT_TYPES, config.consumerBatchLimit, lagMs],
    );

    // FH: redundant with ORDER BY id ASC (last row is max). harmless
    let maxId = cursor.lastProcessedId;
    for (const row of eventsResult.rows) {
      await applyEvent(client, row);
      const rowId = BigInt(row.id);
      if (rowId > maxId) maxId = rowId;
    }

    if (eventsResult.rows.length > 0) {
      await advanceCursor(client, CONSUMER_NAME, maxId);
    }

    return { processedCount: eventsResult.rows.length };
  });
}
