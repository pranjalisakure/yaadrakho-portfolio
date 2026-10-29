import type { Client, InValue } from "@libsql/client";
import { ensureBillingTables, getClient } from ".";
import type { customers } from "./schema";

const columns = {
  name: "name", phone: "phone", phoneKey: "phone_key", requirement: "requirement", amount: "amount",
  followUpDate: "follow_up_date", status: "status", paymentStatus: "payment_status", billingCycle: "billing_cycle",
  notes: "notes", contactConsent: "contact_consent", recurringDay: "recurring_day", updatedAt: "updated_at",
} as const;

export async function updateCustomerDetails(user: { id: number; storageKey: string }, customerId: number,
  changes: Partial<typeof customers.$inferInsert>, database: Client = getClient()) {
  await ensureBillingTables();
  const transaction = await database.transaction("write");
  try {
    const result = await transaction.execute({ sql: "SELECT * FROM customers WHERE id = ? AND owner_user_id = ? AND owner_email = ?", args: [customerId, user.id, user.storageKey] });
    const customer = result.rows[0];
    if (!customer) throw new Error("Customer not found");
    if (changes.followUpDate !== undefined) {
      const date = changes.followUpDate;
      const time = Date.parse(date + "T00:00:00Z");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) throw new Error("Enter a valid due date");
    }
    if (changes.amount !== undefined && (!Number.isSafeInteger(changes.amount) || changes.amount < 0)) throw new Error("Enter a valid whole-rupee amount");
    const dueResult = await transaction.execute({ sql: "SELECT * FROM payment_dues WHERE id = ? AND owner_user_id = ? AND customer_id = ?", args: [customer.current_due_id, user.id, customerId] });
    const due = dueResult.rows[0];
    if (due) {
      const invoice = await transaction.execute({ sql: "SELECT id FROM invoices WHERE due_id = ? AND owner_user_id = ? LIMIT 1", args: [due.id, user.id] });
      const termsChanged = (changes.amount !== undefined && changes.amount !== Number(customer.amount)) ||
        (changes.followUpDate !== undefined && changes.followUpDate !== customer.follow_up_date) ||
        (changes.billingCycle !== undefined && changes.billingCycle !== customer.billing_cycle);
      if (invoice.rows.length && termsChanged) throw new Error("Issued bill amounts and due dates cannot be changed from customer details. Create a new bill for new charges.");
      if (!invoice.rows.length && changes.amount !== undefined && changes.amount < Number(due.amount_paid)) throw new Error("Amount cannot be less than the payment already received");
      const outstanding = await transaction.execute({ sql: "SELECT COALESCE(SUM(amount_due - amount_paid), 0) AS amount FROM payment_dues WHERE customer_id = ? AND owner_user_id = ?", args: [customerId, user.id] });
      if (Number(outstanding.rows[0].amount) > 0 && (changes.paymentStatus === "paid" || changes.status === "won")) throw new Error("Record the received amount in Payment ledger before marking this customer paid");
      if (!invoice.rows.length && (changes.amount !== undefined || changes.followUpDate !== undefined)) {
        const amount = changes.amount ?? Number(due.amount_due);
        const paid = Number(due.amount_paid);
        await transaction.execute({ sql: "UPDATE payment_dues SET amount_due = ?, due_date = ?, status = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?", args: [amount, changes.followUpDate ?? due.due_date, amount === paid ? "paid" : paid ? "partial" : "pending", Date.now(), due.id, user.id] });
      }
    }
    const entries = Object.entries(columns).filter(([key]) => changes[key as keyof typeof columns] !== undefined);
    if (entries.length) {
      const args: InValue[] = entries.map(([key]) => { const value = changes[key as keyof typeof columns]; return typeof value === "boolean" ? Number(value) : value as InValue; });
      await transaction.execute({ sql: "UPDATE customers SET " + entries.map(([, column]) => column + " = ?").join(", ") + " WHERE id = ? AND owner_user_id = ?", args: [...args, customerId, user.id] });
    }
    await transaction.commit();
  } finally {
    transaction.close();
  }
}
