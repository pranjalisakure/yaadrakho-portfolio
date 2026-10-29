import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve("backups/yaadrakho-phase9-regression-test.db");
await rm(target, { force: true });
process.env.TURSO_DATABASE_URL = `file:${target.replaceAll("\\", "/")}`;
delete process.env.TURSO_AUTH_TOKEN;
process.env.RAZORPAY_ENABLED = "true";
process.env.RAZORPAY_KEY_ID = "rzp_test_yaadrakho";
process.env.RAZORPAY_KEY_SECRET = "razorpay-test-secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "webhook-test-secret";
process.env.RAZORPAY_ALLOW_LIVE = "false";

const { ensureRazorpayTables, getClient } = await import("../db/index");
const { createInvoice, getInvoice, saveCatalogProducts } = await import("../db/sales-billing");
const {
  finalizeCapturedRazorpayPayment,
  createOnlinePaymentOrder,
} = await import("../db/razorpay");

await ensureRazorpayTables();
const db = getClient();
const now = Date.now();
const userInsert = await db.execute({
  sql: `INSERT INTO users
    (email, display_name, storage_key, password_salt, password_hash, recovery_salt, recovery_hash, is_owner,
     email_verified_at, last_login_at, last_activity_at, created_at, updated_at)
    VALUES ('razorpay@example.test', 'Razorpay Shop', 'owner:razorpay', 's', 'h', 's', 'h', 0, ?, NULL, NULL, ?, ?)`,
  args: [now, now, now],
});
const owner = { id: Number(userInsert.lastInsertRowid), storageKey: "owner:razorpay", displayName: "Razorpay Shop" };
await db.execute({
  sql: "INSERT INTO app_settings (user_email, business_name, phone, updated_at) VALUES (?, 'Razorpay Shop', '9999900001', ?)",
  args: [owner.storageKey, now],
});
const customerInsert = await db.execute({
  sql: `INSERT INTO customers
    (owner_email, owner_user_id, name, phone, requirement, amount, follow_up_date, status, payment_status,
     billing_cycle, recurring_day, notes, contact_consent, created_at, updated_at)
    VALUES (?, ?, 'Online Customer', '9999911111', '', 0, '2026-07-30', 'new', 'pending',
      'one_time', 30, '', 1, ?, ?)`,
  args: [owner.storageKey, owner.id, now, now],
});
const customerId = Number(customerInsert.lastInsertRowid);
await saveCatalogProducts(owner, [{ name: "Service Plan", price: 1000, gstRate: 0, unit: "service" }], db);
const productResult = await db.execute({
  sql: "SELECT id FROM product_catalog WHERE owner_user_id = ? AND name_key = 'service plan'",
  args: [owner.id],
});
const bill = await createInvoice(owner, {
  customerId,
  idempotencyKey: "razorpay-bill-0001",
  issueDate: "2026-07-30",
  dueDate: "2026-07-30",
  lines: [{ productId: Number(productResult.rows[0]?.id), quantity: 1 }],
}, db);


const { updateCustomerDetails } = await import("../db/customer-update");
const { recordLedgerPayment, ensureCustomerCurrentDue } = await import("../db/payment-ledger");
const { deleteWithPaymentGuard } = await import("../db/payment-deletion");
const { paymentReceivedAt } = await import("../app/payment-date");
const { getAdminOverview } = await import("../db/admin-analytics");
const morning = Date.parse("2026-09-17T09:00:00+05:30");
assert.equal(paymentReceivedAt("2026-09-17", morning), morning, "today must not become a future noon timestamp");
assert.equal(paymentReceivedAt("2026-09-16", morning), Date.parse("2026-09-16T12:00:00+05:30"));
assert.throws(() => paymentReceivedAt("2026-09-18", morning), /earlier/);
assert.throws(() => paymentReceivedAt("2026-02-30", morning), /valid/);

const bill2 = await createInvoice(owner, { customerId, idempotencyKey: "phase9-second-invoice", issueDate: "2026-07-30", dueDate: "2026-07-30", lines: [{ productId: Number(productResult.rows[0].id), quantity: 1 }] }, db);
let requests = 0;
const orderFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
  requests++;
  const payload = JSON.parse(String(init?.body));
  return Response.json({ id: "order_phase9_" + requests, amount: payload.amount, currency: "INR" });
}) as typeof fetch;
const order = await createOnlinePaymentOrder(bill.publicToken, 1000, "phase9-original-order", db, orderFetch);
const reused = await createOnlinePaymentOrder(bill.publicToken, 1000, "phase9-another-browser", db, orderFetch);
assert.equal(order.orderId, reused.orderId);
assert.equal(requests, 1, "same bill and amount reuse the open provider order");
await assert.rejects(() => createOnlinePaymentOrder(bill.publicToken, 500, "phase9-competing-order", db, orderFetch), /Another payment attempt/);
await assert.rejects(() => createOnlinePaymentOrder(bill2.publicToken, 1000, "phase9-original-order", db, orderFetch), /another bill/);
await assert.rejects(() => deleteWithPaymentGuard(owner.id, customerId, []), /online payment/);
const details = (await db.execute({sql: "SELECT * FROM customers WHERE id = ?", args:[customerId]})).rows[0];
await assert.rejects(() => updateCustomerDetails(owner, customerId, { name: "Must roll back", amount: 2000 }, db), /Issued bill/);
assert.equal((await db.execute({sql: "SELECT name FROM customers WHERE id = ?", args:[customerId]})).rows[0].name, "Online Customer");
await updateCustomerDetails(owner, customerId, { name: "Updated name", amount: Number(details.amount), followUpDate: String(details.follow_up_date) }, db);
assert.equal(Number((await getInvoice(owner, bill2.id, db))?.invoice.totalAmount), 1000);
await assert.rejects(() => updateCustomerDetails({id: owner.id + 1, storageKey: "wrong"}, customerId, {name: "Wrong owner"}, db), /not found/);
await assert.rejects(() => updateCustomerDetails(owner, customerId, {followUpDate: "2026-02-30"}, db), /valid due date/);
const dueId = Number((await getInvoice(owner, bill.id, db))!.invoice.dueId);
const due2Id = Number((await getInvoice(owner, bill2.id, db))!.invoice.dueId);
await recordLedgerPayment(owner, customerId, {amount: 1000, dueId, method: "cash", idempotencyKey: "phase9-offline-payment"}, db);
await assert.rejects(() => recordLedgerPayment(owner, customerId, {amount: 1000, dueId: due2Id, idempotencyKey: "phase9-offline-payment"}, db), /different customer, due, or amount/);
const capture = {id: "pay_phase9_late", order_id: order.orderId, amount: 100000, currency: "INR", status: "captured", captured: true, method: "upi"};
const reviewed = await finalizeCapturedRazorpayPayment(order.orderId, capture, db);
assert.equal(reviewed.paid, false);
assert.ok("reconciliationRequired" in reviewed);
assert.equal(reviewed.reconciliationRequired, true);
await finalizeCapturedRazorpayPayment(order.orderId, capture, db);
assert.equal(Number((await getInvoice(owner, bill.id, db))?.invoice.amountPaid), 1000);
assert.equal((await db.execute("SELECT status FROM razorpay_captures WHERE payment_id = 'pay_phase9_late'")).rows[0].status, "needs_review");
assert.equal((await getAdminOverview()).paymentReviews[0].payment_id, "pay_phase9_late");
await assert.rejects(() => deleteWithPaymentGuard(owner.id, null, []), /online payment/);

