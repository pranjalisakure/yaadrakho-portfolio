import type { Client } from "@libsql/client";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { ensureRazorpayTables, getClient } from ".";
import { PaymentBalanceConflict, recordLedgerPayment } from "./payment-ledger";

type Fetcher = typeof fetch;

type RazorpayPayment = {
  id?: string;
  order_id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  captured?: boolean;
  method?: string;
  wallet?: string | null;
};

type LocalOrder = {
  id: number;
  owner_user_id: number;
  owner_key: string;
  customer_id: number;
  invoice_id: number;
  due_id: number;
  razorpay_order_id: string | null;
  amount: number;
  currency: string;
  status: string;
  payment_id: string | null;
  payment_account_id: number | null;
  provider_account_id: string | null;
  transfer_id: string | null;
  transfer_status: string;
};

export type PaymentAccountMode = "test" | "live";
export type PaymentAccountStatus = "pending" | "active" | "restricted" | "suspended";

type BusinessPaymentAccount = {
  id: number;
  owner_user_id: number;
  owner_key: string;
  provider_account_id: string | null;
  mode: PaymentAccountMode;
  status: PaymentAccountStatus;
};

type InvoicePaymentContext = {
  invoice_id: number;
  owner_user_id: number;
  owner_key: string;
  customer_id: number;
  due_id: number;
  invoice_number: string;
  invoice_status: string;
  remaining_payment: string;
  due_status: string;
  amount_due: number;
  amount_paid: number;
  customer_name: string;
};

function configuredRazorpay() {
  const enabled = process.env.RAZORPAY_ENABLED === "true";
  const keyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
  const webhookSecret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
  const allowLive = process.env.RAZORPAY_ALLOW_LIVE === "true";
  const routeEnabled = process.env.RAZORPAY_ROUTE_ENABLED === "true";
  if (!enabled || !keyId || !keySecret) {
    throw new Error("Online payment is not configured yet. Please use the business payment instructions.");
  }
  if (!allowLive && !keyId.startsWith("rzp_test_")) {
    throw new Error("Razorpay Test Mode is required until live payments are approved.");
  }
  const testMode = keyId.startsWith("rzp_test_");
  if (!testMode && !routeEnabled) {
    throw new Error("Live multi-business payments require Razorpay Route to be enabled.");
  }
  return { keyId, keySecret, webhookSecret, routeEnabled, testMode, mode: testMode ? "test" as const : "live" as const };
}

function legacyRazorpayAvailability() {
  const keyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
  return {
    enabled: process.env.RAZORPAY_ENABLED === "true" &&
      Boolean(keyId && process.env.RAZORPAY_KEY_SECRET) &&
      (process.env.RAZORPAY_ALLOW_LIVE === "true" || keyId.startsWith("rzp_test_")),
    testMode: keyId.startsWith("rzp_test_"),
  };
}

function previewSharedTestCheckoutEnabled(testMode: boolean) {
  return process.env.VERCEL_ENV === "preview"
    && process.env.RAZORPAY_PREVIEW_SHARED_TEST_MODE === "true"
    && testMode;
}

function validProviderAccountId(value: unknown) {
  const accountId = String(value || "").trim();
  if (!/^acc_[A-Za-z0-9]{8,32}$/.test(accountId)) {
    throw new Error("Enter a valid Razorpay linked account ID beginning with acc_.");
  }
  return accountId;
}

async function paymentAccountForOwner(ownerUserId: number, mode: PaymentAccountMode, database: Client) {
  const result = await database.execute({
    sql: `SELECT id, owner_user_id, owner_key, provider_account_id, mode, status
      FROM business_payment_accounts
      WHERE owner_user_id = ? AND provider = 'razorpay_route' AND mode = ? LIMIT 1`,
    args: [ownerUserId, mode],
  });
  return result.rows[0] as unknown as BusinessPaymentAccount | undefined;
}

export async function razorpayAvailability(ownerUserId?: number, database: Client = getClient()) {
  const legacy = legacyRazorpayAvailability();
  const routeEnabled = process.env.RAZORPAY_ROUTE_ENABLED === "true";
  const sharedPreviewCheckout = previewSharedTestCheckoutEnabled(legacy.testMode);
  if (!legacy.enabled || !routeEnabled || !ownerUserId || sharedPreviewCheckout) {
    return {
      ...legacy,
      enabled: legacy.enabled && (!routeEnabled || sharedPreviewCheckout),
      routeEnabled,
      accountStatus: sharedPreviewCheckout ? "preview_test" : routeEnabled ? "pending" : "legacy",
    };
  }
  await ensureRazorpayTables();
  const account = await paymentAccountForOwner(ownerUserId, legacy.testMode ? "test" : "live", database);
  return {
    ...legacy,
    enabled: Boolean(account?.status === "active" && account.provider_account_id),
    routeEnabled,
    accountStatus: account?.status || "pending",
    providerAccountId: account?.provider_account_id || "",
  };
}

export async function getBusinessPaymentAccountStatus(ownerUserId: number, database: Client = getClient()) {
  await ensureRazorpayTables();
  const keyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
  const mode: PaymentAccountMode = keyId.startsWith("rzp_test_") ? "test" : "live";
  const account = await paymentAccountForOwner(ownerUserId, mode, database);
  return {
    mode,
    routeEnabled: process.env.RAZORPAY_ROUTE_ENABLED === "true",
    status: account?.status || "pending",
    providerAccountId: account?.provider_account_id || "",
  };
}

