import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";

const target = resolve("backups/yaadrakho-customer-duplicates-migration-test.db");
await rm(target, { force: true });
const client = createClient({ url: `file:${target.replaceAll("\\", "/")}` });
await client.execute(`CREATE TABLE customers (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  owner_user_id integer,
  phone text NOT NULL
)`);
await client.execute("INSERT INTO customers (owner_user_id, phone) VALUES (1, '98765 43210'), (1, '+91 98765 43210')");
const sql = await readFile(resolve("drizzle/0012_customer_phone_identity.sql"), "utf8");
for (const statement of sql.split("--> statement-breakpoint").map((item) => item.trim()).filter(Boolean)) {
  await client.execute(statement);
}
const columns = await client.execute("PRAGMA table_info(customers)");
assert.ok(columns.rows.some((row) => row.name === "phone_key"));
await client.execute("UPDATE customers SET phone_key = '9876543210' WHERE id = 1");
await assert.rejects(
  () => client.execute("UPDATE customers SET phone_key = '9876543210' WHERE id = 2"),
  /unique/i,
  "database index must prevent two normalized phones in one business",
);
const integrity = await client.execute("PRAGMA integrity_check");
assert.equal(String(integrity.rows[0]?.integrity_check), "ok");
console.log(JSON.stringify({ result: "ok", migration: "customer phone identity" }));
await client.close();
