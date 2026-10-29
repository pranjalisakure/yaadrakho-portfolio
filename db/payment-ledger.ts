import type { Client } from "@libsql/client";
import { randomBytes } from "node:crypto";
import { ensurePaymentLedgerTables, getClient } from ".";
import { normalizeCustomerPhone } from "./customer-identity";

type LedgerUser = { id: number; storageKey: string };
type PaymentInput = {
  amount: number;
  method?: string;
  reference?: string;
  note?: string;
  idempotencyKey: string;
  expectedDueDate?: string;
  dueId?: number;
  receivedAt?: number;
};

type DueRow = {
  id: number;
  customer_id: number;
  period_key: string;
  due_date: string;
  amount_due: number;
  amount_paid: number;
  status: "pending" | "partial" | "paid";
};

type CustomerRow = {
  id: number;
  name: string;
  amount: number;
  follow_up_date: string;
  billing_cycle: "one_time" | "monthly";
  recurring_day: number;
};

export class PaymentBalanceConflict extends Error {}

const methods = new Set(["cash", "upi", "paytm", "bank", "other"]);

function nextMonthlyDue(currentDueDate: string, recurringDay: number) {
  const [year, month] = currentDueDate.split("-").map(Number);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  const day = Math.min(Math.max(recurringDay, 1), lastDay);
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function integerAmount(value: unknown) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Payment amount must be a positive whole number");
  return amount;
}

export async function ensureCustomerCurrentDue(user: LedgerUser, customerId: number, database: Client = getClient()) {
  const result = await database.execute({
    sql: `SELECT c.id, c.amount, c.follow_up_date, c.billing_cycle, c.current_due_id
      FROM customers c WHERE c.id = ? AND c.owner_user_id = ? AND c.owner_email = ? LIMIT 1`,
    args: [customerId, user.id, user.storageKey],
  });
  const customer = result.rows[0] as unknown as { id: number; amount: number; follow_up_date: string; billing_cycle: string; current_due_id: number | null } | undefined;
  if (!customer) return null;
  if (customer.current_due_id) return Number(customer.current_due_id);
  const periodKey = customer.billing_cycle === "monthly" ? customer.follow_up_date.slice(0, 7) : `one-time:${customer.id}`;
  const now = Date.now();
  await database.execute({
    sql: `INSERT OR IGNORE INTO payment_dues
      (owner_user_id, owner_key, customer_id, period_key, due_date, amount_due, amount_paid, status, paid_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', NULL, ?, ?)`,
    args: [user.id, user.storageKey, customer.id, periodKey, customer.follow_up_date, customer.amount, now, now],
  });
  const due = await database.execute({ sql: "SELECT id FROM payment_dues WHERE owner_user_id = ? AND customer_id = ? AND period_key = ?", args: [user.id, customer.id, periodKey] });
  const dueId = Number(due.rows[0]?.id || 0);
  if (dueId) await database.execute({ sql: "UPDATE customers SET current_due_id = ? WHERE id = ? AND owner_user_id = ?", args: [dueId, customer.id, user.id] });
  return dueId || null;
}

