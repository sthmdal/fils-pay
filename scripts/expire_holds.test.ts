import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPIRE_HOLDS_SQL } from "./expire_holds.js";
import { buildDelete } from "./lib/sqlFilter.js";

test("expiring holds is an UPDATE to 'expired', never a DELETE", () => {
  assert.match(EXPIRE_HOLDS_SQL, /^UPDATE holds SET status = 'expired'/);
  assert.doesNotMatch(EXPIRE_HOLDS_SQL, /DELETE/i);
});

test("only active, past-expiry holds are touched", () => {
  assert.match(EXPIRE_HOLDS_SQL, /WHERE status = 'active' AND expires_at < now\(\)$/);
});

// The old bug: an empty id list made buildDelete emit `DELETE FROM holds`.
test("buildDelete refuses to emit a DELETE with no WHERE clause", () => {
  assert.throws(() => buildDelete("holds", { id: [] }), /refusing/);
  assert.throws(() => buildDelete("holds", {}), /refusing/);
});

test("buildDelete still scopes a non-empty filter", () => {
  const { text, values } = buildDelete("holds", { id: ["11111111-1111-1111-1111-111111111111"] });
  assert.equal(text, "DELETE FROM holds WHERE id = ANY($1::uuid[])");
  assert.equal((values[0] as string[]).length, 1);
});
