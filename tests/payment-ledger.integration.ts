import assert from "node:assert/strict";
import { copyFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";

const source = resolve("backups/yaadrakho-db-pre-phase2-2026-07-17.db");
const target = resolve("backups/yaadrakho-db-phase2-test.db");
await rm(target, { force: true });
await copyFile(source, target);
process.env.TURSO_DATABASE_URL = `file:${target.replaceAll("\\", "/")}`;
delete process.env.TURSO_AUTH_TOKEN;

const { ensurePaymentLedgerTables, getClient } = await import("../db/index");
const { ensureCustomerCurrentDue, getCustomerLedger, getOwnerLedger, recordLedgerPayment } = await import("../db/payment-ledger");
const { getOwnerReceipt, getPublicReceipt, prepareReceiptDelivery } = await import("../db/payment-receipts");
await ensurePaymentLedgerTables();
const db = getClient();
const now = Date.now();
const suffix = String(now);

async function addUser(email: string, storageKey: string) {
  const result = await db.execute({ sql: `INSERT INTO users
    (email, display_name, storage_key, password_salt, password_hash, recovery_salt, recovery_hash, is_owner,
      email_verified_at, last_login_at, last_activity_at, created_at, updated_at)
    VALUES (?, 'Ledger Test', ?, 's', 'h', 's', 'h', 0, ?, NULL, NULL, ?, ?)`, args: [email, storageKey, now, now, now] });
  return { id: Number(result.lastInsertRowid), storageKey };
}

async function addCustomer(owner: { id: number; storageKey: string }, billingCycle: "one_time" | "monthly") {
  const result = await db.execute({ sql: `INSERT INTO customers
    (owner_email, owner_user_id, name, phone, requirement, amount, follow_up_date, status, payment_status,
      billing_cycle, recurring_day, notes, contact_consent, created_at, updated_at)
    VALUES (?, ?, 'Test Customer', '9999999999', 'Test fee', 1000, '2026-07-17', 'follow_up', 'pending', ?, 17, '', 1, ?, ?)`,
    args: [owner.storageKey, owner.id, billingCycle, now, now] });
  const id = Number(result.lastInsertRowid);
  await ensureCustomerCurrentDue(owner, id, db);
  return id;
}

const ownerA = await addUser(`phase2-a-${suffix}@example.test`, `phase2:a:${suffix}`);
const ownerB = await addUser(`phase2-b-${suffix}@example.test`, `phase2:b:${suffix}`);
const monthlyCustomer = await addCustomer(ownerA, "monthly");

const partialReceivedAt = now - 86_400_000;
const partial = await recordLedgerPayment(ownerA, monthlyCustomer, { amount: 400, method: "upi", reference: "UTR-TEST-400", receivedAt: partialReceivedAt, idempotencyKey: `partial-${suffix}` }, db);
assert.equal(partial.duplicate, false);
let ledger = await getCustomerLedger(ownerA, monthlyCustomer, db);
assert.equal(Number(ledger?.dues[0]?.amountPaid), 400, "partial payment must update paid amount");
assert.equal(String(ledger?.dues[0]?.status), "partial");
const partialTransaction = ledger?.transactions[0];
assert.ok(partialTransaction?.receiptNumber, "partial payment must create a receipt number");
assert.equal(String(partialTransaction?.receiptToken || "").length, 32, "receipt token must be secure and shareable");
assert.equal(Number(partialTransaction?.balanceAfter), 600);
assert.equal(Number(partialTransaction?.receivedAt), partialReceivedAt, "owner-selected payment date must persist");
const publicReceipt = await getPublicReceipt(String(partialTransaction?.receiptToken), db);
assert.equal(publicReceipt?.customerId, monthlyCustomer);
assert.equal(publicReceipt?.reference, "UTR-TEST-400");
assert.equal(await getOwnerReceipt(ownerB, Number(partialTransaction?.id), db), null, "another business cannot read the receipt by ID");
const preparedReceipt = await prepareReceiptDelivery(ownerA, Number(partialTransaction?.id), "https://yaadrakho-demo.vercel.app", db);
assert.match(preparedReceipt.receiptUrl, /^https:\/\/yaadrakho-demo\.vercel\.app\/receipt\//);
assert.match(preparedReceipt.whatsappUrl, /^https:\/\/wa\.me\/91/);

const duplicate = await recordLedgerPayment(ownerA, monthlyCustomer, { amount: 400, method: "upi", idempotencyKey: `partial-${suffix}` }, db);
assert.equal(duplicate.duplicate, true, "same idempotency key must not create another transaction");
ledger = await getCustomerLedger(ownerA, monthlyCustomer, db);
assert.equal(ledger?.transactions.length, 1);

await assert.rejects(() => recordLedgerPayment(ownerA, monthlyCustomer, { amount: 601, idempotencyKey: `over-${suffix}` }, db), /remaining amount/);
await assert.rejects(() => recordLedgerPayment(ownerB, monthlyCustomer, { amount: 1, idempotencyKey: `isolation-${suffix}` }, db), /Customer not found/);

await recordLedgerPayment(ownerA, monthlyCustomer, { amount: 600, method: "cash", idempotencyKey: `full-${suffix}` }, db);
ledger = await getCustomerLedger(ownerA, monthlyCustomer, db);
assert.equal(ledger?.transactions.length, 2);
assert.equal(Number(ledger?.transactions[0]?.balanceAfter), 0, "full payment receipt must show zero balance");
assert.equal(ledger?.dues.filter((due) => String(due.status) === "paid").length, 1);
assert.equal(ledger?.dues.filter((due) => String(due.status) === "pending").length, 1, "full monthly payment creates exactly one next due");

const ownerView = await getOwnerLedger(ownerA, db);
const customer = ownerView.customers.find((item) => item.id === monthlyCustomer);
assert.equal(customer?.outstandingAmount, 1000);
assert.equal(customer?.followUpDate, "2026-08-17");
assert.equal(ownerView.stats.monthly, 1);

const reopened = createClient({ url: process.env.TURSO_DATABASE_URL });
const persisted = await reopened.execute({ sql: "SELECT COUNT(*) AS count FROM payment_transactions WHERE owner_user_id = ? AND customer_id = ?", args: [ownerA.id, monthlyCustomer] });
assert.equal(Number(persisted.rows[0]?.count), 2, "transactions persist after reopening the database");
await reopened.close();

const backfill = await db.execute(`SELECT
  (SELECT COUNT(*) FROM customer_payments WHERE owner_user_id IS NOT NULL AND owner_email NOT LIKE 'phase2:%') AS legacy_payments,
  (SELECT COUNT(*) FROM payment_transactions WHERE idempotency_key LIKE 'legacy-customer-payment:%') AS backfilled_transactions,
  (SELECT COUNT(*) FROM payment_dues WHERE owner_key NOT LIKE 'phase2:%') AS backfilled_dues`);
console.log(JSON.stringify({ result: "ok", backfill: backfill.rows[0] }));
await db.close();