// Reproduce the modern monthly mirror row, then initialize in a separate process.
const monthlyInsert = await db.execute({sql: "INSERT INTO customers (owner_email, owner_user_id, name, phone, requirement, amount, follow_up_date, status, payment_status, billing_cycle, recurring_day, notes, contact_consent, created_at, updated_at) VALUES (?, ?, 'Monthly', '9999922222', '', 100, '2026-08-17', 'follow_up', 'pending', 'monthly', 17, '', 0, ?, ?)", args: [owner.storageKey, owner.id, now, now]});
const monthlyId = Number(monthlyInsert.lastInsertRowid);
await ensureCustomerCurrentDue(owner, monthlyId, db);
await recordLedgerPayment(owner, monthlyId, {amount: 40, idempotencyKey: "phase9-monthly-partial"}, db);
await recordLedgerPayment(owner, monthlyId, {amount: 60, idempotencyKey: "phase9-monthly-final"}, db);
const before = await db.execute("SELECT COUNT(*) AS count, SUM(amount) AS amount FROM payment_transactions");
const dueCount = await db.execute({sql: "SELECT COUNT(*) AS count FROM payment_dues WHERE customer_id = ?", args: [customerId]});
const restart = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "const {ensureRazorpayTables,getClient}=await import('./db/index.ts'); await ensureRazorpayTables(); await getClient().close();"], {env: process.env, encoding: "utf8"});
assert.equal(restart.status, 0, restart.stderr);
const after = await db.execute("SELECT COUNT(*) AS count, SUM(amount) AS amount FROM payment_transactions");
assert.deepEqual(after.rows, before.rows, "initialization must not duplicate modern monthly transactions");
assert.equal(Number((await db.execute({sql: "SELECT COUNT(*) AS count FROM payment_dues WHERE customer_id = ?", args: [customerId]})).rows[0].count), Number(dueCount.rows[0].count), "invoice-only customer must not gain a phantom one-time due");
assert.equal((await db.execute("SELECT status FROM razorpay_captures WHERE payment_id = 'pay_phase9_late'")).rows[0].status, "needs_review");
console.log(JSON.stringify({result: "ok", phase: 9, checks: "checkout reservations, cross-bill keys, captured-payment review, issued-bill protection, monthly restart, payment dates, deletion guard"}));
const { registerUser, deleteAccount } = await import("../app/auth");
const { user: deleteUser } = await registerUser({email: "phase9-delete@example.test", displayName: "Delete test", password: "local-test-only-password"});
await db.execute({sql: "INSERT INTO app_settings (user_email, business_name, phone, updated_at) VALUES (?, 'Delete test', '', ?)", args: [deleteUser.storageKey, now]});
await db.execute({sql: "INSERT INTO subscriptions (user_email, plan, status, price, trial_ends_at, updated_at) VALUES (?, 'trial', 'trial', 0, ?, ?)", args: [deleteUser.storageKey, now, now]});
await getClient().execute({sql:"INSERT INTO email_reset_challenges(challenge_hash,user_id,otp_hash,password_version,expires_at) VALUES ('cleanup-test',?,'hash','version',?)",args:[deleteUser.id,Date.now()+600000]});
assert.equal(await deleteAccount(deleteUser, "incorrect"), false);
assert.equal(await deleteAccount(deleteUser, "local-test-only-password"), true);
assert.equal((await getClient().execute("SELECT * FROM email_reset_challenges WHERE challenge_hash='cleanup-test'")).rows.length,0);
assert.equal((await db.execute({sql: "SELECT user_email FROM app_settings WHERE user_email = ?", args: [deleteUser.storageKey]})).rows.length, 0);
assert.equal((await db.execute({sql: "SELECT user_email FROM subscriptions WHERE user_email = ?", args: [deleteUser.storageKey]})).rows.length, 0);
assert.equal((await db.execute({sql: "SELECT user_email FROM app_settings WHERE user_email = ?", args: [owner.storageKey]})).rows.length, 1, "other business settings must survive");
await db.close();
