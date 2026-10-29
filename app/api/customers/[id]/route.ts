import { deleteWithPaymentGuard } from "../../../../db/payment-deletion";
import { updateCustomerDetails } from "../../../../db/customer-update";
import { ensureBillingTables, ensurePaymentLedgerTables, ensureRazorpayTables, getClient, getSqlDatabase } from "../../../../db";
import { backfillCustomerPhoneKeys, normalizeCustomerPhone } from "../../../../db/customer-identity";
import { getOwnerLedger } from "../../../../db/payment-ledger";
import { customers } from "../../../../db/schema";
import { getCurrentUser } from "../../../auth";

type Params = { params: Promise<{ id: string }> };

async function duplicateCustomerResponse(user: { id: number; storageKey: string }, customerId: number) {
  const ledger = await getOwnerLedger(user);
  return Response.json({
    error: "This phone number belongs to an existing customer.",
    duplicateCustomer: ledger.customers.find((item) => Number(item.id) === customerId),
  }, { status: 409 });
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
    await ensurePaymentLedgerTables();
    const id = Number((await params).id);
    if (!Number.isInteger(id)) return Response.json({ error: "Invalid customer ID" }, { status: 400 });
    const payload = await request.json() as Record<string, unknown>;
    const allowed: Partial<typeof customers.$inferInsert> & { updatedAt: number } = { updatedAt: Date.now() };
    for (const key of ["name", "phone", "requirement", "amount", "followUpDate", "status", "paymentStatus", "billingCycle", "notes", "contactConsent"]) {
      if (payload[key] !== undefined) {
        const value = String(payload[key]).trim();
        if (key === "name") allowed.name = value;
        if (key === "phone") {
          allowed.phone = value;
          allowed.phoneKey = normalizeCustomerPhone(value);
        }
        if (key === "requirement") allowed.requirement = value;
        if (key === "amount") allowed.amount = Math.max(0, Math.round(Number(payload[key]) || 0));
        if (key === "followUpDate") allowed.followUpDate = value;
        if (key === "status" && ["new", "follow_up", "won", "lost"].includes(value)) allowed.status = value as "new" | "follow_up" | "won" | "lost";
        if (key === "paymentStatus" && ["pending", "partial", "paid"].includes(value)) allowed.paymentStatus = value as "pending" | "partial" | "paid";
        if (key === "billingCycle" && ["one_time", "monthly"].includes(value)) allowed.billingCycle = value as "one_time" | "monthly";
        if (key === "notes") allowed.notes = value;
        if (key === "contactConsent") allowed.contactConsent = payload[key] === true;
      }
    }
    if (allowed.followUpDate && /^\d{4}-\d{2}-\d{2}$/.test(allowed.followUpDate)) {
      allowed.recurringDay = Math.min(31, Math.max(1, Number(allowed.followUpDate.slice(-2)) || 1));
    }
    if (allowed.billingCycle === "monthly") {
      if (allowed.paymentStatus === "paid") allowed.paymentStatus = "pending";
      if (allowed.status === "won" || allowed.status === "lost") allowed.status = "follow_up";
    }
    if (allowed.name === "" || allowed.phone === "" || allowed.phoneKey === "") return Response.json({ error: "Name and phone number are required" }, { status: 400 });
    if (allowed.phoneKey) {
      const duplicate = await getSqlDatabase().prepare("SELECT id FROM customers WHERE owner_user_id = ? AND phone_key = ? AND id != ? LIMIT 1")
        .bind(user.id, allowed.phoneKey, id).first<{ id: number }>();
      if (duplicate) return duplicateCustomerResponse(user, Number(duplicate.id));
    }
    await updateCustomerDetails(user, id, allowed);
    const ledger = await getOwnerLedger(user);
    const customer = ledger.customers.find(item => Number(item.id) === id);
    await backfillCustomerPhoneKeys(getClient(), user.id);
    return Response.json({ customer });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Customer could not be updated" }, { status: 400 });
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
  await Promise.all([ensurePaymentLedgerTables(), ensureBillingTables(), ensureRazorpayTables()]);
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return Response.json({ error: "Invalid customer ID" }, { status: 400 });
  const db = getSqlDatabase();
  try {
    await deleteWithPaymentGuard(user.id, id, [
      db.prepare("DELETE FROM razorpay_orders WHERE customer_id = ? AND owner_user_id = ?").bind(id, user.id),
      db.prepare("DELETE FROM invoice_deliveries WHERE invoice_id IN (SELECT id FROM invoices WHERE customer_id = ? AND owner_user_id = ?)").bind(id, user.id),
      db.prepare("DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE customer_id = ? AND owner_user_id = ?)").bind(id, user.id),
      db.prepare("DELETE FROM invoices WHERE customer_id = ? AND owner_user_id = ?").bind(id, user.id),
      db.prepare("DELETE FROM payment_transactions WHERE customer_id = ? AND owner_user_id = ?").bind(id, user.id),
      db.prepare("DELETE FROM payment_dues WHERE customer_id = ? AND owner_user_id = ?").bind(id, user.id),
      db.prepare("DELETE FROM customer_payments WHERE customer_id = ? AND (owner_user_id = ? OR owner_email = ?)").bind(id, user.id, user.storageKey),
      db.prepare("DELETE FROM customers WHERE id = ? AND owner_user_id = ? AND owner_email = ?").bind(id, user.id, user.storageKey),
    ]);
    await backfillCustomerPhoneKeys(getClient(), user.id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Customer data could not be deleted" }, { status: 409 });
  }
}
