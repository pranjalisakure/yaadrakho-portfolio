import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve("backups/yaadrakho-billing-integration-test.db");
await rm(target, { force: true });
process.env.TURSO_DATABASE_URL = `file:${target.replaceAll("\\", "/")}`;
delete process.env.TURSO_AUTH_TOKEN;

const { ensureBillingTables, getClient } = await import("../db/index");
const { createInvoice, getBillingOverview, getInvoice, getPublicInvoice, prepareInvoiceDelivery, reviewInvoiceDelivery, sendPreparedInvoiceDelivery, saveCatalogProducts } = await import("../db/sales-billing");
const { recordLedgerPayment } = await import("../db/payment-ledger");
const { prepareReceiptDelivery } = await import("../db/payment-receipts");
await ensureBillingTables();
const db = getClient();
const now = Date.now();

async function addUser(email: string, storageKey: string) {
  const result = await db.execute({ sql: `INSERT INTO users
    (email, display_name, storage_key, password_salt, password_hash, recovery_salt, recovery_hash, is_owner,
      email_verified_at, last_login_at, last_activity_at, created_at, updated_at)
    VALUES (?, 'Billing Test', ?, 's', 'h', 's', 'h', 0, ?, NULL, NULL, ?, ?)`, args: [email, storageKey, now, now, now] });
  return { id: Number(result.lastInsertRowid), storageKey, displayName: "Billing Test" };
}

async function addCustomer(owner: { id: number; storageKey: string }, phone: string) {
  const result = await db.execute({ sql: `INSERT INTO customers
    (owner_email, owner_user_id, name, phone, requirement, amount, follow_up_date, status, payment_status,
      billing_cycle, recurring_day, notes, contact_consent, created_at, updated_at)
    VALUES (?, ?, 'Demo Customer', ?, '', 0, '2026-07-21', 'new', 'pending', 'one_time', 21, '', 1, ?, ?)`,
    args: [owner.storageKey, owner.id, phone, now, now] });
  return Number(result.lastInsertRowid);
}

const ownerA = await addUser("billing-a@example.test", "billing:a");
const ownerB = await addUser("billing-b@example.test", "billing:b");
await db.execute({
  sql: "INSERT INTO app_settings (user_email, business_name, phone, updated_at) VALUES (?, ?, ?, ?)",
  args: [ownerA.storageKey, "Pranjali Electricals", "9999900001", now],
});
await db.execute({
  sql: "INSERT INTO app_settings (user_email, business_name, phone, updated_at) VALUES (?, ?, ?, ?)",
  args: [ownerB.storageKey, "Ruhi Stationery", "9876500000", now],
});
const customerId = await addCustomer(ownerA, "9999911111");
const customerBId = await addCustomer(ownerB, "9999922222");

const imported = await saveCatalogProducts(ownerA, [
  { name: "School Uniform", price: 1200, gstRate: 5, unit: "set" },
  { name: "Monthly Mess Plan", price: 2000, gstRate: 0, unit: "month" },
  { name: "Lunch Plate", price: 100, gstRate: 5, unit: "plate" },
], db);
assert.equal(imported.saved, 3);
await saveCatalogProducts(ownerA, [{ name: "lunch plate", price: 120, gstRate: 5, unit: "plate" }], db);
let overview = await getBillingOverview(ownerA, db);
assert.equal(overview.products.length, 3, "same normalized product name must update instead of duplicate");
const lunch = overview.products.find((product) => String(product.name).toLowerCase() === "lunch plate");
assert.equal(Number(lunch?.price), 120);
const uniform = overview.products.find((product) => String(product.name) === "School Uniform");
assert.equal(Number(uniform?.price), 1200);
assert.equal(Number(uniform?.gstRate), 5);
assert.equal(String(uniform?.unit), "set");

