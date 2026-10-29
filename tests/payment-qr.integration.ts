import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import jsQR from "jsqr";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve("backups/yaadrakho-qr-integration-test.db");
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

process.env.PUBLIC_APP_URL = "http://127.0.0.1:3199";
const { default: PaymentInstructions } = await import("../app/PaymentInstructions");
const { getPublicReceipt } = await import("../db/payment-receipts");
const { recordLedgerPayment } = await import("../db/payment-ledger");
const { setInvoicePaymentChoice } = await import("../db/invoice-payment-choice");
const { paymentQrMatrix, paymentQrTarget } = await import("../app/payment-qr");
const productId = Number(productResult.rows[0].id);
async function billFor(choice: "cash" | "online", key: string) {
  return createInvoice(owner, {customerId, idempotencyKey: key, issueDate: "2026-09-18", dueDate: "2026-10-18", remainingPayment: choice, lines: [{productId, quantity: 1}]}, db);
}
const online = await billFor("online", "qr-online-invoice");
const cash = await billFor("cash", "qr-cash-invoice");
const full = await billFor("online", "qr-full-invoice");
const renderBill = async (id: number) => {
  const data = (await getInvoice(owner, id, db))!.invoice;
  return renderToStaticMarkup(await PaymentInstructions({token: String(data.publicToken), remaining: Number(data.totalAmount) - Number(data.amountPaid), choice: String(data.remainingPayment), dueDate: String(data.dueDate), status: String(data.status)}));
};
assert.match(await renderBill(online.id), /bill-payment-qr/);
assert.doesNotMatch(await renderBill(cash.id), /<svg/);
assert.match(await renderBill(cash.id), /Cash/);
const fakeFetch = (async () => { throw Error("Cash checkout must not contact Razorpay"); }) as typeof fetch;
await assert.rejects(() => createOnlinePaymentOrder(cash.publicToken, 1000, "qr-cash-checkout-blocked", db, fakeFetch), /cash payment/);
for (const invalid of [0, -1, 1000, 1001, 0.5]) {
  await assert.rejects(() => createInvoice(owner, {customerId, idempotencyKey: "invalid-qr-partial-" + invalid, issueDate: "2026-09-18", dueDate: "2026-10-18", initialPaymentAmount: invalid, lines: [{productId, quantity: 1}]}, db), /Part payment|request key/);
}
const part = await recordLedgerPayment(owner, customerId, {dueId: online.dueId, amount: 500, method: "cash", idempotencyKey: "qr-cash-part-online-balance"}, db);
const partCash = await recordLedgerPayment(owner, customerId, {dueId: cash.dueId, amount: 500, method: "upi", reference: "TEST-UTR", idempotencyKey: "qr-upi-part-cash-balance"}, db);
async function renderReceipt(paymentId: number) {
  const row = (await db.execute({sql:"SELECT receipt_token FROM payment_transactions WHERE id = ?",args:[paymentId]})).rows[0];
  const receipt = (await getPublicReceipt(String(row.receipt_token), db))!;
  return {receipt, html: receipt.balanceAfter === 0 ? "" : renderToStaticMarkup(await PaymentInstructions({token: receipt.billToken, remaining: receipt.currentRemaining, choice: receipt.remainingPayment, dueDate: receipt.dueDate, status: receipt.invoiceStatus}))};
}
const partReceipt = await renderReceipt(part.paymentId);
assert.equal(partReceipt.receipt.currentRemaining, 500);
assert.match(partReceipt.html, /bill-payment-qr/);
assert.match(partReceipt.html, /500/);
assert.doesNotMatch((await renderReceipt(partCash.paymentId)).html, /<svg/);
const fullPayment = await recordLedgerPayment(owner, customerId, {dueId: full.dueId, amount: 1000, method: "cash", idempotencyKey: "qr-full-cash-payment"}, db);
assert.equal(await renderBill(full.id), "");
assert.equal((await renderReceipt(fullPayment.paymentId)).html, "");
await setInvoicePaymentChoice(owner, cash.id, "online");
assert.match(await renderBill(cash.id), /bill-payment-qr/);
await setInvoicePaymentChoice(owner, cash.id, "cash");
await assert.rejects(() => setInvoicePaymentChoice({id: owner.id + 10, storageKey: "other"}, cash.id, "online"), /not found/);
const due = (await db.execute({sql: "SELECT status, due_date FROM payment_dues WHERE id = ?", args: [cash.dueId]})).rows[0];
assert.equal(due.status, "partial");
assert.equal(due.due_date, "2026-10-18", "cash selection must not clear the due date/reminder eligibility");

const targetUrl = paymentQrTarget(process.env.PUBLIC_APP_URL, online.publicToken, 500, "online")!;
const modules = paymentQrMatrix(targetUrl);
const scale = 5, size = (modules.size + 8) * scale;
const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const row = Math.floor(y / scale) - 4, col = Math.floor(x / scale) - 4;
  if (row >= 0 && col >= 0 && row < modules.size && col < modules.size && modules.get(row, col)) {
    const i = (y * size + x) * 4; pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
  }
}
assert.equal(jsQR(pixels, size, size)?.data, targetUrl, "a QR decoder must recover the exact customer bill link");
assert.equal(paymentQrTarget(process.env.PUBLIC_APP_URL, online.publicToken, 0, "online"), null);
assert.equal(paymentQrTarget(process.env.PUBLIC_APP_URL, online.publicToken, 500, "cash"), null);
await recordLedgerPayment(owner, customerId, {dueId: online.dueId, amount: 500, method: "upi", idempotencyKey: "qr-settle-online-balance"}, db);
assert.equal((await renderReceipt(part.paymentId)).html, "", "old part-payment receipts must stop requesting money after settlement");
assert.equal((await renderReceipt(part.paymentId)).receipt.balanceAfter, 500, "historical balance must remain unchanged");

for (const method of ["upi", "paytm", "bank", "other"]) {
  const paidBill = await billFor("online", "qr-full-" + method);
  const paid = await recordLedgerPayment(owner, customerId, {dueId: paidBill.dueId, amount: 1000, method, reference: "TEST-REFERENCE", idempotencyKey: "qr-full-payment-" + method}, db);
  assert.equal(await renderBill(paidBill.id), "");
  assert.equal((await renderReceipt(paid.paymentId)).html, "", "fully paid " + method + " receipt must have no payment QR");
}
const openBill = await billFor("online", "qr-open-order-choice");
const orderFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
  const payload = JSON.parse(String(init?.body));
  return Response.json({id: "order_qr_choice", amount: payload.amount, currency: "INR"});
}) as typeof fetch;
await createOnlinePaymentOrder(openBill.publicToken, 1000, "qr-choice-open-order", db, orderFetch);
await assert.rejects(() => setInvoicePaymentChoice(owner, openBill.id, "cash"), /online payment is open/);

// Leave only synthetic preview data for local visual checks.
const preview = await billFor("online", "qr-preview-partial-bill");
const previewPart = await recordLedgerPayment(owner, customerId, {dueId: preview.dueId, amount: 500, method: "cash", idempotencyKey: "qr-preview-partial-payment"}, db);
const { replacePassword } = await import("../app/auth");
await replacePassword(owner.id, "QrPreview-Only-2026!");
console.log(JSON.stringify({result: "ok", checks: "online/cash/full/partial QR matrix, actual QR decoding, current vs historical balances, tenant isolation, checkout cash guard", previewBill: preview.publicToken, previewReceipt: (await renderReceipt(previewPart.paymentId)).receipt.receiptToken, cashBill: cash.publicToken, fullBill: full.publicToken}));
await db.close();
