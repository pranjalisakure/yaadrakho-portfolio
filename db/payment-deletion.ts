import { ensureRazorpayTables, getClient, type PreparedStatement } from ".";

// Hold the same write lock used by checkout creation while checking and deleting.
export async function deleteWithPaymentGuard(ownerId: number, customerId: number | null, statements: PreparedStatement[]) {
  await ensureRazorpayTables();
  const transaction = await getClient().transaction("write");
  try {
    const open = await transaction.execute({
      sql: "SELECT id FROM razorpay_orders WHERE owner_user_id = ? AND (? IS NULL OR customer_id = ?) AND status IN ('creating','created') LIMIT 1",
      args: [ownerId, customerId, customerId],
    });
    const unresolved = await transaction.execute({
      sql: "SELECT payment_id FROM razorpay_captures WHERE owner_user_id = ? AND status != 'applied' AND NOT EXISTS (SELECT 1 FROM payment_reconciliations r WHERE r.payment_id = razorpay_captures.payment_id) AND (? IS NULL OR due_id IN (SELECT id FROM payment_dues WHERE customer_id = ? AND owner_user_id = ?)) LIMIT 1",
      args: [ownerId, customerId, customerId, ownerId],
    });
    if (open.rows.length || unresolved.rows.length) throw new Error("An online payment is open or needs review. Resolve it before deleting this payment history.");
    await transaction.execute({ sql: "DELETE FROM order_recovery_attempts WHERE local_order_id IN (SELECT id FROM razorpay_orders WHERE owner_user_id = ? AND (? IS NULL OR customer_id = ?))", args: [ownerId, customerId, customerId] });
    await transaction.execute({ sql: "DELETE FROM payment_reconciliations WHERE payment_id IN (SELECT payment_id FROM razorpay_captures WHERE owner_user_id = ? AND (? IS NULL OR due_id IN (SELECT id FROM payment_dues WHERE customer_id = ? AND owner_user_id = ?)))", args: [ownerId, customerId, customerId, ownerId] });
    await transaction.execute({ sql: "DELETE FROM payment_review_attempts WHERE payment_id IN (SELECT payment_id FROM razorpay_captures WHERE owner_user_id = ? AND (? IS NULL OR due_id IN (SELECT id FROM payment_dues WHERE customer_id = ? AND owner_user_id = ?)))", args: [ownerId, customerId, customerId, ownerId] });
    await transaction.execute({ sql: "DELETE FROM razorpay_captures WHERE owner_user_id = ? AND (? IS NULL OR due_id IN (SELECT id FROM payment_dues WHERE customer_id = ? AND owner_user_id = ?))", args: [ownerId, customerId, customerId, ownerId] });
    for (const { sql, args } of statements) await transaction.execute({ sql, args });
    await transaction.commit();
  } finally {
    transaction.close();
  }
}