export async function configureBusinessPaymentAccount(ownerUserId: number, input: { providerAccountId: unknown; status: PaymentAccountStatus }, database: Client = getClient()) {
  await ensureRazorpayTables();
  const providerAccountId = validProviderAccountId(input.providerAccountId);
  if (!["pending", "active", "restricted", "suspended"].includes(input.status)) throw new Error("Payment account status is invalid.");
  const user = await database.execute({ sql: "SELECT id, storage_key FROM users WHERE id = ? LIMIT 1", args: [ownerUserId] });
  if (!user.rows[0]) throw new Error("Business account was not found.");
  const now = Date.now();
  await database.execute({
    sql: `INSERT INTO business_payment_accounts
      (owner_user_id, owner_key, provider, mode, provider_account_id, status, created_at, updated_at, activated_at)
      VALUES (?, ?, 'razorpay_route', 'test', ?, ?, ?, ?, ?)
      ON CONFLICT(owner_user_id, provider, mode) DO UPDATE SET
        owner_key = excluded.owner_key, provider_account_id = excluded.provider_account_id,
        status = excluded.status, updated_at = excluded.updated_at,
        activated_at = CASE WHEN excluded.status = 'active' THEN excluded.updated_at ELSE business_payment_accounts.activated_at END`,
    args: [ownerUserId, String(user.rows[0].storage_key), providerAccountId, input.status, now, now, input.status === "active" ? now : null],
  });
  return getBusinessPaymentAccountStatus(ownerUserId, database);
}

function validRequestKey(value: unknown) {
  const key = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{12,120}$/.test(key)) throw new Error("Payment request key is invalid. Refresh and try again.");
  return key;
}

function validAmount(value: unknown) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter a valid whole-rupee payment amount.");
  return amount;
}

