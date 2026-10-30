#!/usr/bin/env -S npx tsx
/**
 * CLI entry point: generate() the deterministic seed, then run every
 * self-verify assertion against it. Exits non-zero iff any REAL assertion
 * fails.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx db/seed/index.ts
 */
import { Pool } from "pg";
import { generate } from "./generate.js";
import { buildAssertions, runAssertions } from "./selfVerify.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("seed: DATABASE_URL environment variable is not set");
  }

  // SEED_SIZE accepts small | full, but only 'small' is really implemented
  // so far — 'full' currently generates the same data.
  const seedSize = process.env.SEED_SIZE ?? "small";
  if (seedSize !== "small" && seedSize !== "full") {
    throw new Error(`seed: SEED_SIZE must be 'small' or 'full', got '${seedSize}'`);
  }

  // A Pool (not a bare Client): generate() needs its own checked-out client
  // for the main truncate+insert transaction, and needs the pool again
  // afterward for recordKycReview()/issueApiKey(), which open their own
  // transactions once that first one has committed and released.
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });

  try {
    // generate() runs TRUNCATE ... RESTART IDENTITY CASCADE over every core
    // table — effectively the whole database, not "its own fixture tables"
    // as the old compose/RUNBOOK notes claimed. Refuse to do that to a
    // database that already holds merchants unless explicitly told to.
    const existing = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM merchants`);
    if (Number(existing.rows[0]?.n ?? 0) > 0 && process.env.SEED_ALLOW_WIPE !== "yes") {
      throw new Error(
        "seed: refusing to run — this database already has merchants and the seed TRUNCATEs every table. " +
          "Set SEED_ALLOW_WIPE=yes only for a disposable database.",
      );
    }

    const summary = await generate(pool);
    console.log(
      `seed: generated ${summary.merchantCount} merchants, ${summary.merchantUserCount} merchant_users, ` +
        `${summary.transactionCount} transactions, ${summary.ledgerEntryCount} ledger_entries ` +
        `(${summary.ledgerGroupCount} groups), ${summary.holdCount} holds, ` +
        `${summary.settlementBatchCount} settlement_batches, ${summary.schemeExportLineCount} scheme_export_lines, ` +
        `${summary.outboxEventCount} outbox_events, ${summary.transactionEventCount} transaction_events, ` +
        `${summary.splitChildCount} merchant_split_children, ${summary.feeScheduleCount} fee_schedules, ` +
        `${summary.businessProfileCount} business_profiles, ` +
        `${summary.kycReviewCount} kyc_reviews, ${summary.apiKeyCount} api_keys, ` +
        `${summary.adminUserCount} admin_users`,
    );
    console.log(`seed: ledger_entries checksum = ${summary.ledgerChecksum}`);
    console.log("");

    const assertions = buildAssertions(pool, { initialLedgerChecksum: summary.ledgerChecksum });
    const allRealPassed = await runAssertions(assertions);

    if (!allRealPassed) {
      console.error("\nseed: one or more REAL assertions failed");
      process.exitCode = 1;
    } else {
      console.log("\nseed: all REAL assertions passed");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
