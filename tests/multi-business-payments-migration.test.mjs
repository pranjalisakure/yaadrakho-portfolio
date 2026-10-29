import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";

const target = resolve("backups/yaadrakho-multi-business-migration-test.db");
await rm(target, { force: true });
const client = createClient({ url: `file:${target.replaceAll("\\", "/")}` });

for (const file of ["drizzle/0016_razorpay_payments.sql", "drizzle/0017_multi_business_payments.sql"]) {
  const sql = await readFile(resolve(file), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
    await client.execute(statement);
  }
}

const table = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'business_payment_accounts'");
assert.equal(String(table.rows[0]?.name), "business_payment_accounts");
const columns = await client.execute("PRAGMA table_info(razorpay_orders)");
for (const name of ["payment_account_id", "provider_account_id", "transfer_id", "transfer_status", "transfer_error"]) {
  assert.equal(columns.rows.some((column) => String(column.name) === name), true, `missing ${name}`);
}

await client.execute(`INSERT INTO business_payment_accounts
  (owner_user_id, owner_key, provider, mode, provider_account_id, status, created_at, updated_at)
  VALUES (1, 'owner:a', 'razorpay_route', 'test', 'acc_TestOwnerA123', 'active', 1, 1)`);
await assert.rejects(() => client.execute(`INSERT INTO business_payment_accounts
  (owner_user_id, owner_key, provider, mode, provider_account_id, status, created_at, updated_at)
  VALUES (1, 'owner:a', 'razorpay_route', 'test', 'acc_TestOwnerB123', 'active', 1, 1)`), /unique/i);
await assert.rejects(() => client.execute(`INSERT INTO business_payment_accounts
  (owner_user_id, owner_key, provider, mode, provider_account_id, status, created_at, updated_at)
  VALUES (2, 'owner:b', 'razorpay_route', 'test', 'acc_TestOwnerA123', 'active', 1, 1)`), /unique/i);

const integrity = await client.execute("PRAGMA integrity_check");
assert.equal(String(integrity.rows[0]?.integrity_check), "ok");
console.log(JSON.stringify({ result: "ok", migration: "multi-business-payments" }));
await client.close();
