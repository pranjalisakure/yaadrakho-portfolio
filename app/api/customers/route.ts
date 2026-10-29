import { deleteWithPaymentGuard } from "../../../db/payment-deletion";
import { and, eq } from "drizzle-orm";
import { ensureBillingTables, ensurePaymentLedgerTables, ensureRazorpayTables, getDb, getSqlDatabase } from "../../../db";
import { normalizeCustomerPhone } from "../../../db/customer-identity";
import { getOwnerLedger } from "../../../db/payment-ledger";
import { customers } from "../../../db/schema";
import { getCurrentUser } from "../../auth";

const validStatus = new Set(["new", "follow_up", "won", "lost"]);
const validPayment = new Set(["pending", "partial", "paid"]);

function clean(payload: Record<string, unknown>) {
  const name = String(payload.name || "").trim();
  const phone = String(payload.phone || "").trim();
  const phoneKey = normalizeCustomerPhone(phone);
  const followUpDate = String(payload.followUpDate || "").trim();
  if (!name || !phone || !phoneKey || !/^\d{4}-\d{2}-\d{2}$/.test(followUpDate)) throw new Error("Name, phone number, and follow-up date are required");
  const status = validStatus.has(String(payload.status)) ? String(payload.status) as "new" | "follow_up" | "won" | "lost" : "new";
  const paymentStatus = validPayment.has(String(payload.paymentStatus)) ? String(payload.paymentStatus) as "pending" | "partial" | "paid" : "pending";
  const amount = Math.max(0, Math.round(Number(payload.amount) || 0));
  const contactConsent = payload.contactConsent === true;
  const billingCycle = payload.billingCycle === "monthly" ? "monthly" as const : "one_time" as const;
  const recurringDay = Math.min(31, Math.max(1, Number(followUpDate.slice(-2)) || 1));
  const activeStatus = billingCycle === "monthly" && ["won", "lost"].includes(status) ? "follow_up" as const : status;
  const ledgerPaymentStatus = amount > 0 && paymentStatus === "paid" ? "pending" as const : paymentStatus;
  const ledgerStatus = amount > 0 && activeStatus === "won" ? "new" as const : activeStatus;
  return { name, phone, phoneKey, followUpDate, status: ledgerStatus, paymentStatus: billingCycle === "monthly" && ledgerPaymentStatus === "paid" ? "pending" as const : ledgerPaymentStatus, billingCycle, recurringDay, amount, contactConsent, requirement: String(payload.requirement || "").trim(), notes: String(payload.notes || "").trim() };
}

async function duplicateCustomerResponse(user: { id: number; storageKey: string }, customerId: number) {
  const ledger = await getOwnerLedger(user);
  const duplicateCustomer = ledger.customers.find((item) => Number(item.id) === customerId);
  return Response.json({
    error: "This customer already exists. Open the existing customer to add payments or a new monthly due.",
    duplicateCustomer,
  }, { status: 409 });
}

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
    await ensurePaymentLedgerTables();
    return Response.json(await getOwnerLedger(user));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Customers could not be loaded" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
    await ensurePaymentLedgerTables();
    const values = clean(await request.json() as Record<string, unknown>);
    const existing = await getSqlDatabase().prepare("SELECT id FROM customers WHERE owner_user_id = ? AND phone_key = ? LIMIT 1")
      .bind(user.id, values.phoneKey).first<{ id: number }>();
    if (existing) return duplicateCustomerResponse(user, Number(existing.id));
    const now = Date.now();
    let inserted: { id: number } | undefined;
    try {
      [inserted] = await getDb().insert(customers).values({ ...values, ownerEmail: user.storageKey, ownerUserId: user.id, createdAt: now, updatedAt: now }).returning({ id: customers.id });
    } catch (error) {
      const racedDuplicate = await getSqlDatabase().prepare("SELECT id FROM customers WHERE owner_user_id = ? AND phone_key = ? LIMIT 1")
        .bind(user.id, values.phoneKey).first<{ id: number }>();
      if (racedDuplicate) return duplicateCustomerResponse(user, Number(racedDuplicate.id));
      throw error;
    }
    if (!inserted) throw new Error("Customer could not be saved");
    const [customer] = await getDb().select().from(customers).where(and(eq(customers.id, inserted.id), eq(customers.ownerEmail, user.storageKey))).limit(1);
    if (!customer) throw new Error("Customer could not be verified after saving");
    const periodKey = customer.billingCycle === "monthly" ? customer.followUpDate.slice(0, 7) : `one-time:${customer.id}`;
    const db = getSqlDatabase();
    await db.prepare(`INSERT INTO payment_dues
      (owner_user_id, owner_key, customer_id, period_key, due_date, amount_due, amount_paid, status, paid_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', NULL, ?, ?)`)
      .bind(user.id, user.storageKey, customer.id, periodKey, customer.followUpDate, customer.amount, now, now).run();
    const due = await db.prepare("SELECT id FROM payment_dues WHERE owner_user_id = ? AND customer_id = ? AND period_key = ?")
      .bind(user.id, customer.id, periodKey).first<{ id: number }>();
    if (!due) throw new Error("Customer payment due could not be created");
    await db.prepare("UPDATE customers SET current_due_id = ? WHERE id = ? AND owner_user_id = ?").bind(due.id, customer.id, user.id).run();
    const ledger = await getOwnerLedger(user);
    return Response.json({ customer: ledger.customers.find((item) => Number(item.id) === customer.id), stats: ledger.stats }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Customer could not be saved" }, { status: 400 });
  }
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
  await Promise.all([ensurePaymentLedgerTables(), ensureBillingTables(), ensureRazorpayTables()]);
  const db = getSqlDatabase();
  try {
    await deleteWithPaymentGuard(user.id, null, [
      db.prepare("DELETE FROM razorpay_orders WHERE owner_user_id = ?").bind(user.id),
      db.prepare("DELETE FROM invoice_deliveries WHERE invoice_id IN (SELECT id FROM invoices WHERE owner_user_id = ?)").bind(user.id),
      db.prepare("DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE owner_user_id = ?)").bind(user.id),
      db.prepare("DELETE FROM invoices WHERE owner_user_id = ?").bind(user.id),
      db.prepare("DELETE FROM payment_transactions WHERE owner_user_id = ?").bind(user.id),
      db.prepare("DELETE FROM payment_dues WHERE owner_user_id = ?").bind(user.id),
      db.prepare("DELETE FROM customer_payments WHERE owner_user_id = ? OR owner_email = ?").bind(user.id, user.storageKey),
      db.prepare("DELETE FROM customers WHERE owner_user_id = ? AND owner_email = ?").bind(user.id, user.storageKey),
    ]);
    return new Response(null, { status: 204 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Customer data could not be deleted" }, { status: 409 });
  }
}
