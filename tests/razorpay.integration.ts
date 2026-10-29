import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve("backups/yaadrakho-razorpay-integration-test.db");
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
  createOnlinePaymentOrder,
  fallbackWebhookEventId,
  verifyAndFinalizeCheckout,
  verifyCheckoutSignature,
  verifyWebhookSignature,
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

let remoteOrderCount = 0;
const orderFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body || "{}")) as { amount?: number; currency?: string };
  remoteOrderCount += 1;
  assert.equal(body.currency, "INR");
  return Response.json({ id: `order_test_${remoteOrderCount}`, amount: body.amount, currency: body.currency });
}) as typeof fetch;

const partialOrder = await createOnlinePaymentOrder(
  bill.publicToken,
  400,
  "razorpay-request-partial-0001",
  db,
  orderFetch,
);
assert.equal(partialOrder.amountPaise, 40000);
assert.equal(partialOrder.orderId, "order_test_1");
const repeatedOrder = await createOnlinePaymentOrder(
  bill.publicToken,
  400,
  "razorpay-request-partial-0001",
  db,
  orderFetch,
);
assert.equal(repeatedOrder.orderId, partialOrder.orderId);
assert.equal(remoteOrderCount, 1, "same request key must not create another Razorpay order");
await assert.rejects(() => createOnlinePaymentOrder(
  bill.publicToken,
  1001,
  "razorpay-request-overpay-0001",
  db,
  orderFetch,
), /cannot exceed/);

const partialPaymentId = "pay_partial_001";
const partialSignature = createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
  .update(`${partialOrder.orderId}|${partialPaymentId}`).digest("hex");
assert.equal(verifyCheckoutSignature(partialOrder.orderId, partialPaymentId, partialSignature, process.env.RAZORPAY_KEY_SECRET), true);
assert.equal(verifyCheckoutSignature(partialOrder.orderId, partialPaymentId, "00", process.env.RAZORPAY_KEY_SECRET), false);
const partialPaymentFetch = (async () => Response.json({
  id: partialPaymentId,
  order_id: partialOrder.orderId,
  amount: 40000,
  currency: "INR",
  status: "captured",
  captured: true,
  method: "upi",
})) as typeof fetch;
await verifyAndFinalizeCheckout(partialOrder.orderId, partialPaymentId, partialSignature, db, partialPaymentFetch);
await verifyAndFinalizeCheckout(partialOrder.orderId, partialPaymentId, partialSignature, db, partialPaymentFetch);
let invoice = await getInvoice(owner, bill.id, db);
assert.equal(String(invoice?.invoice.status), "partial");
assert.equal(Number(invoice?.invoice.amountPaid), 400);
assert.equal(invoice?.transactions.length, 1, "repeated verification must not duplicate the ledger transaction");

const finalOrder = await createOnlinePaymentOrder(
  bill.publicToken,
  600,
  "razorpay-request-final-00001",
  db,
  orderFetch,
);
const finalPaymentId = "pay_final_001";
const finalSignature = createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
  .update(`${finalOrder.orderId}|${finalPaymentId}`).digest("hex");
const finalPaymentFetch = (async () => Response.json({
  id: finalPaymentId,
  order_id: finalOrder.orderId,
  amount: 60000,
  currency: "INR",
  status: "captured",
  captured: true,
  method: "wallet",
  wallet: "paytm",
})) as typeof fetch;
await verifyAndFinalizeCheckout(finalOrder.orderId, finalPaymentId, finalSignature, db, finalPaymentFetch);
invoice = await getInvoice(owner, bill.id, db);
assert.equal(String(invoice?.invoice.status), "paid");
assert.equal(Number(invoice?.invoice.amountPaid), 1000);
assert.equal(invoice?.transactions.length, 2);
assert.equal(String(invoice?.transactions[0]?.method), "upi");
assert.equal(String(invoice?.transactions[1]?.method), "paytm");
await assert.rejects(() => createOnlinePaymentOrder(
  bill.publicToken,
  1,
  "razorpay-request-after-paid",
  db,
  orderFetch,
), /already fully paid/);

const webhookBody = JSON.stringify({ event: "payment.captured", payment: finalPaymentId });
const webhookSignature = createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(webhookBody).digest("hex");
assert.equal(verifyWebhookSignature(webhookBody, webhookSignature, process.env.RAZORPAY_WEBHOOK_SECRET), true);
assert.equal(verifyWebhookSignature(`${webhookBody}x`, webhookSignature, process.env.RAZORPAY_WEBHOOK_SECRET), false);
assert.equal(fallbackWebhookEventId(webhookBody), fallbackWebhookEventId(webhookBody));

const transactionCount = await db.execute({
  sql: "SELECT COUNT(*) AS count FROM payment_transactions WHERE owner_user_id = ? AND customer_id = ?",
  args: [owner.id, customerId],
});
assert.equal(Number(transactionCount.rows[0]?.count), 2);
console.log(JSON.stringify({ result: "ok", payments: 2, finalStatus: "paid" }));
for (const failure of ['lost-response', 'server-error', 'invalid-response', 'rejected']) {
  const recoveryBill = await createInvoice(owner, { customerId, idempotencyKey: 'recovery-bill-' + failure,
    issueDate: '2026-07-30', dueDate: '2026-07-30', lines: [{ productId: Number(productResult.rows[0]?.id), quantity: 1 }] }, db);
  let providerCalls = 0;
  const failingFetch = (async () => {
    providerCalls += 1;
    if (failure === 'lost-response') throw new Error('Connection lost after provider accepted request');
    if (failure === 'invalid-response') return Response.json({ id: 'order_unexpected', amount: 1, currency: 'INR' });
    return Response.json({ error: { description: 'Provider failure' } }, { status: failure === 'rejected' ? 400 : 503 });
  }) as typeof fetch;
  await assert.rejects(() => createOnlinePaymentOrder(recoveryBill.publicToken, 1000, 'recovery-first-' + failure, db, failingFetch), failure === 'rejected' ? /Provider failure/ : /confirmation is pending/);
  const attempt = await db.execute({ sql: 'SELECT status FROM razorpay_orders WHERE invoice_id = ?', args: [recoveryBill.id] });
  assert.equal(attempt.rows[0].status, failure === 'rejected' ? 'failed' : 'creating');
  if (failure !== 'rejected') {
    await assert.rejects(() => createOnlinePaymentOrder(recoveryBill.publicToken, 1000, 'recovery-first-' + failure, db, failingFetch), /awaiting confirmation/);
    await assert.rejects(() => createOnlinePaymentOrder(recoveryBill.publicToken, 1000, 'recovery-next-' + failure, db, failingFetch), /Another payment attempt/);
    assert.equal(providerCalls, 1, 'uncertain attempts must not issue a second provider order');
  } else {
    await assert.rejects(() => createOnlinePaymentOrder(recoveryBill.publicToken, 1000, 'recovery-next-' + failure, db, failingFetch), /Provider failure/);
    assert.equal(providerCalls, 2, 'confirmed rejection allows a new attempt');
  }
}
console.log('Interrupted checkout reservations and confirmed rejection retries passed');
await db.close();