const schoolBill = await createInvoice(ownerA, {
  idempotencyKey: "billing-school-0001", customerId, issueDate: "2026-07-20", dueDate: "2026-07-25", billingMode: "separate", notes: "Uniform sale",
  lines: [{ productId: Number(uniform?.id), quantity: 2, discount: 0 }],
}, db);
assert.equal(schoolBill.totalAmount, 2520, "School Uniform quantity 2 plus 5% GST must total ₹2,520");
const retriedSchoolBill = await createInvoice(ownerA, {
  idempotencyKey: "billing-school-0001", customerId, issueDate: "2026-07-20", dueDate: "2026-07-25", billingMode: "separate", notes: "Uniform sale",
  lines: [{ productId: Number(uniform?.id), quantity: 2, discount: 0 }],
}, db);
assert.equal(retriedSchoolBill.id, schoolBill.id, "same bill request must return the original invoice");
const prepared = await prepareInvoiceDelivery(ownerA, schoolBill.id, "https://preview.example.test", db);
const schoolInvoice = await getInvoice(ownerA, schoolBill.id, db);
const publicSchoolInvoice = await getPublicInvoice(schoolBill.publicToken, db);
assert.equal(String(schoolInvoice?.invoice.businessName), "Pranjali Electricals", "private invoice must show the saved seller business name");
assert.equal(String(publicSchoolInvoice?.invoice.businessName), "Pranjali Electricals", "customer bill must show the saved seller business name");
assert.equal(String(publicSchoolInvoice?.invoice.businessPhone), "9999900001");
assert.match(prepared.message, /from Pranjali Electricals is ready/);
assert.match(prepared.message, /Bill date: 20 Jul 2026/);
assert.match(prepared.message, /Payment due date: 25 Jul 2026/);
assert.match(prepared.message, /₹2,520/);
assert.ok(publicSchoolInvoice, "customer bill must be accessible with its secure token");
assert.equal(Number(schoolInvoice?.invoice.customerId), customerId);
assert.equal(String(schoolInvoice?.invoice.issueDate), "2026-07-20");
assert.equal(String(schoolInvoice?.invoice.dueDate), "2026-07-25");
assert.equal(String(schoolInvoice?.items[0]?.description), "School Uniform");
assert.equal(Number(schoolInvoice?.items[0]?.quantityMilli), 2000);

