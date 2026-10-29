import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";

const target = resolve("backups/yaadrakho-razorpay-migration-test.db");
await rm(target, { force: true });
const client = createClient({ url: `file:${target.replaceAll("\\", "/")}` });
const sql = await readFile(resolve("drizzle/0016_razorpay_payments.sql"), "utf8");
for (const statement of sql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
  await client.execute(statement);
}

for (const table of ["razorpay_orders", "razorpay_webhook_events"]) {
  const result = await client.execute({ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", args: [table] });
  assert.equal(String(result.rows[0]?.name), table);
}

await client.execute(`INSERT INTO razorpay_orders
  (owner_user_id, owner_key, customer_id, invoice_id, due_id, request_key, amount, currency,
   status, error_message, created_at, updated_at)
  VALUES (1, 'owner:a', 1, 1, 1, 'request-key-001', 500, 'INR', 'creating', '', 1, 1)`);
await assert.rejects(() => client.execute(`INSERT INTO razorpay_orders
  (owner_user_id, owner_key, customer_id, invoice_id, due_id, request_key, amount, currency,
   status, error_message, created_at, updated_at)
  VALUES (1, 'owner:a', 1, 1, 1, 'request-key-001', 500, 'INR', 'creating', '', 1, 1)`), /unique/i);
await assert.rejects(() => client.execute(`INSERT INTO razorpay_orders
  (owner_user_id, owner_key, customer_id, invoice_id, due_id, request_key, amount, currency,
   status, error_message, created_at, updated_at)
  VALUES (1, 'owner:a', 1, 1, 1, 'invalid-amount', 0, 'INR', 'creating', '', 1, 1)`), /check/i);

const integrity = await client.execute("PRAGMA integrity_check");
assert.equal(String(integrity.rows[0]?.integrity_check), "ok");
console.log(JSON.stringify({ result: "ok", migration: "razorpay payments" }));
await client.close();