function safeHexEqual(expected: string, received: string) {
  if (!/^[a-f0-9]+$/i.test(received) || expected.length !== received.length) return false;
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(received, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string, secret: string) {
  const expected = createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
  return safeHexEqual(expected, signature);
}

export function verifyWebhookSignature(rawBody: string, signature: string, secret: string) {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeHexEqual(expected, signature);
}

export function fallbackWebhookEventId(rawBody: string) {
  return `body_${createHash("sha256").update(rawBody).digest("hex")}`;
}

async function ownedInvoice(publicToken: string, database: Pick<Client, "execute">) {
  if (!/^[a-f0-9]{32}$/i.test(publicToken)) throw new Error("This secure bill link is invalid.");
  const result = await database.execute({
    sql: `SELECT i.id AS invoice_id, i.owner_user_id, i.owner_key, i.customer_id, i.due_id,
      i.invoice_number, i.remaining_payment, i.status AS invoice_status, pd.status AS due_status,
      pd.amount_due, pd.amount_paid, c.name AS customer_name
      FROM invoices i
      JOIN payment_dues pd ON pd.id = i.due_id AND pd.owner_user_id = i.owner_user_id
      JOIN customers c ON c.id = i.customer_id AND c.owner_user_id = i.owner_user_id
      WHERE i.public_token = ? AND i.status != 'cancelled' LIMIT 1`,
    args: [publicToken],
  });
  const row = result.rows[0] as unknown as InvoicePaymentContext | undefined;
  if (!row) throw new Error("This bill is no longer available.");
  if (row.remaining_payment === "cash") throw new Error("The remaining balance is arranged for cash payment. Contact the business to change it to Online.");
  const remaining = Number(row.amount_due) - Number(row.amount_paid);
  if (String(row.due_status) === "paid" || remaining <= 0) throw new Error("This bill is already fully paid.");
  return { ...row, remaining };
}

function basicAuthorization(keyId: string, keySecret: string) {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
}

export async function createOnlinePaymentOrder(
  publicToken: string,
  inputAmount: unknown,
  inputRequestKey: unknown,
  database: Client = getClient(),
  fetcher: Fetcher = fetch,
) {
  await ensureRazorpayTables();
  const config = configuredRazorpay();
  const amount = validAmount(inputAmount);
  const requestKey = validRequestKey(inputRequestKey);
  const invoice = await ownedInvoice(publicToken, database);
  if (amount > invoice.remaining) throw new Error(`Payment cannot exceed the remaining amount of ₹${invoice.remaining}.`);
  let paymentAccount: BusinessPaymentAccount | undefined;
  const sharedPreviewCheckout = previewSharedTestCheckoutEnabled(config.testMode);
  const useRoute = config.routeEnabled && !sharedPreviewCheckout;
  if (useRoute) {
    paymentAccount = await paymentAccountForOwner(Number(invoice.owner_user_id), config.mode, database);
    if (!paymentAccount?.provider_account_id || paymentAccount.status !== "active") {
      throw new Error("This business has not completed its Razorpay payment account setup yet.");
    }
  }

  let localId: number;
  const reservation = await database.transaction("write");
  try {
    const review = await reservation.execute({
      sql: "SELECT payment_id FROM razorpay_captures WHERE invoice_id = ? AND owner_user_id = ? AND status != 'applied' AND NOT EXISTS (SELECT 1 FROM payment_reconciliations r WHERE r.payment_id = razorpay_captures.payment_id) LIMIT 1",
      args: [Number(invoice.invoice_id), Number(invoice.owner_user_id)],
    });
    if (review.rows.length) throw new Error("A payment has already been received and is awaiting review. Contact the business; do not pay again.");
    const existingResult = await reservation.execute({
      sql: `SELECT id, invoice_id, due_id, razorpay_order_id, amount, currency, status FROM razorpay_orders
        WHERE owner_user_id = ? AND request_key = ? LIMIT 1`,
      args: [Number(invoice.owner_user_id), requestKey],
    });
    const existing = existingResult.rows[0];
    if (existing) {
      if (Number(existing.invoice_id) !== Number(invoice.invoice_id) || Number(existing.due_id) !== Number(invoice.due_id)) throw new Error("This payment request belongs to another bill.");
      if (Number(existing.amount) !== amount) throw new Error("This payment request was already used for another amount.");
      if (existing.razorpay_order_id && ["created", "paid"].includes(String(existing.status))) {
        await reservation.commit();
        return {
          keyId: config.keyId,
          orderId: String(existing.razorpay_order_id),
          amount,
          amountPaise: amount * 100,
          currency: String(existing.currency),
          duplicate: true,
        };
      }
      if (existing.status === "creating") throw new Error("This payment attempt is awaiting confirmation. Contact the business before starting another payment.");
      throw new Error("This payment attempt was rejected. Start a new payment attempt.");
    }

    const fresh = await ownedInvoice(publicToken, reservation);
    const active = await reservation.execute({
      sql: "SELECT razorpay_order_id, amount, provider_account_id, status FROM razorpay_orders WHERE owner_user_id = ? AND due_id = ? AND status IN ('creating','created')",
      args: [Number(invoice.owner_user_id), Number(invoice.due_id)],
    });
    const reusable = active.rows.find(row => row.status === "created" && row.razorpay_order_id && Number(row.amount) === amount && amount <= fresh.remaining && (row.provider_account_id || null) === (paymentAccount?.provider_account_id || null));
    if (reusable) {
      await reservation.commit();
      return { keyId: config.keyId, orderId: String(reusable.razorpay_order_id), amount, amountPaise: amount * 100, currency: "INR", duplicate: true };
    }
    const reserved = active.rows.reduce((sum, row) => sum + Number(row.amount), 0);
    if (amount + reserved > fresh.remaining) throw new Error("Another payment attempt is open for this bill. Complete that attempt before starting a different amount.");
    const now = Date.now();
    const inserted = await reservation.execute({
      sql: `INSERT OR IGNORE INTO razorpay_orders
        (owner_user_id, owner_key, customer_id, invoice_id, due_id, request_key, razorpay_order_id,
         payment_account_id, provider_account_id, transfer_status, amount, currency, status, payment_id, error_message, created_at, updated_at, paid_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'INR', 'creating', NULL, '', ?, ?, NULL)`,
      args: [
        Number(invoice.owner_user_id), String(invoice.owner_key), Number(invoice.customer_id),
        Number(invoice.invoice_id), Number(invoice.due_id), requestKey,
        paymentAccount?.id || null, paymentAccount?.provider_account_id || null, useRoute ? "pending" : "not_requested",
        amount, now, now,
      ],
    });
    if (inserted.rowsAffected !== 1) throw new Error("A duplicate payment request was blocked. Refresh and try again.");
    localId = Number(inserted.lastInsertRowid);
    await reservation.commit();

  } finally {
    reservation.close();
  }

  let confirmedRejection = false;
  try {
    const response = await fetcher("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: basicAuthorization(config.keyId, config.keySecret),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: amount * 100,
        currency: "INR",
        partial_payment: false,
        transfers: useRoute ? [{ account: paymentAccount!.provider_account_id, amount: amount * 100, currency: "INR", notes: { yaadrakho_business_id: String(invoice.owner_user_id) }, on_hold: false }] : undefined,
        receipt: `YR-${Number(invoice.invoice_id)}-${localId}`.slice(0, 40),
        notes: {
          yaadrakho_invoice_id: String(invoice.invoice_id),
          yaadrakho_due_id: String(invoice.due_id),
        },
      }),
    });
    const remote = await response.json().catch(() => ({})) as { id?: string; amount?: number; currency?: string; error?: { description?: string } };
    confirmedRejection = !response.ok && [400, 401, 403, 422].includes(response.status) && Boolean(remote.error?.description) && !remote.id;
    if (!response.ok || !remote.id) throw new Error(remote.error?.description || `Razorpay order request failed (${response.status}).`);
    if (Number(remote.amount) !== amount * 100 || String(remote.currency) !== "INR") {
      throw new Error("Razorpay returned an unexpected order amount.");
    }
    await database.execute({
      sql: "UPDATE razorpay_orders SET razorpay_order_id = ?, status = 'created', updated_at = ? WHERE id = ? AND status = 'creating'",
      args: [remote.id, Date.now(), localId],
    });
    return { keyId: config.keyId, orderId: remote.id, amount, amountPaise: amount * 100, currency: "INR", duplicate: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Razorpay order could not be created.";
    await database.execute({
      sql: "UPDATE razorpay_orders SET status = ?, error_message = ?, updated_at = ? WHERE id = ? AND status = 'creating' AND razorpay_order_id IS NULL",
      args: [confirmedRejection ? "failed" : "creating", message.slice(0, 500), Date.now(), localId],
    });
    if (!confirmedRejection) throw new Error("Payment order confirmation is pending. Contact the business before starting another payment.");
    throw error;
  }
}

