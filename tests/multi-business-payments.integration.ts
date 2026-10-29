import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve("backups/yaadrakho-multi-business-integration-test.db");
await rm(target, { force: true });
process.env.TURSO_DATABASE_URL = `file:${target.replaceAll("\\", "/")}`;
delete process.env.TURSO_AUTH_TOKEN;
process.env.RAZORPAY_ENABLED = "true";
process.env.RAZORPAY_KEY_ID = "rzp_test_multi_business";
process.env.RAZORPAY_KEY_SECRET = "multi-business-secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "multi-business-webhook";
process.env.RAZORPAY_ALLOW_LIVE = "false";
process.env.RAZORPAY_ROUTE_ENABLED = "true";

const { ensureRazorpayTables, getClient } = await import("../db/index");
const { createInvoice, getInvoice, saveCatalogProducts } = await import("../db/sales-billing");
const {
  configureBusinessPaymentAccount,
  createOnlinePaymentOrder,
  finalizeCapturedRazorpayPayment,
  finalizeRazorpayTransfer,
} = await import("../db/razorpay");

await ensureRazorpayTables();
const db = getClient();
const now = Date.now();

async function createOwnerBill(key: string, total: number) {
  const inserted = await db.execute({
    sql: `INSERT INTO users
      (email, display_name, storage_key, password_salt, password_hash, recovery_salt, recovery_hash, is_owner,
       email_verified_at, last_login_at, last_activity_at, created_at, updated_at)
      VALUES (?, ?, ?, 's', 'h', 's', 'h', 0, ?, NULL, NULL, ?, ?)`,
    args: [`${key}@example.test`, `${key} Shop`, `owner:${key}`, now, now, now],
  });
  const owner = { id: Number(inserted.lastInsertRowid), storageKey: `owner:${key}`, displayName: `${key} Shop` };
  await db.execute({
    sql: "INSERT INTO app_settings (user_email, business_name, phone, updated_at) VALUES (?, ?, '9999900001', ?)",
    args: [owner.storageKey, owner.displayName, now],
  });
  const customer = await db.execute({
    sql: `INSERT INTO customers
      (owner_email, owner_user_id, name, phone, requirement, amount, follow_up_date, status, payment_status,
       billing_cycle, recurring_day, notes, contact_consent, created_at, updated_at)
      VALUES (?, ?, ?, '9999911111', '', 0, '2026-08-01', 'new', 'pending',
        'one_time', 1, '', 1, ?, ?)`,
    args: [owner.storageKey, owner.id, `${key} Customer`, now, now],
  });
  await saveCatalogProducts(owner, [{ name: `${key} Service`, price: total, gstRate: 0, unit: "service" }], db);
  const product = await db.execute({
    sql: "SELECT id FROM product_catalog WHERE owner_user_id = ? ORDER BY id DESC LIMIT 1",
    args: [owner.id],
  });
  const bill = await createInvoice(owner, {
    customerId: Number(customer.lastInsertRowid),
    idempotencyKey: `phase8-bill-${key}-0001`,
    issueDate: "2026-08-01",
    dueDate: "2026-08-01",
    lines: [{ productId: Number(product.rows[0]?.id), quantity: 1 }],
  }, db);
  return { owner, bill };
}

const a = await createOwnerBill("alpha", 1000);
const b = await createOwnerBill("beta", 500);
const c = await createOwnerBill("gamma", 300);
await configureBusinessPaymentAccount(a.owner.id, { providerAccountId: "acc_TestAlpha1234", status: "active" }, db);
await configureBusinessPaymentAccount(b.owner.id, { providerAccountId: "acc_TestBeta12345", status: "active" }, db);

const routedBodies: Array<Record<string, unknown>> = [];
let orderCount = 0;
const orderFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
  routedBodies.push(body);
  orderCount += 1;
  return Response.json({ id: `order_route_${orderCount}`, amount: body.amount, currency: body.currency });
}) as typeof fetch;

