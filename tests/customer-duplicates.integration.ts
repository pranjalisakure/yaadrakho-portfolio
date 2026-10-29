import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve("backups/yaadrakho-customer-duplicates-test.db");
await rm(target, { force: true });
process.env.TURSO_DATABASE_URL = `file:${target.replaceAll("\\", "/")}`;
delete process.env.TURSO_AUTH_TOKEN;

const { ensurePaymentLedgerTables, getClient } = await import("../db/index");
const { backfillCustomerPhoneKeys, normalizeCustomerPhone } = await import("../db/customer-identity");
const { getOwnerLedger } = await import("../db/payment-ledger");
await ensurePaymentLedgerTables();
const db = getClient();
const now = Date.now();

async function addUser(label: string) {
  const storageKey = `duplicates:${label}`;
  const result = await db.execute({
    sql: `INSERT INTO users
      (email, display_name, storage_key, password_salt, password_hash, recovery_salt, recovery_hash, is_owner,
        email_verified_at, last_login_at, last_activity_at, created_at, updated_at)
      VALUES (?, ?, ?, 's', 'h', 's', 'h', 0, ?, NULL, NULL, ?, ?)`,
    args: [`${label}@example.test`, label, storageKey, now, now, now],
  });
  return { id: Number(result.lastInsertRowid), storageKey };
}

async function addCustomer(owner: { id: number; storageKey: string }, phone: string, phoneKey: string | null) {
  return db.execute({
    sql: `INSERT INTO customers
      (owner_email, owner_user_id, phone_key, name, phone, requirement, amount, follow_up_date, status,
        payment_status, billing_cycle, recurring_day, notes, contact_consent, created_at, updated_at)
      VALUES (?, ?, ?, 'Same Customer', ?, 'Mess fee', 700, '2026-07-19', 'new', 'pending', 'monthly', 19, '', 1, ?, ?)`,
    args: [owner.storageKey, owner.id, phoneKey, phone, now, now],
  });
}

assert.equal(normalizeCustomerPhone("+91 98765-43210"), "9876543210");
assert.equal(normalizeCustomerPhone("09876543210"), "9876543210");

const ownerA = await addUser("owner-a");
const ownerB = await addUser("owner-b");
const phoneKey = normalizeCustomerPhone("98765 43210");
await addCustomer(ownerA, "98765 43210", phoneKey);
await assert.rejects(
  () => addCustomer(ownerA, "+91 98765 43210", phoneKey),
  /unique/i,
  "same normalized phone must be blocked inside one business",
);
await addCustomer(ownerB, "+91 98765 43210", phoneKey);

const legacyOwner = await addUser("legacy-owner");
await addCustomer(legacyOwner, "9999900001", null);
await addCustomer(legacyOwner, "+91 95451 81728", null);
const backfill = await backfillCustomerPhoneKeys(db, legacyOwner.id);
assert.equal(backfill.updated, 1);
assert.equal(backfill.duplicates, 1);
const legacyRows = await db.execute({
  sql: "SELECT COUNT(phone_key) AS identified, COUNT(*) AS total FROM customers WHERE owner_user_id = ?",
  args: [legacyOwner.id],
});
assert.equal(Number(legacyRows.rows[0]?.identified), 1);
assert.equal(Number(legacyRows.rows[0]?.total), 2);
const ledger = await getOwnerLedger(legacyOwner, db);
assert.equal(ledger.customers.filter((customer) => customer.duplicateOfId).length, 1, "existing duplicate must be visibly identified");

console.log(JSON.stringify({ result: "ok", tenantIsolation: true, existingDuplicatesFound: backfill.duplicates }));
await db.close();
