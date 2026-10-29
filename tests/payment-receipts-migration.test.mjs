import assert from "node:assert/strict";
import { copyFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";

const source = resolve("backups/yaadrakho-db-pre-phase2-2026-07-17.db");
const target = resolve("backups/yaadrakho-db-receipts-migration-test.db");
await rm(target, { force: true });
await copyFile(source, target);
const client = createClient({ url: `file:${target.replaceAll("\\", "/")}` });
for (const migration of ["drizzle/0009_payment_ledger.sql", "drizzle/0018_payment_receipts.sql"]) {
  const sql = await readFile(resolve(migration), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
    await client.execute(statement);
  }
}
const integrity = await client.execute("PRAGMA integrity_check");
assert.equal(String(integrity.rows[0]?.integrity_check), "ok");
const columns = await client.execute("PRAGMA table_info(payment_transactions)");
for (const name of ["receipt_number", "receipt_token", "balance_after"]) {
  assert.ok(columns.rows.some((row) => row.name === name), `${name} column must exist`);
}
const result = await client.execute(`SELECT COUNT(*) AS total,
  SUM(CASE WHEN receipt_number IS NOT NULL AND receipt_token IS NOT NULL AND balance_after IS NOT NULL THEN 1 ELSE 0 END) AS backfilled,
  COUNT(DISTINCT receipt_number) AS unique_numbers,
  COUNT(DISTINCT receipt_token) AS unique_tokens
  FROM payment_transactions`);
const row = result.rows[0];
assert.equal(Number(row?.backfilled), Number(row?.total), "every old payment must receive receipt metadata");
assert.equal(Number(row?.unique_numbers), Number(row?.total), "receipt numbers must be unique");
assert.equal(Number(row?.unique_tokens), Number(row?.total), "receipt tokens must be unique");
console.log(JSON.stringify({ result: "ok", receipts: row }));
await client.close();