function paymentMethod(payment: RazorpayPayment) {
  if (payment.method === "upi") return "upi";
  if (payment.method === "wallet" && String(payment.wallet || "").toLowerCase().includes("paytm")) return "paytm";
  if (["netbanking", "card", "emandate"].includes(String(payment.method))) return "bank";
  return "other";
}

export async function finalizeCapturedRazorpayPayment(
  razorpayOrderId: string,
  payment: RazorpayPayment,
  database: Client = getClient(),
) {
  await ensureRazorpayTables();
  const localResult = await database.execute({
    sql: "SELECT * FROM razorpay_orders WHERE razorpay_order_id = ? LIMIT 1",
    args: [razorpayOrderId],
  });
  const local = localResult.rows[0] as unknown as LocalOrder | undefined;
  if (!local) throw new Error("Razorpay order is not linked to a YaadRakho bill.");
  if (!payment.id || payment.order_id !== razorpayOrderId || payment.status !== "captured" || payment.captured !== true) {
    throw new Error("Payment is not captured yet. No ledger entry was created.");
  }
  if (Number(payment.amount) !== Number(local.amount) * 100 || String(payment.currency) !== local.currency) {
    throw new Error("Captured payment amount does not match this bill.");
  }
  const resolved = await database.execute({ sql: "SELECT payment_id FROM payment_reconciliations WHERE payment_id = ?", args: [payment.id] });
  if (resolved.rows.length) return { duplicate: true, paid: false, reconciled: true, message: "This payment was verified fully refunded. No ledger payment was added." };
  if (local.status === "paid") {
    if (local.payment_id !== payment.id) throw new Error("This order is already linked to another payment.");
    return { duplicate: true, paid: true };
  }
  const capturedAt = Date.now();
  await database.execute({
    sql: "INSERT OR IGNORE INTO razorpay_captures (payment_id, razorpay_order_id, owner_user_id, invoice_id, due_id, amount, currency, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    args: [payment.id, razorpayOrderId, Number(local.owner_user_id), Number(local.invoice_id), Number(local.due_id), Number(local.amount), local.currency, capturedAt, capturedAt],
  });
  const capture = await database.execute({ sql: "SELECT razorpay_order_id, status, created_at FROM razorpay_captures WHERE payment_id = ?", args: [payment.id] });
  if (String(capture.rows[0]?.razorpay_order_id) !== razorpayOrderId) throw new Error("This payment belongs to another order.");
  const reviewResult = { duplicate: false, paid: false, reconciliationRequired: true, message: "Payment received, but the bill balance needs review. Contact the business with your payment ID. Do not pay again." };
  if (capture.rows[0]?.status === "needs_review") return reviewResult;
  try {
    await recordLedgerPayment({
      id: Number(local.owner_user_id),
      storageKey: String(local.owner_key),
    }, Number(local.customer_id), {
      amount: Number(local.amount),
      dueId: Number(local.due_id),
      method: paymentMethod(payment),
      reference: payment.id,
      note: "Verified Razorpay online payment",
      receivedAt: Number(capture.rows[0].created_at),
      idempotencyKey: `razorpay:${payment.id}`,
    }, database);
  } catch (error) {
    await database.execute({
      sql: "UPDATE razorpay_captures SET status = ?, error_message = ?, updated_at = ? WHERE payment_id = ? AND status != 'applied'",
      args: [error instanceof PaymentBalanceConflict ? "needs_review" : "pending", error instanceof Error ? error.message.slice(0, 500) : "Ledger update failed", Date.now(), payment.id],
    });
    if (error instanceof PaymentBalanceConflict) return reviewResult;
    throw error;
  }
  await database.execute({ sql: "UPDATE razorpay_captures SET status = 'applied', error_message = '', updated_at = ? WHERE payment_id = ?", args: [Date.now(), payment.id] });
  const now = Date.now();
  await database.execute({
    sql: `UPDATE razorpay_orders SET status = 'paid', payment_id = ?, error_message = '',
      paid_at = ?, updated_at = ? WHERE id = ?`,
    args: [payment.id, now, now, local.id],
  });
  return { duplicate: false, paid: true };
}
export async function finalizeRazorpayTransfer(
  transfer: { id?: string; source?: string; recipient?: string; status?: string; error?: { description?: string } | null },
  failed: boolean,
  database: Client = getClient(),
) {
  await ensureRazorpayTables();
  if (!transfer.id || !transfer.source || !transfer.recipient) throw new Error("Razorpay transfer data is incomplete.");
  const localResult = await database.execute({
    sql: "SELECT id, provider_account_id FROM razorpay_orders WHERE razorpay_order_id = ? AND provider_account_id = ? LIMIT 1",
    args: [transfer.source, transfer.recipient],
  });
  const local = localResult.rows[0];
  if (!local) throw new Error("Razorpay transfer is not linked to a YaadRakho business.");
  const status = failed ? "failed" : (transfer.status === "processed" ? "processed" : "pending");
  const errorMessage = failed ? String(transfer.error?.description || "Razorpay transfer failed.").slice(0, 500) : "";
  await database.execute({
    sql: "UPDATE razorpay_orders SET transfer_id = ?, transfer_status = ?, transfer_error = ?, updated_at = ? WHERE id = ?",
    args: [transfer.id, status, errorMessage, Date.now(), Number(local.id)],
  });
  return { status, ownerTransfer: true };
}

