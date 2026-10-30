export function buildWhere(
  filters: Record<string, unknown>,
): { clause: string; values: unknown[]; paramOffset: number } {
  const parts: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const [col, val] of Object.entries(filters)) {
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) {
      if (val.length === 0) continue;
      values.push(val);
      parts.push(`${col} = ANY($${idx}::uuid[])`);
      idx++;
    } else {
      values.push(val);
      parts.push(`${col} = $${idx}`);
      idx++;
    }
  }
  const clause = parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "";
  return { clause, values, paramOffset: idx };
}

export function buildDelete(
  table: string,
  filters: Record<string, unknown>,
): { text: string; values: unknown[] } {
  const { clause, values } = buildWhere(filters);
  // buildWhere silently drops empty/undefined filters. For a DELETE that
  // turns "delete these zero rows" into "delete every row" — which is what
  // expire_holds did on any night with nothing expired.
  if (clause === "") {
    throw new Error(`buildDelete: refusing to delete from ${table} without a WHERE clause`);
  }
  return { text: `DELETE FROM ${table} ${clause}`, values };
}