export async function getOwnerLedger(user: LedgerUser, database: Client = getClient()) {
  await ensurePaymentLedgerTables();
  const result = await database.execute({
    sql: `SELECT c.*, pd.amount_due, pd.amount_paid, pd.status AS ledger_status, pd.id AS ledger_due_id,
      COALESCE((SELECT SUM(all_pd.amount_due - all_pd.amount_paid) FROM payment_dues all_pd
        WHERE all_pd.owner_user_id = c.owner_user_id AND all_pd.customer_id = c.id
          AND all_pd.status != 'paid' AND all_pd.amount_paid < all_pd.amount_due), 0) AS total_outstanding,
      COALESCE((SELECT SUM(all_pt.amount) FROM payment_transactions all_pt
        WHERE all_pt.owner_user_id = c.owner_user_id AND all_pt.customer_id = c.id), 0) AS total_amount_paid
      FROM customers c LEFT JOIN payment_dues pd ON pd.id = c.current_due_id AND pd.owner_user_id = ?
      WHERE c.owner_user_id = ? AND c.owner_email = ? ORDER BY c.updated_at DESC, c.id DESC`,
    args: [user.id, user.id, user.storageKey],
  });
  const canonicalCustomerByPhone = new Map<string, number>();
  for (const row of result.rows) {
    const phoneKey = normalizeCustomerPhone(row.phone);
    const customerId = Number(row.id);
    if (!phoneKey || !customerId) continue;
    if (String(row.phone_key || "") === phoneKey || !canonicalCustomerByPhone.has(phoneKey)) {
      canonicalCustomerByPhone.set(phoneKey, customerId);
    }
  }
  const customers = result.rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name),
    phone: String(row.phone),
    requirement: String(row.requirement || ""),
    amount: Number(row.amount || 0),
    followUpDate: String(row.follow_up_date),
    status: String(row.status),
    paymentStatus: String(row.ledger_status || row.payment_status),
    billingCycle: String(row.billing_cycle),
    recurringDay: Number(row.recurring_day || 1),
    notes: String(row.notes || ""),
    contactConsent: Number(row.contact_consent || 0) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    duplicateOfId: (() => {
      const canonicalId = canonicalCustomerByPhone.get(normalizeCustomerPhone(row.phone));
      return canonicalId && canonicalId !== Number(row.id) ? canonicalId : undefined;
    })(),
    outstandingAmount: Math.max(0, Number(row.total_outstanding || 0)),
    amountPaid: Number(row.total_amount_paid || 0),
  }));
  const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const statResult = await database.execute({
    sql: `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM payment_dues due_today WHERE due_today.owner_user_id = c.owner_user_id
        AND due_today.customer_id = c.id AND due_today.status != 'paid' AND due_today.amount_paid < due_today.amount_due
        AND due_today.due_date = ?) THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM payment_dues due_late WHERE due_late.owner_user_id = c.owner_user_id
        AND due_late.customer_id = c.id AND due_late.status != 'paid' AND due_late.amount_paid < due_late.amount_due
        AND due_late.due_date < ?) THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN c.billing_cycle = 'monthly' THEN 1 ELSE 0 END) AS monthly,
      SUM(CASE WHEN c.status = 'won' THEN 1 ELSE 0 END) AS won,
      SUM(COALESCE((SELECT SUM(due_open.amount_due - due_open.amount_paid) FROM payment_dues due_open
        WHERE due_open.owner_user_id = c.owner_user_id AND due_open.customer_id = c.id
          AND due_open.status != 'paid' AND due_open.amount_paid < due_open.amount_due), 0)) AS outstanding_amount
      FROM customers c
      WHERE c.owner_user_id = ? AND c.owner_email = ?`,
    args: [dateKey, dateKey, user.id, user.storageKey],
  });
  const row = statResult.rows[0];
  return {
    customers,
    stats: {
      total: Number(row?.total || 0), today: Number(row?.today || 0), overdue: Number(row?.overdue || 0),
      monthly: Number(row?.monthly || 0), won: Number(row?.won || 0), outstandingAmount: Number(row?.outstanding_amount || 0),
    },
  };
}

export async function getCustomerLedger(user: LedgerUser, customerId: number, database: Client = getClient()) {
  await ensurePaymentLedgerTables();
  await ensureCustomerCurrentDue(user, customerId, database);
  const owned = await database.execute({ sql: "SELECT id, current_due_id AS currentDueId FROM customers WHERE id = ? AND owner_user_id = ? AND owner_email = ?", args: [customerId, user.id, user.storageKey] });
  if (!owned.rows[0]) return null;
  const dues = await database.execute({
    sql: `SELECT id, customer_id AS customerId, period_key AS periodKey, due_date AS dueDate,
      amount_due AS amountDue, amount_paid AS amountPaid, status, paid_at AS paidAt, created_at AS createdAt, updated_at AS updatedAt
      FROM payment_dues WHERE owner_user_id = ? AND customer_id = ? ORDER BY due_date DESC, id DESC`,
    args: [user.id, customerId],
  });
  const transactions = await database.execute({
    sql: `SELECT id, customer_id AS customerId, due_id AS dueId, amount, method, reference, note,
      receipt_number AS receiptNumber, receipt_token AS receiptToken, balance_after AS balanceAfter,
      received_at AS receivedAt, created_at AS createdAt FROM payment_transactions
      WHERE owner_user_id = ? AND customer_id = ? ORDER BY received_at DESC, id DESC`,
    args: [user.id, customerId],
  });
  return {
    currentDueId: Number(owned.rows[0].currentDueId || 0) || null,
    dues: dues.rows,
    transactions: transactions.rows,
  };
}