export async function verifyAndFinalizeCheckout(
  orderId: string,
  paymentId: string,
  signature: string,
  database: Client = getClient(),
  fetcher: Fetcher = fetch,
) {
  const config = configuredRazorpay();
  if (!verifyCheckoutSignature(orderId, paymentId, signature, config.keySecret)) {
    throw new Error("Payment signature verification failed.");
  }
  const response = await fetcher(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: basicAuthorization(config.keyId, config.keySecret) },
  });
  const payment = await response.json().catch(() => ({})) as RazorpayPayment & { error?: { description?: string } };
  if (!response.ok) throw new Error(payment.error?.description || `Razorpay payment verification failed (${response.status}).`);
  return finalizeCapturedRazorpayPayment(orderId, payment, database);
}

export async function rememberWebhookEvent(eventId: string, eventType: string, database: Client = getClient()) {
  await ensureRazorpayTables();
  const existing = await database.execute({
    sql: "SELECT status FROM razorpay_webhook_events WHERE event_id = ? LIMIT 1",
    args: [eventId],
  });
  if (existing.rows[0] && ["processed", "ignored"].includes(String(existing.rows[0].status))) return false;
  const now = Date.now();
  await database.execute({
    sql: `INSERT INTO razorpay_webhook_events
      (event_id, event_type, status, error_message, created_at, processed_at)
      VALUES (?, ?, 'received', '', ?, NULL)
      ON CONFLICT(event_id) DO UPDATE SET event_type = excluded.event_type, status = 'received', error_message = '', processed_at = NULL`,
    args: [eventId, eventType, now],
  });
  return true;
}

export async function finishWebhookEvent(eventId: string, status: "processed" | "ignored" | "failed", error: string, database: Client = getClient()) {
  await database.execute({
    sql: "UPDATE razorpay_webhook_events SET status = ?, error_message = ?, processed_at = ? WHERE event_id = ?",
    args: [status, error.slice(0, 500), Date.now(), eventId],
  });
}

export function razorpayWebhookSecret() {
  const secret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
  if (!secret) throw new Error("Razorpay webhook secret is not configured.");
  return secret;
}

export async function recheckCapturedPayment(
  actor: { id: number; isOwner: boolean },
  paymentId: string,
  database: Client = getClient(),
  fetcher: Fetcher = fetch,
) {
  if (!actor.isOwner) throw new Error("Owner access required");
  await ensureRazorpayTables();
  const owner = await database.execute({ sql: "SELECT id FROM users WHERE id = ? AND is_owner = 1", args: [actor.id] });
  if (!owner.rows.length) throw new Error("Owner access required");
  if (!/^pay_[A-Za-z0-9_]{1,100}$/.test(paymentId)) throw new Error("Invalid payment ID");
  const result = await database.execute({
    sql: `SELECT c.status, c.razorpay_order_id, c.amount, c.currency, c.owner_user_id, c.due_id,
      o.status AS order_status, o.payment_id AS order_payment_id
      FROM razorpay_captures c JOIN razorpay_orders o ON o.razorpay_order_id = c.razorpay_order_id
        AND o.owner_user_id = c.owner_user_id AND o.invoice_id = c.invoice_id AND o.due_id = c.due_id
      WHERE c.payment_id = ? LIMIT 1`,
    args: [paymentId],
  });
  const capture = result.rows[0];
  if (!capture) throw new Error("Captured payment was not found");
  if (capture.status === "needs_review") throw new Error("This balance conflict needs a reconciliation decision. No payment was changed.");
  if (capture.status === "applied") {
    const ledger = await database.execute({ sql: "SELECT id FROM payment_transactions WHERE owner_user_id = ? AND due_id = ? AND amount = ? AND idempotency_key = ?", args: [Number(capture.owner_user_id), Number(capture.due_id), Number(capture.amount), "razorpay:" + paymentId] });
    if (ledger.rows.length && capture.order_status === "paid" && capture.order_payment_id === paymentId) return { duplicate: true, paid: true };
    throw new Error("Applied payment records do not agree. Manual reconciliation is required.");
  }
  const attempt = await database.execute({ sql: "INSERT INTO payment_review_attempts (payment_id, actor_user_id, created_at) VALUES (?, ?, ?)", args: [paymentId, actor.id, Date.now()] });
  const attemptId = Number(attempt.lastInsertRowid);
  try {
    const config = configuredRazorpay();
    const response = await fetcher("https://api.razorpay.com/v1/payments/" + encodeURIComponent(paymentId), {
      headers: { Authorization: basicAuthorization(config.keyId, config.keySecret) },
    });
    const payment = await response.json().catch(() => ({})) as RazorpayPayment & { amount_refunded?: number; refunded?: boolean; error?: { description?: string } };
    if (!response.ok) throw new Error(payment.error?.description || "Provider payment check failed (" + response.status + ").");
    if (payment.id !== paymentId || payment.order_id !== capture.razorpay_order_id || Number(payment.amount) !== Number(capture.amount) * 100 || payment.currency !== capture.currency) throw new Error("Provider payment details do not match the stored capture.");
    if (payment.refunded || Number(payment.amount_refunded || 0) > 0) throw new Error("This payment has a refund. Manual reconciliation is required.");
    const applied = await finalizeCapturedRazorpayPayment(String(capture.razorpay_order_id), payment, database);
    if (applied.paid) {
      const ledger = await database.execute({ sql: "SELECT id FROM payment_transactions WHERE owner_user_id = ? AND due_id = ? AND amount = ? AND idempotency_key = ?", args: [Number(capture.owner_user_id), Number(capture.due_id), Number(capture.amount), "razorpay:" + paymentId] });
      if (!ledger.rows.length) throw new Error("Provider payment is marked paid but its ledger entry is missing. Manual reconciliation is required.");
      await database.execute({ sql: "UPDATE razorpay_captures SET status = 'applied', error_message = '', updated_at = ? WHERE payment_id = ? AND status = 'pending'", args: [Date.now(), paymentId] });
    }
    await database.execute({ sql: "UPDATE payment_review_attempts SET status = ?, finished_at = ? WHERE id = ?", args: [applied.paid ? "applied" : "review_required", Date.now(), attemptId] });
    return applied;
  } catch (error) {
    await database.execute({ sql: "UPDATE payment_review_attempts SET status = 'failed', error_message = ?, finished_at = ? WHERE id = ?", args: [error instanceof Error ? error.message.slice(0, 500) : "Payment recheck failed", Date.now(), attemptId] });
    throw error;
  }
}

