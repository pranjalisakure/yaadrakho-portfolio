import type { Client } from "@libsql/client";
import { ensureAppSettingsTable, ensureBillingTables, getClient } from ".";
import { normalizeCustomerPhone } from "./customer-identity";

type ReceiptUser = { id: number; storageKey: string };

const receiptSelect = `SELECT pt.id, pt.receipt_number AS receiptNumber, pt.receipt_token AS receiptToken,
  pt.amount, pt.method, pt.reference, pt.note, pt.balance_after AS balanceAfter,
  pt.received_at AS receivedAt, pt.created_at AS createdAt,
  c.id AS customerId, c.name AS customerName, c.phone AS customerPhone,
  pd.period_key AS periodKey, pd.due_date AS dueDate, pd.amount_due AS amountDue,
  pd.amount_due - pd.amount_paid AS currentRemaining, i.public_token AS billToken, i.remaining_payment AS remainingPayment, i.status AS invoiceStatus,
  i.id AS invoiceId, i.invoice_number AS invoiceNumber, i.total_amount AS invoiceTotal,
  COALESCE(NULLIF(settings.business_name, ''), NULLIF(user.display_name, ''), 'Business') AS businessName,
  COALESCE(settings.phone, '') AS businessPhone
  FROM payment_transactions pt
  JOIN customers c ON c.id = pt.customer_id AND c.owner_user_id = pt.owner_user_id
  JOIN payment_dues pd ON pd.id = pt.due_id AND pd.owner_user_id = pt.owner_user_id
  JOIN users user ON user.id = pt.owner_user_id
  LEFT JOIN app_settings settings ON settings.user_email = pt.owner_key
  LEFT JOIN invoices i ON i.due_id = pt.due_id AND i.owner_user_id = pt.owner_user_id`;

function normalizeReceipt(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return {
    id: Number(row.id),
    receiptNumber: String(row.receiptNumber || ""),
    receiptToken: String(row.receiptToken || ""),
    amount: Number(row.amount || 0),
    method: String(row.method || "other"),
    reference: String(row.reference || ""),
    note: String(row.note || ""),
    balanceAfter: Math.max(0, Number(row.balanceAfter || 0)),
    receivedAt: Number(row.receivedAt),
    createdAt: Number(row.createdAt),
    customerId: Number(row.customerId),
    customerName: String(row.customerName || ""),
    customerPhone: String(row.customerPhone || ""),
    periodKey: String(row.periodKey || ""),
    dueDate: String(row.dueDate || ""),
    amountDue: Number(row.amountDue || 0),
    currentRemaining: Math.max(0, Number(row.currentRemaining || 0)),
    billToken: String(row.billToken || ""),
    remainingPayment: String(row.remainingPayment || "cash"),
    invoiceStatus: String(row.invoiceStatus || ""),
    invoiceId: row.invoiceId ? Number(row.invoiceId) : null,
    invoiceNumber: String(row.invoiceNumber || ""),
    invoiceTotal: Number(row.invoiceTotal || row.amountDue || 0),
    businessName: String(row.businessName || "Business"),
    businessPhone: String(row.businessPhone || ""),
  };
}

async function ready() {
  await Promise.all([ensureBillingTables(), ensureAppSettingsTable()]);
}

export async function getPublicReceipt(token: string, database: Client = getClient()) {
  await ready();
  const result = await database.execute({
    sql: `${receiptSelect} WHERE pt.receipt_token = ? LIMIT 1`,
    args: [String(token || "").trim()],
  });
  return normalizeReceipt(result.rows[0] as unknown as Record<string, unknown> | undefined);
}

export async function getOwnerReceipt(user: ReceiptUser, receiptId: number, database: Client = getClient()) {
  await ready();
  const result = await database.execute({
    sql: `${receiptSelect} WHERE pt.id = ? AND pt.owner_user_id = ? AND pt.owner_key = ? LIMIT 1`,
    args: [receiptId, user.id, user.storageKey],
  });
  return normalizeReceipt(result.rows[0] as unknown as Record<string, unknown> | undefined);
}

export async function prepareReceiptDelivery(user: ReceiptUser, receiptId: number, appUrl: string, database: Client = getClient()) {
  const receipt = await getOwnerReceipt(user, receiptId, database);
  if (!receipt) throw new Error("Payment receipt was not found");
  const digits = normalizeCustomerPhone(receipt.customerPhone);
  if (digits.length !== 10) throw new Error("Customer phone number must contain 10 digits");
  const receiptUrl = `${appUrl.replace(/\/$/, "")}/receipt/${receipt.receiptToken}`;
  const paidDate = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" }).format(new Date(receipt.receivedAt));
  const message = [
    `Hello ${receipt.customerName},`,
    `Payment received by ${receipt.businessName}.`,
    `Receipt: ${receipt.receiptNumber}`,
    `Amount paid: ₹${receipt.amount.toLocaleString("en-IN")}`,
    `Method: ${receipt.method.toUpperCase()}`,
    receipt.reference ? `Transaction reference: ${receipt.reference}` : "",
    `Payment date: ${paidDate}`,
    `Balance after this payment: ₹${receipt.balanceAfter.toLocaleString("en-IN")}`,
    `Current remaining balance: ₹${receipt.currentRemaining.toLocaleString("en-IN")}`,
    receipt.currentRemaining > 0 ? `Payment due date: ${receipt.dueDate}` : "",
    receipt.currentRemaining > 0 && receipt.billToken ? `Remaining payment: ${receipt.remainingPayment === "cash" ? "Cash (no payment QR)" : "Online (open the receipt for the payment QR)"}` : "",
    `View receipt: ${receiptUrl}`,
  ].filter(Boolean).join("\n");
  return {
    receipt,
    receiptUrl,
    whatsappUrl: `https://wa.me/91${digits}?text=${encodeURIComponent(message)}`,
  };
}