export async function recordLedgerPayment(user: LedgerUser, customerId: number, input: PaymentInput, database: Client = getClient()) {
  await ensurePaymentLedgerTables();
  const amount = integerAmount(input.amount);
  const idempotencyKey = String(input.idempotencyKey || "").trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 120) throw new Error("A valid idempotency key is required");
  const method = methods.has(String(input.method)) ? String(input.method) : "other";
  const transaction = await database.transaction("write");
  try {
    const customerResult = await transaction.execute({
      sql: `SELECT id, name, amount, follow_up_date, billing_cycle, recurring_day
        FROM customers WHERE id = ? AND owner_user_id = ? AND owner_email = ? LIMIT 1`,
      args: [customerId, user.id, user.storageKey],
    });
    const customer = customerResult.rows[0] as unknown as CustomerRow | undefined;
    if (!customer) throw new Error("Customer not found");
    const existing = await transaction.execute({ sql: "SELECT id, customer_id, due_id, amount FROM payment_transactions WHERE owner_user_id = ? AND idempotency_key = ? LIMIT 1", args: [user.id, idempotencyKey] });
    if (existing.rows[0]) {
      if (Number(existing.rows[0].customer_id) !== customerId || (input.dueId && Number(existing.rows[0].due_id) !== Number(input.dueId)) || Number(existing.rows[0].amount) !== amount) throw new Error("This payment request key was already used for a different customer, due, or amount");
      await transaction.commit();
      return { duplicate: true, paymentId: Number(existing.rows[0].id), ...(await getCustomerLedger(user, customerId, database)) };
    }
    const requestedDueId = Number(input.dueId || 0);
    const dueResult = await transaction.execute({
      sql: requestedDueId
        ? `SELECT pd.id, pd.customer_id, pd.period_key, pd.due_date, pd.amount_due, pd.amount_paid, pd.status
          FROM payment_dues pd WHERE pd.id = ? AND pd.owner_user_id = ? AND pd.customer_id = ? LIMIT 1`
        : `SELECT pd.id, pd.customer_id, pd.period_key, pd.due_date, pd.amount_due, pd.amount_paid, pd.status
          FROM payment_dues pd JOIN customers c ON c.current_due_id = pd.id
          WHERE pd.owner_user_id = ? AND pd.customer_id = ? AND c.owner_user_id = ? LIMIT 1`,
      args: requestedDueId ? [requestedDueId, user.id, customerId] : [user.id, customerId, user.id],
    });
    const due = dueResult.rows[0] as unknown as DueRow | undefined;
    if (!due) throw new Error("Current payment due was not found. Refresh and try again.");
    if (input.expectedDueDate && input.expectedDueDate !== due.due_date) throw new Error("This due date was already updated. Refresh and check the current balance.");
    const remaining = Number(due.amount_due) - Number(due.amount_paid);
    if (amount > remaining) throw new PaymentBalanceConflict(`Payment cannot be more than the remaining amount of ₹${remaining}`);
    const now = Date.now();
    const receivedAt = input.receivedAt === undefined ? now : Number(input.receivedAt);
    if (!Number.isSafeInteger(receivedAt) || receivedAt < Date.UTC(2000, 0, 1) || receivedAt > now + 300_000) {
      throw new Error("Enter a valid payment received date");
    }
    const newPaid = Number(due.amount_paid) + amount;
    const balanceAfter = Math.max(0, Number(due.amount_due) - newPaid);
    const status = newPaid === Number(due.amount_due) ? "paid" : "partial";
    const insertedPayment = await transaction.execute({
      sql: `INSERT INTO payment_transactions
        (owner_user_id, owner_key, customer_id, due_id, idempotency_key, amount, method, reference, note, received_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [user.id, user.storageKey, customerId, due.id, idempotencyKey, amount, method, String(input.reference || "").trim(), String(input.note || "").trim(), receivedAt, now],
    });
    const paymentId = Number(insertedPayment.lastInsertRowid);
    const receiptYear = new Date(receivedAt).getUTCFullYear();
    await transaction.execute({
      sql: `UPDATE payment_transactions SET receipt_number = ?, receipt_token = ?, balance_after = ?
        WHERE id = ? AND owner_user_id = ?`,
      args: [`YR-R-${receiptYear}-${String(paymentId).padStart(6, "0")}`, randomBytes(16).toString("hex"), balanceAfter, paymentId, user.id],
    });
    await transaction.execute({ sql: "UPDATE payment_dues SET amount_paid = ?, status = ?, paid_at = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?", args: [newPaid, status, status === "paid" ? receivedAt : null, now, due.id, user.id] });
    const billingTable = await transaction.execute({ sql: "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'invoices' LIMIT 1", args: [] });
    if (billingTable.rows[0]) {
      await transaction.execute({
        sql: `UPDATE invoices SET amount_paid = ?, status = ?, updated_at = ?
          WHERE due_id = ? AND owner_user_id = ? AND status != 'cancelled'`,
        args: [newPaid, status === "paid" ? "paid" : "partial", now, due.id, user.id],
      });
    }
    let nextDueDate: string | null = null;
    if (status === "partial") {
      await transaction.execute({ sql: "UPDATE customers SET payment_status = 'partial', updated_at = ? WHERE id = ? AND owner_user_id = ?", args: [now, customerId, user.id] });
    } else if (customer.billing_cycle === "monthly" && !due.period_key.startsWith("invoice:")) {
      await transaction.execute({
        sql: `INSERT INTO customer_payments (customer_id, owner_email, owner_user_id, period_key, amount, due_date, status, paid_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'paid', ?, ?) ON CONFLICT(customer_id, period_key) DO UPDATE SET amount = excluded.amount,
          owner_user_id = excluded.owner_user_id, status = 'paid', paid_at = excluded.paid_at`,
        args: [customerId, user.storageKey, user.id, due.period_key, due.amount_due, due.due_date, receivedAt, now],
      });
      nextDueDate = nextMonthlyDue(due.due_date, Number(customer.recurring_day));
      const nextPeriod = nextDueDate.slice(0, 7);
      await transaction.execute({
        sql: `INSERT OR IGNORE INTO payment_dues
          (owner_user_id, owner_key, customer_id, period_key, due_date, amount_due, amount_paid, status, paid_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', NULL, ?, ?)`,
        args: [user.id, user.storageKey, customerId, nextPeriod, nextDueDate, customer.amount, now, now],
      });
      const next = await transaction.execute({ sql: "SELECT id FROM payment_dues WHERE owner_user_id = ? AND customer_id = ? AND period_key = ?", args: [user.id, customerId, nextPeriod] });
      await transaction.execute({ sql: "UPDATE customers SET current_due_id = ?, follow_up_date = ?, payment_status = 'pending', status = 'follow_up', updated_at = ? WHERE id = ? AND owner_user_id = ?", args: [Number(next.rows[0]?.id), nextDueDate, now, customerId, user.id] });
    } else {
      const nextOutstanding = await transaction.execute({
        sql: `SELECT id, due_date, amount_due, amount_paid, status FROM payment_dues
          WHERE owner_user_id = ? AND customer_id = ? AND id != ? AND status != 'paid' AND amount_paid < amount_due
          ORDER BY due_date, id LIMIT 1`,
        args: [user.id, customerId, due.id],
      });
      const next = nextOutstanding.rows[0];
      if (next) {
        await transaction.execute({
          sql: `UPDATE customers SET current_due_id = ?, follow_up_date = ?, amount = ?, payment_status = ?,
            status = 'follow_up', updated_at = ? WHERE id = ? AND owner_user_id = ?`,
          args: [Number(next.id), String(next.due_date), Number(next.amount_due), Number(next.amount_paid) > 0 ? "partial" : "pending", now, customerId, user.id],
        });
      } else {
        await transaction.execute({ sql: "UPDATE customers SET payment_status = 'paid', status = 'won', updated_at = ? WHERE id = ? AND owner_user_id = ?", args: [now, customerId, user.id] });
      }
    }
    await transaction.commit();
    return { duplicate: false, paymentId, nextDueDate, ...(await getCustomerLedger(user, customerId, database)) };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}