type RecoveryOrder = {
  id?: string; receipt?: string; amount?: number; currency?: string; status?: string;
  notes?: { yaadrakho_invoice_id?: string; yaadrakho_due_id?: string };
  transfers?: { items?: Array<{ recipient?: string; amount?: number; currency?: string }> };
};

async function recoveryProviderGet(path: string, fetcher: Fetcher) {
  const config = configuredRazorpay();
  const response = await fetcher("https://api.razorpay.com/v1/" + path, {
    headers: { Authorization: basicAuthorization(config.keyId, config.keySecret) },
  });
  if (!response.ok) throw new Error("Provider recovery check failed (" + response.status + "). No reservation was released.");
  return response.json();
}

async function recoverLocalOrder(localId: number, actorId: number | null, source: string, remoteId: string | undefined, database: Client, fetcher: Fetcher) {
  const result = await database.execute({ sql: "SELECT * FROM razorpay_orders WHERE id = ?", args: [localId] });
  const local = result.rows[0] as unknown as LocalOrder | undefined;
  if (!local) throw new Error("Payment attempt was not found");
  const attempt = await database.execute({ sql: "INSERT INTO order_recovery_attempts (local_order_id, actor_user_id, source, created_at) VALUES (?, ?, ?, ?)", args: [localId, actorId, source, Date.now()] });
  const attemptId = Number(attempt.lastInsertRowid);
  try {
    const closed = await database.execute({ sql: "SELECT r.payment_id FROM payment_reconciliations r JOIN razorpay_captures c ON c.payment_id = r.payment_id WHERE c.razorpay_order_id = ?", args: [local.razorpay_order_id] });
    if (closed.rows.length) throw new Error("This order was reconciled as fully refunded and cannot be reopened.");
    const receipt = `YR-${local.invoice_id}-${local.id}`.slice(0, 40);
    let orderId: string | null | undefined = remoteId || local.razorpay_order_id;
    if (!orderId) {
      const collection = await recoveryProviderGet("orders?receipt=" + encodeURIComponent(receipt) + "&count=100", fetcher) as { items?: RecoveryOrder[] };
      if (!Array.isArray(collection.items)) throw new Error("Provider returned an invalid order collection");
      const matches = collection.items.filter(order => order.receipt === receipt);
      if (matches.length !== 1) throw new Error("A unique matching provider order was not found. Reservation retained for manual investigation.");
      orderId = matches[0].id;
    }
    if (!orderId || !/^order_[A-Za-z0-9_]{1,100}$/.test(orderId)) throw new Error("Invalid provider order ID");
    const remote = await recoveryProviderGet("orders/" + encodeURIComponent(orderId) + "?expand[]=transfers", fetcher) as RecoveryOrder;
    if (remote.id !== orderId || remote.receipt !== receipt || Number(remote.amount) !== Number(local.amount) * 100 || remote.currency !== local.currency || String(remote.notes?.yaadrakho_invoice_id) !== String(local.invoice_id) || String(remote.notes?.yaadrakho_due_id) !== String(local.due_id) || !["created", "attempted", "paid"].includes(String(remote.status))) {
      throw new Error("Provider order does not match the original bill, amount and receipt. No link was changed.");
    }
    if (local.provider_account_id) {
      const transfers = remote.transfers?.items;
      if (!Array.isArray(transfers) || transfers.length !== 1 || transfers[0].recipient !== local.provider_account_id || Number(transfers[0].amount) !== Number(local.amount) * 100 || transfers[0].currency !== local.currency) throw new Error("Provider merchant routing could not be verified. No link was changed.");
    }
    if (!local.provider_account_id && (remote.transfers?.items?.length || 0) > 0) throw new Error("Unexpected merchant routing on recovered order");
    const transaction = await database.transaction("write");
    try {
      const closedNow = await transaction.execute({ sql: "SELECT r.payment_id FROM payment_reconciliations r JOIN razorpay_captures c ON c.payment_id = r.payment_id WHERE c.razorpay_order_id = ?", args: [orderId] });
      if (closedNow.rows.length) throw new Error("This order was reconciled while recovery was running; it cannot be reopened.");
      const currentResult = await transaction.execute({ sql: "SELECT razorpay_order_id, status FROM razorpay_orders WHERE id = ?", args: [localId] });
      const current = currentResult.rows[0];
      if (!current || (current.razorpay_order_id && current.razorpay_order_id !== orderId)) throw new Error("Payment attempt linkage changed; review required");
      const other = await transaction.execute({ sql: "SELECT id FROM razorpay_orders WHERE razorpay_order_id = ? AND id != ?", args: [orderId, localId] });
      if (other.rows.length) throw new Error("Provider order is already linked to another attempt");
      await transaction.execute({ sql: "UPDATE razorpay_orders SET razorpay_order_id = ?, status = CASE WHEN status = 'paid' THEN status ELSE 'created' END, error_message = '', updated_at = ? WHERE id = ?", args: [orderId, Date.now(), localId] });
      await transaction.commit();
    } finally { transaction.close(); }
    const payments = await recoveryProviderGet("orders/" + encodeURIComponent(orderId) + "/payments", fetcher) as { items?: Array<RazorpayPayment & { amount_refunded?: number; refunded?: boolean }> };
    if (!Array.isArray(payments.items)) throw new Error("Provider returned an invalid payment collection");
    let paid = false, reviewRequired = false;
    for (const payment of payments.items) {
      if (payment.status !== "captured" && payment.status !== "refunded") continue;
      if (!payment.id || payment.order_id !== orderId || Number(payment.amount) !== Number(local.amount) * 100 || payment.currency !== local.currency) throw new Error("Recovered payment does not match the order");
      if (payment.refunded || payment.status === "refunded" || Number(payment.amount_refunded || 0) > 0) {
        await database.execute({ sql: "INSERT OR IGNORE INTO razorpay_captures (payment_id, razorpay_order_id, owner_user_id, invoice_id, due_id, amount, currency, status, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'needs_review', 'Provider reports a refund; reconcile before collecting again.', ?, ?)", args: [payment.id, orderId, local.owner_user_id, local.invoice_id, local.due_id, local.amount, local.currency, Date.now(), Date.now()] });
        reviewRequired = true;
        continue;
      }
      const applied = await finalizeCapturedRazorpayPayment(orderId, payment, database);
      paid ||= applied.paid;
      reviewRequired ||= !applied.paid;
    }
    if (remote.status === "paid" && !paid && !reviewRequired) throw new Error("Paid provider order has no verified captured payment. Review required.");
    const message = reviewRequired ? "Order recovered; payment requires reconciliation. Do not collect again." : paid ? "Order recovered and captured payment recorded." : "Order recovered. The existing checkout can be reopened for the same amount.";
    await database.execute({ sql: "UPDATE order_recovery_attempts SET status = ?, provider_order_id = ?, message = ?, finished_at = ? WHERE id = ?", args: [reviewRequired ? "review_required" : "recovered", orderId, message, Date.now(), attemptId] });
    return { orderId, paid, reconciliationRequired: reviewRequired, message };
  } catch (error) {
    await database.execute({ sql: "UPDATE order_recovery_attempts SET status = 'failed', message = ?, finished_at = ? WHERE id = ?", args: [error instanceof Error ? error.message.slice(0, 500) : "Recovery failed", Date.now(), attemptId] });
    throw error;
  }
}