await assert.rejects(() => recordLedgerPayment(ownerA, customerId, { amount: 0, dueId: schoolBill.dueId, idempotencyKey: "billing-zero-0001" }, db), /positive whole number/);
await assert.rejects(() => recordLedgerPayment(ownerA, customerId, { amount: -1, dueId: schoolBill.dueId, idempotencyKey: "billing-negative-0001" }, db), /positive whole number/);
await assert.rejects(() => recordLedgerPayment(ownerA, customerId, { amount: 2521, dueId: schoolBill.dueId, idempotencyKey: "billing-overpay-0001" }, db), /remaining amount/);
await recordLedgerPayment(ownerA, customerId, { amount: 1000, dueId: schoolBill.dueId, expectedDueDate: "2026-07-25", method: "upi", reference: schoolBill.invoiceNumber, idempotencyKey: "billing-partial-0001" }, db);
await recordLedgerPayment(ownerA, customerId, { amount: 1000, dueId: schoolBill.dueId, expectedDueDate: "2026-07-25", method: "upi", reference: schoolBill.invoiceNumber, idempotencyKey: "billing-partial-0001" }, db);
let paidSchoolInvoice = await getInvoice(ownerA, schoolBill.id, db);
assert.equal(String(paidSchoolInvoice?.invoice.status), "partial");
assert.equal(Number(paidSchoolInvoice?.invoice.amountPaid), 1000);
assert.equal(paidSchoolInvoice?.transactions.length, 1, "duplicate payment request must not create a second transaction");
let schoolDue = await db.execute({ sql: "SELECT status, amount_due, amount_paid FROM payment_dues WHERE id = ? AND owner_user_id = ?", args: [schoolBill.dueId, ownerA.id] });
assert.equal(String(schoolDue.rows[0]?.status), "partial", "partial bill reminder must remain active");
assert.equal(Number(schoolDue.rows[0]?.amount_due) - Number(schoolDue.rows[0]?.amount_paid), 1520);
await recordLedgerPayment(ownerA, customerId, { amount: 1520, dueId: schoolBill.dueId, expectedDueDate: "2026-07-25", method: "cash", reference: schoolBill.invoiceNumber, idempotencyKey: "billing-final-00001" }, db);
paidSchoolInvoice = await getInvoice(ownerA, schoolBill.id, db);
assert.equal(String(paidSchoolInvoice?.invoice.status), "paid");
assert.equal(Number(paidSchoolInvoice?.invoice.amountPaid), 2520);
assert.equal(paidSchoolInvoice?.transactions.length, 2);
schoolDue = await db.execute({ sql: "SELECT status, amount_due, amount_paid FROM payment_dues WHERE id = ? AND owner_user_id = ?", args: [schoolBill.dueId, ownerA.id] });
assert.equal(String(schoolDue.rows[0]?.status), "paid", "paid bill must stop future reminders");
const receipt = await prepareInvoiceDelivery(ownerA, schoolBill.id, "https://preview.example.test", db);
assert.match(receipt.message, /Payment received\. Thank you!/);
assert.doesNotMatch(receipt.message, /Pending:/, "paid receipt must not show an old pending balance");
await assert.rejects(() => createInvoice(ownerA, {
  customerId, issueDate: "2026-07-20", dueDate: "2026-07-25", billingMode: "separate", notes: "Invalid discount",
  lines: [{ productId: Number(uniform?.id), quantity: 1, discount: 1201 }],
}, db), /discount cannot be more/);
await assert.rejects(() => createInvoice(ownerA, {
  customerId, issueDate: "2026-07-20", dueDate: "2026-07-19", billingMode: "separate", notes: "Invalid dates",
  lines: [{ productId: Number(uniform?.id), quantity: 1, discount: 0 }],
}, db), /Due date cannot be before/);

const first = await createInvoice(ownerA, {
  idempotencyKey: "billing-first-00001", customerId, issueDate: "2026-07-20", dueDate: "2026-07-21", billingMode: "separate", notes: "First sale",
  lines: [{ productId: Number(lunch?.id), quantity: 2, discount: 20 }],
}, db);
assert.equal(first.totalAmount, 231, "server must apply discount before GST using the owned catalog price");
const second = await createInvoice(ownerA, {
  idempotencyKey: "billing-second-0001", customerId, issueDate: "2026-07-21", dueDate: "2026-07-22", billingMode: "separate", notes: "Next day sale",
  lines: [{ productId: Number(lunch?.id), quantity: 1 }],
}, db);
assert.notEqual(first.invoiceNumber, second.invoiceNumber, "every sale needs a unique bill number");
assert.equal(await getInvoice(ownerB, first.id, db), null, "another business cannot access the bill");

