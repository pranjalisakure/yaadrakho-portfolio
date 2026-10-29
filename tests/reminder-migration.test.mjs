import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve("backups/yaadrakho-reminder-migration-test.db");
await rm(target, { force: true });
const client = createClient({ url: `file:${target.replaceAll("\\", "/")}` });

await client.execute(`CREATE TABLE push_delivery_slots (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  subscription_id integer NOT NULL,
  date_key text NOT NULL,
  delivery_slot text NOT NULL,
  sent_at integer NOT NULL,
  UNIQUE(subscription_id, date_key, delivery_slot)
)`);
await client.execute({
  sql: "INSERT INTO push_delivery_slots (subscription_id, date_key, delivery_slot, sent_at) VALUES (1, '2026-07-18', 'hour-09', 123)",
  args: [],
});

const migration = await readFile(new URL("../drizzle/0011_reliable_reminder_delivery.sql", import.meta.url), "utf8");
const statements = migration.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
for (const statement of statements) await client.execute(statement);

const preserved = await client.execute("SELECT COUNT(*) AS count FROM push_delivery_slots WHERE sent_at = 123");
assert.equal(Number(preserved.rows[0]?.count), 1, "existing reminder delivery history must be preserved");
const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('push_delivery_claims','push_delivery_items','reminder_job_runs') ORDER BY name");
assert.deepEqual(tables.rows.map((row) => String(row.name)), ["push_delivery_claims", "push_delivery_items", "reminder_job_runs"]);

console.log(JSON.stringify({ result: "ok", preservedSlots: 1, newTables: tables.rows.length }));
await client.close();