const partialA = await createOnlinePaymentOrder(a.bill.publicToken, 400, "phase8-alpha-partial-0001", db, orderFetch);
const orderB = await createOnlinePaymentOrder(b.bill.publicToken, 250, "phase8-beta-partial-00001", db, orderFetch);
assert.equal((routedBodies[0]?.transfers as Array<{ account: string }>)[0]?.account, "acc_TestAlpha1234");
assert.equal((routedBodies[1]?.transfers as Array<{ account: string }>)[0]?.account, "acc_TestBeta12345");
assert.equal(routedBodies[0]?.partial_payment, false);
await assert.rejects(() => createOnlinePaymentOrder(c.bill.publicToken, 100, "phase8-gamma-no-account", db, orderFetch), /has not completed/);

process.env.VERCEL_ENV = "preview";
process.env.RAZORPAY_PREVIEW_SHARED_TEST_MODE = "true";
const previewFallback = await createOnlinePaymentOrder(c.bill.publicToken, 100, "phase8-gamma-preview-fallback", db, orderFetch);
assert.equal(previewFallback.amountPaise, 10000, "Preview Test Mode may use the shared demo checkout");
assert.equal(routedBodies.at(-1)?.transfers, undefined, "Preview fallback must not create a Route transfer");
delete process.env.RAZORPAY_PREVIEW_SHARED_TEST_MODE;
delete process.env.VERCEL_ENV;

await finalizeCapturedRazorpayPayment(partialA.orderId, {
  id: "pay_alpha_partial", order_id: partialA.orderId, amount: 40000, currency: "INR",
  status: "captured", captured: true, method: "upi",
}, db);
await finalizeCapturedRazorpayPayment(partialA.orderId, {
  id: "pay_alpha_partial", order_id: partialA.orderId, amount: 40000, currency: "INR",
  status: "captured", captured: true, method: "upi",
}, db);
let invoiceA = await getInvoice(a.owner, a.bill.id, db);
let invoiceB = await getInvoice(b.owner, b.bill.id, db);
assert.equal(Number(invoiceA?.invoice.amountPaid), 400);
assert.equal(String(invoiceA?.invoice.status), "partial");
assert.equal(Number(invoiceB?.invoice.amountPaid), 0);
assert.equal(invoiceA?.transactions.length, 1, "duplicate capture must not duplicate ledger entries");

await finalizeRazorpayTransfer({
  id: "trf_alpha_001", source: partialA.orderId, recipient: "acc_TestAlpha1234", status: "processed",
}, false, db);
const transfer = await db.execute({
  sql: "SELECT transfer_status, provider_account_id FROM razorpay_orders WHERE razorpay_order_id = ?",
  args: [partialA.orderId],
});
assert.equal(String(transfer.rows[0]?.transfer_status), "processed");
assert.equal(String(transfer.rows[0]?.provider_account_id), "acc_TestAlpha1234");
await assert.rejects(() => finalizeRazorpayTransfer({
  id: "trf_wrong", source: orderB.orderId, recipient: "acc_TestAlpha1234", status: "processed",
}, false, db), /not linked/);

const finalA = await createOnlinePaymentOrder(a.bill.publicToken, 600, "phase8-alpha-final-000001", db, orderFetch);
await finalizeCapturedRazorpayPayment(finalA.orderId, {
  id: "pay_alpha_final", order_id: finalA.orderId, amount: 60000, currency: "INR",
  status: "captured", captured: true, method: "wallet", wallet: "paytm",
}, db);
invoiceA = await getInvoice(a.owner, a.bill.id, db);
invoiceB = await getInvoice(b.owner, b.bill.id, db);
assert.equal(Number(invoiceA?.invoice.amountPaid), 1000);
assert.equal(String(invoiceA?.invoice.status), "paid");
assert.equal(Number(invoiceB?.invoice.amountPaid), 0);
assert.equal(invoiceA?.transactions.length, 2);

console.log(JSON.stringify({
  result: "ok",
  owners: 3,
  routedAccounts: routedBodies.map((body) => (body.transfers as Array<{ account: string }> | undefined)?.[0]?.account || "shared-preview"),
  alphaStatus: invoiceA?.invoice.status,
  betaPaid: invoiceB?.invoice.amountPaid,
}));
await db.close();
