import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve("backups/yaadrakho-payment-review-test.db");
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
  recheckCapturedPayment,
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

const bill = await createInvoice(owner, {customerId, idempotencyKey: "review-test-bill", issueDate: "2026-09-18", dueDate: "2026-10-18", lines: [{productId: Number(productResult.rows[0].id), quantity: 1}]}, db);
const insertedAdmin = await db.execute({sql: "INSERT INTO users (email, display_name, storage_key, password_salt, password_hash, recovery_salt, recovery_hash, is_owner, created_at, updated_at) VALUES ('review-admin@example.test', 'Owner', 'review:admin', 's', 'h', 's', 'h', 1, ?, ?)", args: [now,now]});
const actor = {id: Number(insertedAdmin.lastInsertRowid), isOwner: true};
let orderSequence = 0, providerReads = 0;
const orderFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {const payload=JSON.parse(String(init?.body));return Response.json({id:"order_review_"+(++orderSequence),amount:payload.amount,currency:"INR"});}) as typeof fetch;
const order = await createOnlinePaymentOrder(bill.publicToken,400,"review-test-order",db,orderFetch);
const originalReceivedAt = now - 86_400_000;
async function pending(paymentId: string, orderId: string, amount: number) {
 await db.execute({sql: "INSERT INTO razorpay_captures (payment_id, razorpay_order_id, owner_user_id, invoice_id, due_id, amount, currency, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'INR', 'pending', ?, ?)", args:[paymentId,orderId,owner.id,bill.id,bill.dueId,amount,originalReceivedAt,now]});
}
await pending("pay_review_partial",order.orderId,400);
const payment = {id:"pay_review_partial",order_id:order.orderId,amount:40000,currency:"INR",status:"captured",captured:true,method:"upi"};
const provider = (body: unknown, status=200) => (async (_url: RequestInfo | URL, init?: RequestInit) => {
 assert.equal(init?.method || "GET", "GET", "rechecks must never create payments or refunds"); providerReads++; return Response.json(body,{status});
}) as typeof fetch;
await assert.rejects(()=>recheckCapturedPayment({id:owner.id,isOwner:false},payment.id,db,provider(payment)),/Owner access/);
await assert.rejects(()=>recheckCapturedPayment({id:owner.id,isOwner:true},payment.id,db,provider(payment)),/Owner access/);
assert.equal(providerReads,0);
await assert.rejects(()=>recheckCapturedPayment(actor,payment.id,db,provider({...payment,id:"pay_other"})),/do not match/);
await assert.rejects(()=>recheckCapturedPayment(actor,payment.id,db,provider({...payment,amount_refunded:100})),/refund/);
await assert.rejects(()=>recheckCapturedPayment(actor,payment.id,db,provider({error:{description:"temporary test outage"}},503)),/temporary test outage/);
assert.equal(Number((await getInvoice(owner,bill.id,db))!.invoice.amountPaid),0);
const applied=await recheckCapturedPayment(actor,payment.id,db,provider(payment));
assert.equal(applied.paid,true);
assert.equal(Number((await getInvoice(owner,bill.id,db))!.invoice.amountPaid),400);
const transaction=(await db.execute("SELECT received_at FROM payment_transactions WHERE idempotency_key = 'razorpay:pay_review_partial'")).rows[0];
assert.equal(Number(transaction.received_at),originalReceivedAt,"retry must preserve the first observed capture date");
const reads=providerReads;
assert.equal((await recheckCapturedPayment(actor,payment.id,db,provider(payment))).duplicate,true);
assert.equal(providerReads,reads);
assert.equal(Number((await db.execute("SELECT COUNT(*) AS count FROM payment_transactions")).rows[0].count),1);
const finalOrder=await createOnlinePaymentOrder(bill.publicToken,600,"review-final-order",db,orderFetch);
await pending("pay_review_conflict",finalOrder.orderId,600);
const {recordLedgerPayment}=await import("../db/payment-ledger");
await recordLedgerPayment(owner,customerId,{amount:600,dueId:bill.dueId,method:"cash",idempotencyKey:"review-offline-balance"},db);
const conflict=await recheckCapturedPayment(actor,"pay_review_conflict",db,provider({...payment,id:"pay_review_conflict",order_id:finalOrder.orderId,amount:60000}));
assert.equal(conflict.paid,false);
await assert.rejects(()=>recheckCapturedPayment(actor,"pay_review_conflict",db,provider(payment)),/reconciliation decision/);
assert.equal(Number((await db.execute("SELECT COUNT(*) AS count FROM payment_transactions")).rows[0].count),2);
const attempts=await db.execute("SELECT status, actor_user_id FROM payment_review_attempts ORDER BY id");
assert.deepEqual(attempts.rows.map(row=>row.status),["failed","failed","failed","applied","review_required"]);
assert.ok(attempts.rows.every(row=>Number(row.actor_user_id)===actor.id));
console.log(JSON.stringify({result:"ok",checks:"owner permissions, provider identity and refund checks, idempotent recheck, original payment date, conflict preserved, audit trail"}));
await db.close();