export async function recoverPaymentOrder(actor: { id: number; isOwner: boolean }, localId: number, database: Client = getClient(), fetcher: Fetcher = fetch) {
  if (!actor.isOwner) throw new Error("Owner access required");
  await ensureRazorpayTables();
  const owner = await database.execute({ sql: "SELECT id FROM users WHERE id = ? AND is_owner = 1", args: [actor.id] });
  if (!owner.rows.length) throw new Error("Owner access required");
  if (!Number.isSafeInteger(localId) || localId <= 0) throw new Error("Invalid payment attempt ID");
  return recoverLocalOrder(localId, actor.id, "owner", undefined, database, fetcher);
}

// Called only after webhook signature verification. Provider reads establish the lost link.
export async function recoverWebhookOrder(orderId: string, database: Client = getClient(), fetcher: Fetcher = fetch) {
  await ensureRazorpayTables();
  const known = await database.execute({ sql: "SELECT id FROM razorpay_orders WHERE razorpay_order_id = ?", args: [orderId] });
  if (known.rows.length) return;
  if (!/^order_[A-Za-z0-9_]{1,100}$/.test(orderId)) throw new Error("Invalid provider order ID");
  const remote = await recoveryProviderGet("orders/" + encodeURIComponent(orderId), fetcher) as RecoveryOrder;
  const match = /^YR-(\d+)-(\d+)$/.exec(String(remote.receipt || ""));
  if (!match) throw new Error("Unknown provider order requires manual investigation");
  const local = await database.execute({ sql: "SELECT id FROM razorpay_orders WHERE id = ? AND invoice_id = ?", args: [Number(match[2]), Number(match[1])] });
  if (!local.rows.length) throw new Error("Unknown provider order requires manual investigation");
  return recoverLocalOrder(Number(match[2]), null, "webhook", orderId, database, fetcher);
}

