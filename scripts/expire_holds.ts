#!/usr/bin/env -S npx tsx
/**
 * Nightly janitor: a hold that's never captured or released sits 'active'
 * past its expires_at forever. This flips such holds to 'expired' with ONE
 * conditional UPDATE. Holds are never deleted (0005 has an 'expired' status
 * for exactly this; HANDOVER: "Holds are never deleted").
 *
 * The previous version SELECTed the expired ids and then DELETEd by id:
 *   - on a night with nothing expired the id list was empty, buildWhere
 *     dropped the empty filter, and the statement became
 *     `DELETE FROM holds` — every hold, active ones included;
 *   - even on a normal night it destroyed hold history, and a hold captured
 *     between the SELECT and the DELETE was deleted anyway.
 * The single UPDATE re-checks status and expiry at write time, so it is
 * race-free and a no-op when nothing has expired.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/expire_holds.ts
 */
import { pathToFileURL } from "node:url";
import { Client } from "pg";

export const EXPIRE_HOLDS_SQL =
  "UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now()";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("expire_holds: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(EXPIRE_HOLDS_SQL);
    console.log(`expire_holds: marked ${result.rowCount ?? 0} abandoned hold(s) expired`);
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
