import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";

const target = resolve("backups/yaadrakho-billing-migration-test.db");
await rm(target, { force: true });
const client = createClient({ url: `file:${target.replaceAll("\\", "/")}` });
for (const migration of ["drizzle/0013_billing_demo.sql", "drizzle/0014_exact_billing_flow.sql", "drizzle/0015_invoice_idempotency.sql"]) {
  const sql = await readFile(resolve(migration), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) await client.execute(statement);
}
for (const table of ["product_catalog", "invoice_sequences", "invoices", "invoice_items", "invoice_deliveries"]) {
  const result = await client.execute({ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", args: [table] });
  assert.equal(String(result.rows[0]?.name), table);
}
await client.execute(`INSERT INTO product_catalog
  (owner_user_id, owner_key, name, name_key, price, gst_rate, unit, created_at, updated_at)
  VALUES (1, 'a', 'Rice', 'rice', 100, 5, 'kg', 1, 1)`);
await assert.rejects(() => client.execute(`INSERT INTO product_catalog
  (owner_user_id, owner_key, name, name_key, price, gst_rate, unit, created_at, updated_at)
  VALUES (1, 'a', 'RICE', 'rice', 110, 5, 'kg', 1, 1)`), /unique/i);
await client.execute(`INSERT INTO invoices
  (owner_user_id, owner_key, customer_id, due_id, invoice_number, idempotency_key, billing_mode, issue_date, due_date,
   subtotal, discount_amount, tax_amount, total_amount, amount_paid, status, notes, public_token, created_at, updated_at)
  VALUES (1, 'a', 1, NULL, 'YR-2026-000001', 'same-request-0001', 'separate', '2026-07-22', '2026-07-22',
   100, 0, 5, 105, 0, 'issued', '', 'token-1', 1, 1)`);
await assert.rejects(() => client.execute(`INSERT INTO invoices
  (owner_user_id, owner_key, customer_id, due_id, invoice_number, idempotency_key, billing_mode, issue_date, due_date,
   subtotal, discount_amount, tax_amount, total_amount, amount_paid, status, notes, public_token, created_at, updated_at)
  VALUES (1, 'a', 1, NULL, 'YR-2026-000002', 'same-request-0001', 'separate', '2026-07-22', '2026-07-22',
   100, 0, 5, 105, 0, 'issued', '', 'token-2', 1, 1)`), /unique/i);
const integrity = await client.execute("PRAGMA integrity_check");
assert.equal(String(integrity.rows[0]?.integrity_check), "ok");
console.log(JSON.stringify({ result: "ok", migration: "billing demo" }));
await client.close();