// Record only an already processed full refund of money never applied to the ledger.
// This action performs provider GETs; it never issues a refund or edits a receipt.
export async function reconcileRefundedCapture(actor: { id: number; isOwner: boolean }, paymentId: string, refundId: string, note: string, database: Client = getClient(), fetcher: Fetcher = fetch) {
  if (!actor.isOwner) throw new Error("Owner access required");
  await ensureRazorpayTables();
  const owner = await database.execute({ sql: "SELECT id FROM users WHERE id = ? AND is_owner = 1", args: [actor.id] });
  if (!owner.rows.length) throw new Error("Owner access required");
  if (!/^pay_[A-Za-z0-9_]{1,100}$/.test(paymentId) || !/^rfnd_[A-Za-z0-9_]{1,100}$/.test(refundId)) throw new Error("Valid payment and refund IDs are required");
  if (note.trim().length < 10 || note.length > 1000) throw new Error("Record a reconciliation note between 10 and 1000 characters");
  const existing = await database.execute({ sql: "SELECT refund_id FROM payment_reconciliations WHERE payment_id = ?", args: [paymentId] });
  if (existing.rows.length) {
    if (existing.rows[0].refund_id !== refundId) throw new Error("This payment already has a different reconciliation");
    return { reconciled: true, message: "Full refund already verified and recorded." };
  }
  const found = await database.execute({ sql: "SELECT c.*, o.id AS local_id FROM razorpay_captures c JOIN razorpay_orders o ON o.razorpay_order_id = c.razorpay_order_id AND o.owner_user_id = c.owner_user_id AND o.invoice_id = c.invoice_id AND o.due_id = c.due_id WHERE c.payment_id = ?", args: [paymentId] });
  const capture = found.rows[0];
  if (!capture || capture.status !== "needs_review") throw new Error("Only unapplied payments needing review can use refund reconciliation");
  const audit = await database.execute({ sql: "INSERT INTO order_recovery_attempts (local_order_id, actor_user_id, source, created_at) VALUES (?, ?, 'refund_verification', ?)", args: [Number(capture.local_id), actor.id, Date.now()] });
  try {
    const payment = await recoveryProviderGet("payments/" + encodeURIComponent(paymentId), fetcher) as RazorpayPayment & { amount_refunded?: number; refund_status?: string };
    const refund = await recoveryProviderGet("refunds/" + encodeURIComponent(refundId), fetcher) as { id?: string; payment_id?: string; amount?: number; currency?: string; status?: string };
    const paise = Number(capture.amount) * 100;
    if (payment.id !== paymentId || payment.order_id !== capture.razorpay_order_id || Number(payment.amount) !== paise || payment.currency !== capture.currency || payment.status !== "refunded" || Number(payment.amount_refunded) !== paise || payment.refund_status !== "full") throw new Error("Provider does not confirm this payment as fully refunded");
    if (refund.id !== refundId || refund.payment_id !== paymentId || Number(refund.amount) !== paise || refund.currency !== capture.currency || refund.status !== "processed") throw new Error("Refund is not a matching processed full refund");
    const transaction = await database.transaction("write");
    try {
      const current = await transaction.execute({ sql: "SELECT status FROM razorpay_captures WHERE payment_id = ?", args: [paymentId] });
      const ledger = await transaction.execute({ sql: "SELECT id FROM payment_transactions WHERE idempotency_key = ? OR (owner_user_id = ? AND reference = ?)", args: ["razorpay:" + paymentId, Number(capture.owner_user_id), paymentId] });
      if (current.rows[0]?.status !== "needs_review" || ledger.rows.length) throw new Error("Payment is already in the ledger or changed during review; no resolution recorded");
      await transaction.execute({ sql: "INSERT OR IGNORE INTO payment_reconciliations (payment_id, refund_id, actor_user_id, note, created_at) VALUES (?, ?, ?, ?, ?)", args: [paymentId, refundId, actor.id, note.trim(), Date.now()] });
      const saved = await transaction.execute({ sql: "SELECT refund_id FROM payment_reconciliations WHERE payment_id = ?", args: [paymentId] });
      if (saved.rows[0]?.refund_id !== refundId) throw new Error("Refund evidence conflicts with an existing reconciliation");
      await transaction.execute({ sql: "UPDATE razorpay_orders SET status = 'failed', error_message = 'Fully refunded; reconciliation recorded', updated_at = ? WHERE id = ? AND status != 'paid'", args: [Date.now(), Number(capture.local_id)] });
      await transaction.commit();
    } finally { transaction.close(); }
    await database.execute({ sql: "UPDATE order_recovery_attempts SET status = 'reconciled', message = ?, finished_at = ? WHERE id = ?", args: ["Verified full refund " + refundId, Date.now(), Number(audit.lastInsertRowid)] });
    return { reconciled: true, message: "Full refund verified and recorded. Existing bill balances and receipts were preserved." };
  } catch (error) {
    await database.execute({ sql: "UPDATE order_recovery_attempts SET status = 'failed', message = ?, finished_at = ? WHERE id = ?", args: [error instanceof Error ? error.message.slice(0, 500) : "Refund verification failed", Date.now(), Number(audit.lastInsertRowid)] });
    throw error;
  }
}