const counterPaidBill = await createInvoice(ownerA, {
  idempotencyKey: "billing-counter-paid-001", customerId, issueDate: "2026-07-22", dueDate: "2026-07-22", billingMode: "separate", notes: "Paid at counter",
  lines: [{ productId: Number(lunch?.id), quantity: 1, discount: 0 }],
}, db);
const counterPayment = await recordLedgerPayment(ownerA, customerId, {
  amount: counterPaidBill.totalAmount, dueId: counterPaidBill.dueId, expectedDueDate: "2026-07-22",
  method: "paytm", reference: "PAYTM-COUNTER-001", idempotencyKey: "billing-counter-payment-001",
}, db);
assert.ok(counterPayment.paymentId, "counter payment must return the receipt transaction ID");
const counterReceipt = await prepareReceiptDelivery(ownerA, Number(counterPayment.paymentId), "https://preview.example.test", db);
assert.match(counterReceipt.receiptUrl, /\/receipt\//, "already-paid flow must prepare a receipt link");
assert.match(counterReceipt.whatsappUrl, /^https:\/\/wa\.me\//, "already-paid flow must prepare a WhatsApp receipt");
const counterPaidInvoice = await getInvoice(ownerA, counterPaidBill.id, db);
assert.equal(String(counterPaidInvoice?.invoice.status), "paid");
const counterDue = await db.execute({ sql: "SELECT status FROM payment_dues WHERE id = ?", args: [counterPaidBill.dueId] });
assert.equal(String(counterDue.rows[0]?.status), "paid", "paid-at-counter bill must stop reminders immediately");

await saveCatalogProducts(ownerB, [{ name: "Notebook", price: 50, gstRate: 0, unit: "item" }], db);
const ownerBOverviewBefore = await getBillingOverview(ownerB, db);
const ownerBProduct = ownerBOverviewBefore.products[0];
const ownerBBill = await createInvoice(ownerB, {
  idempotencyKey: "billing-owner-b-001", customerId: customerBId, issueDate: "2026-07-22", dueDate: "2026-07-23", billingMode: "separate", notes: "Business B sale",
  lines: [{ productId: Number(ownerBProduct?.id), quantity: 1, discount: 0 }],
}, db);
const ownerBInvoice = await getInvoice(ownerB, ownerBBill.id, db);
assert.equal(String(ownerBInvoice?.invoice.businessName), "Ruhi Stationery");
assert.equal(await getInvoice(ownerA, ownerBBill.id, db), null, "Business A cannot view Business B invoice");
assert.equal(await getInvoice(ownerB, schoolBill.id, db), null, "Business B cannot view Business A invoice");
const ownerBOverview = await getBillingOverview(ownerB, db);
assert.equal(ownerBOverview.products.length, 1);
assert.equal(ownerBOverview.invoices.length, 1);

overview = await getBillingOverview(ownerA, db);
assert.equal(overview.invoices.length, 4);
assert.equal(Number(overview.stats.totalBills), 4);
assert.equal(Number(overview.stats.pendingBills), 2, "paid bill must not remain in pending billing summary");
assert.equal(Number(overview.stats.collectedAmount), 2646);
const counterOverview = overview.invoices.find((invoice) => Number(invoice.id) === counterPaidBill.id);
assert.equal(Number(counterOverview?.latestReceiptId), Number(counterPayment.paymentId), "paid bill history must expose its latest receipt");
const dueRows = await db.execute({ sql: "SELECT COUNT(*) AS count FROM payment_dues WHERE owner_user_id = ? AND customer_id = ?", args: [ownerA.id, customerId] });
assert.equal(Number(dueRows.rows[0]?.count), 4, "separate sales must create separate reminder/payment dues");
console.log(JSON.stringify({ result: "ok", products: overview.products.length, invoices: overview.invoices.length }));
// More than the old 200-row cutoff, with older unpaid invoices behind paid history.
await db.execute({ sql: `WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 205)
  INSERT INTO invoices (owner_user_id, owner_key, customer_id, invoice_number, issue_date, due_date,
    subtotal, total_amount, amount_paid, status, created_at, updated_at)
  SELECT ?, ?, ?, 'PAGINATION-' || n, '2026-08-01', '2026-08-01', 10, 10, 10, 'paid', ?, ? FROM sequence`,
  args: [ownerA.id, ownerA.storageKey, customerId, now, now] });
const ids: number[] = [];
for (let page = 1; page <= 5; page += 1) {
  const result = await getBillingOverview(ownerA, db, { page });
  assert.equal(result.pagination.page, page);
  assert.equal(result.pagination.hasMore, page < 5);
  assert.equal(result.invoices.length, page < 5 ? 50 : 9);
  assert.equal(result.stats.totalBills, 209, 'summary must cover the whole business, not just one page');
  ids.push(...result.invoices.map(invoice => Number(invoice.id)));
}
assert.equal(new Set(ids).size, 209, 'all invoices must be reachable exactly once across pages');
assert.ok(ids.includes(first.id) && ids.includes(second.id), 'old unpaid bills must remain reachable');
const pendingPage = await getBillingOverview(ownerA, db, { pendingOnly: true });
assert.deepEqual(new Set(pendingPage.invoices.map(invoice => Number(invoice.id))), new Set([first.id, second.id]), 'reminders must filter before pagination');
assert.equal(pendingPage.pagination.hasMore, false);
assert.equal((await getBillingOverview(ownerB, db, { page: 2 })).invoices.length, 0, 'pagination must not expose another business');
assert.equal((await getBillingOverview(ownerB, db)).stats.totalBills, 1);
for (const page of [0, -1, 1.5, NaN, 1_000_001]) await assert.rejects(() => getBillingOverview(ownerA, db, { page }), /Invalid bill history page/);
console.log('Invoice pagination, old reminders, totals and business isolation passed');

// No provider is contacted: test the durable claim under overlapping requests.
const originalFetch = globalThis.fetch;
process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone";
process.env.WHATSAPP_BILL_TEMPLATE_NAME = "test-template";
let sends = 0;
let release!: () => void;
let started!: () => void;
const entered = new Promise<void>(resolve => { started = resolve; });
const gate = new Promise<void>(resolve => { release = resolve; });
globalThis.fetch = async () => { sends++; started(); await gate; return Response.json({ messages: [{ id: "mock-message" }] }); };
try {
  const sending = sendPreparedInvoiceDelivery(ownerA, first.id, "https://preview.example.test", db);
  await entered;
  const concurrent = await sendPreparedInvoiceDelivery(ownerA, first.id, "https://preview.example.test", db);
  assert.equal(concurrent.status, "failed");
  assert.equal(sends, 1);
  release();
  assert.equal((await sending).status, "sent");
  assert.equal((await sendPreparedInvoiceDelivery(ownerA, first.id, "https://preview.example.test", db)).status, "sent");
  assert.equal(sends, 1, "confirmed delivery must not resend");
  globalThis.fetch = async () => { sends++; throw new Error("Connection lost after send"); };
  assert.equal((await sendPreparedInvoiceDelivery(ownerA, second.id, "https://preview.example.test", db)).status, "failed");
  await prepareInvoiceDelivery(ownerA, second.id, "https://preview.example.test", db);
  await sendPreparedInvoiceDelivery(ownerA, second.id, "https://preview.example.test", db);
  assert.equal(sends, 2, "uncertain delivery must not retry after preparing again");
  await assert.rejects(() => sendPreparedInvoiceDelivery(ownerB, first.id, "https://preview.example.test", db));
  await assert.rejects(() => reviewInvoiceDelivery(ownerB, second.id, "Checked provider records", db), /Bill not found/);
  await assert.rejects(() => reviewInvoiceDelivery(ownerA, second.id, "short", db), /10–500/);
  await assert.rejects(() => reviewInvoiceDelivery(ownerA, first.id, "Already accepted by provider", db), /no uncertain/);
  await reviewInvoiceDelivery(ownerA, second.id, "Checked chat: awaiting customer confirmation", db);
  const reviewed = await db.execute({ sql: "SELECT review_note, reviewed_at, automatic_attempted_at, status FROM invoice_deliveries WHERE invoice_id = ?", args: [second.id] });
  assert.match(String(reviewed.rows[0].review_note), /awaiting customer/);
  assert.ok(reviewed.rows[0].reviewed_at);
  assert.ok(reviewed.rows[0].automatic_attempted_at);
  assert.equal(reviewed.rows[0].status, "failed");
  await sendPreparedInvoiceDelivery(ownerA, second.id, "https://preview.example.test", db);
  assert.equal(sends, 2, "review must not release the automatic-send claim");
  const reviewOverview = await getBillingOverview(ownerA, db, { pendingOnly: true });
  assert.match(String(reviewOverview.invoices.find(i => Number(i.id) === second.id)?.deliveryReviewNote), /awaiting customer/);
} finally { globalThis.fetch = originalFetch; release(); }
console.log("Automatic delivery concurrency, confirmed-send replay, lost response and ownership checks passed");
await db.close();
