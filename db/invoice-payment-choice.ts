import { ensureRazorpayTables, getClient } from ".";

export async function setInvoicePaymentChoice(user: { id: number; storageKey: string }, invoiceId: number, choice: unknown) {
  if (choice !== "online" && choice !== "cash") throw new Error("Choose Online or Cash for the remaining payment");
  await ensureRazorpayTables();
  const transaction = await getClient().transaction("write");
  try {
    const result = await transaction.execute({ sql: "SELECT remaining_payment, status, total_amount, amount_paid FROM invoices WHERE id = ? AND owner_user_id = ? AND owner_key = ?", args: [invoiceId, user.id, user.storageKey] });
    const invoice = result.rows[0];
    if (!invoice) throw new Error("Bill not found");
    if (invoice.status === "cancelled" || Number(invoice.total_amount) <= Number(invoice.amount_paid)) throw new Error("This bill has no remaining payment");
    if (choice === "cash" && invoice.remaining_payment !== "cash") {
      const orders = await transaction.execute({ sql: "SELECT id FROM razorpay_orders WHERE invoice_id = ? AND owner_user_id = ? AND status IN ('creating','created') LIMIT 1", args: [invoiceId, user.id] });
      const captures = await transaction.execute({ sql: "SELECT payment_id FROM razorpay_captures WHERE invoice_id = ? AND owner_user_id = ? AND status != 'applied' AND NOT EXISTS (SELECT 1 FROM payment_reconciliations r WHERE r.payment_id = razorpay_captures.payment_id) LIMIT 1", args: [invoiceId, user.id] });
      if (orders.rows.length || captures.rows.length) throw new Error("An online payment is open or needs review. Resolve it before changing the balance to Cash.");
    }
    await transaction.execute({ sql: "UPDATE invoices SET remaining_payment = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?", args: [choice, Date.now(), invoiceId, user.id] });
    await transaction.commit();
  } finally { transaction.close(); }
}
