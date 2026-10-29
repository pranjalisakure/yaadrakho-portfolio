import assert from "node:assert/strict";
import { copyFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";

const source = resolve("backups/yaadrakho-db-pre-phase2-2026-07-17.db");
const target = resolve("backups/yaadrakho-db-phase2-migration-test.db");
await rm(target, { force: true });
await copyFile(source, target);
const client = createClient({ url: `file:${target.replaceAll("\\", "/")}` });
const sql = await readFile(resolve("drizzle/0009_payment_ledger.sql"), "utf8");
for (const statement of sql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
  await client.execute(statement);
}
const integrity = await client.execute("PRAGMA integrity_check");
assert.equal(String(integrity.rows[0]?.integrity_check), "ok");
const columns = await client.execute("PRAGMA table_info(customers)");
assert.ok(columns.rows.some((row) => row.name === "owner_user_id"));
assert.ok(columns.rows.some((row) => row.name === "current_due_id"));
const counts = await client.execute(`SELECT
  (SELECT COUNT(*) FROM customer_payments) AS legacy_payments,
  (SELECT COUNT(*) FROM payment_transactions WHERE idempotency_key LIKE 'legacy-customer-payment:%') AS backfilled_transactions,
  (SELECT COUNT(*) FROM payment_dues) AS backfilled_dues`);
assert.equal(Number(counts.rows[0]?.legacy_payments), Number(counts.rows[0]?.backfilled_transactions));
assert.ok(Number(counts.rows[0]?.backfilled_dues) >= Number(counts.rows[0]?.legacy_payments));
console.log(JSON.stringify({ result: "ok", counts: counts.rows[0] }));
await client.close();
