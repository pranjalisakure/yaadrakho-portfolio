import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve("backups/yaadrakho-order-recovery-test.db");
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
  recoverPaymentOrder,
  recoverWebhookOrder,
  reconcileRefundedCapture,
  finalizeCapturedRazorpayPayment,
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

const admin = await db.execute({ sql: "INSERT INTO users (email, display_name, storage_key, password_salt, password_hash, recovery_salt, recovery_hash, is_owner, created_at, updated_at) VALUES ('recovery-admin@example.test', 'Admin', 'recovery:admin', 's', 'h', 's', 'h', 1, ?, ?)", args: [now, now] });
const actor = { id: Number(admin.lastInsertRowid), isOwner: true };
let sequence = 0;
async function interrupted() {
 const bill = await createInvoice(owner, { customerId, idempotencyKey: 'recover-bill-' + (++sequence), issueDate: '2026-09-18', dueDate: '2026-10-18', lines: [{ productId: Number(productResult.rows[0].id), quantity: 1 }] }, db);
 await assert.rejects(() => createOnlinePaymentOrder(bill.publicToken, 1000, 'recover-request-' + sequence, db, (async () => { throw new Error('lost response'); }) as typeof fetch), /confirmation is pending/);
 const rows = await db.execute({ sql: 'SELECT id FROM razorpay_orders WHERE invoice_id = ?', args: [bill.id] });
 const id = Number(rows.rows[0].id);
 const remote = { id: 'order_recovery_' + id, receipt: `YR-${bill.id}-${id}`, amount: 100000, currency: 'INR', status: 'paid', notes: { yaadrakho_invoice_id: String(bill.id), yaadrakho_due_id: String(bill.dueId) } };
 const payment = { id: 'pay_recovery_' + id, order_id: remote.id, amount: 100000, currency: 'INR', status: 'captured', captured: true, method: 'upi' };
 return { bill, id, remote, payment };
}
function provider(fixture: Awaited<ReturnType<typeof interrupted>>, options: { empty?: boolean; badNotes?: boolean; refunded?: boolean; noPayments?: boolean; fail?: boolean } = {}) {
 return (async (url: RequestInfo | URL, init?: RequestInit) => {
  assert.equal(init?.method || 'GET', 'GET', 'recovery must not issue a payment or refund');
  if (options.fail) return Response.json({}, { status: 503 });
  const path = new URL(String(url));
  if (path.pathname.endsWith('/payments')) return Response.json({ items: options.noPayments ? [] : [{ ...fixture.payment, ...(options.refunded ? { amount_refunded: 100000, refunded: true, status: 'refunded' } : {}) }] });
  if (path.pathname.endsWith('/orders')) return Response.json({ items: options.empty ? [] : [fixture.remote] });
  return Response.json({ ...fixture.remote, ...(options.badNotes ? { notes: {} } : {}) });
 }) as typeof fetch;
}
const first = await interrupted();
await assert.rejects(() => recoverPaymentOrder({ id: owner.id, isOwner: false }, first.id, db, provider(first)), /Owner access/);
await assert.rejects(() => recoverPaymentOrder({ id: owner.id, isOwner: true }, first.id, db, provider(first)), /Owner access/);
for (const options of [{ empty: true }, { badNotes: true }, { fail: true }]) {
 await assert.rejects(() => recoverPaymentOrder(actor, first.id, db, provider(first, options)));
 const current = await db.execute({ sql: 'SELECT status, razorpay_order_id FROM razorpay_orders WHERE id = ?', args: [first.id] });
 assert.equal(current.rows[0].status, 'creating'); assert.equal(current.rows[0].razorpay_order_id, null);
}
const recovered = await recoverPaymentOrder(actor, first.id, db, provider(first));
assert.equal(recovered.paid, true);
assert.equal((await getInvoice(owner, first.bill.id, db))?.invoice.amountPaid, 1000);
await recoverPaymentOrder(actor, first.id, db, provider(first));
const count = await db.execute({ sql: 'SELECT COUNT(*) AS count FROM payment_transactions WHERE due_id = ?', args: [first.bill.dueId] });
assert.equal(Number(count.rows[0].count), 1, 'repeated recovery must not duplicate ledger payments');
const webhook = await interrupted();
await recoverWebhookOrder(webhook.remote.id, db, provider(webhook));
assert.equal((await getInvoice(owner, webhook.bill.id, db))?.invoice.amountPaid, 1000, 'unknown webhook order must recover and apply its payment');
const unpaid = await interrupted(); unpaid.remote.status = 'created';
assert.equal((await recoverPaymentOrder(actor, unpaid.id, db, provider(unpaid, { noPayments: true }))).paid, false);
const reopened = await createOnlinePaymentOrder(unpaid.bill.publicToken, 1000, 'reopened-same-amount', db, (async () => { throw new Error('must reuse provider order'); }) as typeof fetch);
assert.equal(reopened.orderId, unpaid.remote.id);
const routed = await interrupted();
await db.execute({ sql: "UPDATE razorpay_orders SET provider_account_id = 'acc_expected' WHERE id = ?", args: [routed.id] });
await assert.rejects(() => recoverPaymentOrder(actor, routed.id, db, provider(routed)), /merchant routing/);
const refunded = await interrupted();
assert.equal((await recoverPaymentOrder(actor, refunded.id, db, provider(refunded, { refunded: true }))).reconciliationRequired, true);
assert.equal((await getInvoice(owner, refunded.bill.id, db))?.invoice.amountPaid, 0, 'refunded money must not enter the ledger');
await assert.rejects(() => createOnlinePaymentOrder(refunded.bill.publicToken, 1000, 'refund-new-order', db), /awaiting review/);
const audit = await db.execute('SELECT status, source FROM order_recovery_attempts');
assert.ok(audit.rows.some(row => row.source === 'webhook' && row.status === 'recovered'));
assert.ok(audit.rows.some(row => row.status === 'failed'));
assert.ok(audit.rows.some(row => row.status === 'review_required'));
console.log('Order recovery: lost response, strict identity/routing, owner access, duplicate safety, webhook recovery, retained reservations, refunds and audit passed');
const refundId = 'rfnd_recovery_full';
const refundPayment = { ...refunded.payment, status: 'refunded', amount_refunded: 100000, refund_status: 'full' };
const refundEvidence = { id: refundId, payment_id: refunded.payment.id, amount: 100000, currency: 'INR', status: 'processed' };
const refundProvider = (changes: Record<string, unknown> = {}) => (async (url: RequestInfo | URL, init?: RequestInit) => {
 assert.equal(init?.method || 'GET', 'GET');
 return Response.json(String(url).includes('/refunds/') ? { ...refundEvidence, ...changes } : refundPayment);
}) as typeof fetch;
await assert.rejects(() => reconcileRefundedCapture({ id: owner.id, isOwner: true }, refunded.payment.id, refundId, 'Duplicate offline collection refunded', db, refundProvider()), /Owner access/);
for (const change of [{ status: 'pending' }, { amount: 50000 }, { payment_id: 'pay_wrong' }, { currency: 'USD' }]) {
 await assert.rejects(() => reconcileRefundedCapture(actor, refunded.payment.id, refundId, 'Duplicate offline collection refunded', db, refundProvider(change)), /matching processed full refund/);
}
assert.equal((await reconcileRefundedCapture(actor, refunded.payment.id, refundId, 'Duplicate offline collection refunded', db, refundProvider())).reconciled, true);
assert.equal((await reconcileRefundedCapture(actor, refunded.payment.id, refundId, 'Retry after response interruption', db, refundProvider())).reconciled, true);
const replay = await finalizeCapturedRazorpayPayment(refunded.remote.id, refunded.payment, db);
assert.equal(replay.paid, false, 'old captured webhook must not apply refunded money');
assert.equal((await getInvoice(owner, refunded.bill.id, db))?.invoice.amountPaid, 0);
await assert.rejects(() => recoverPaymentOrder(actor, refunded.id, db, provider(refunded)), /cannot be reopened/);
const newAttempt = await createOnlinePaymentOrder(refunded.bill.publicToken, 1000, 'after-refund-reconciliation', db, (async () => Response.json({ id: 'order_after_verified_refund', amount: 100000, currency: 'INR' })) as typeof fetch);
assert.equal(newAttempt.orderId, 'order_after_verified_refund', 'verified full refund releases only its old reservation');
console.log('Verified refund reconciliation, audit, duplicate handling and captured-webhook replay protection passed');
const signed = await interrupted();
const { POST: webhookPost } = await import('../app/api/razorpay/webhook/route');
const { createHmac } = await import('node:crypto');
const originalFetch = globalThis.fetch;
globalThis.fetch = provider(signed);
try {
 const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: signed.payment } } });
 const signature = createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!).update(body).digest('hex');
 const request = (sig: string) => new Request('https://example.test/api/razorpay/webhook', { method: 'POST', headers: { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'recovery-signed-event' }, body });
 assert.equal((await webhookPost(request('invalid'))).status, 401);
 assert.equal((await webhookPost(request(signature))).status, 200);
 const retry = await webhookPost(request(signature));
 assert.equal((await retry.json()).duplicate, true);
 assert.equal((await getInvoice(owner, signed.bill.id, db))?.invoice.amountPaid, 1000);
} finally { globalThis.fetch = originalFetch; }
console.log('Signed webhook recovery and duplicate-event handling passed');
const racing = await interrupted();
await recoverPaymentOrder(actor, racing.id, db, provider(racing, { refunded: true }));
let resolvedDuringRead = false;
const racingProvider = (async (url: RequestInfo | URL) => {
 if (!resolvedDuringRead && String(url).includes('expand')) {
  resolvedDuringRead = true;
  const evidence = (async (address: RequestInfo | URL) => Response.json(String(address).includes('/refunds/')
   ? { id: 'rfnd_racing', payment_id: racing.payment.id, amount: 100000, currency: 'INR', status: 'processed' }
   : { ...racing.payment, status: 'refunded', amount_refunded: 100000, refund_status: 'full' })) as typeof fetch;
  await reconcileRefundedCapture(actor, racing.payment.id, 'rfnd_racing', 'Concurrent review completed full refund', db, evidence);
 }
 return Response.json(racing.remote);
}) as typeof fetch;
await assert.rejects(() => recoverPaymentOrder(actor, racing.id, db, racingProvider), /reconciled while recovery/);
assert.equal((await db.execute({ sql: 'SELECT status FROM razorpay_orders WHERE id = ?', args: [racing.id] })).rows[0].status, 'failed');
console.log('Concurrent refund resolution cannot reopen an order');
await db.close();
