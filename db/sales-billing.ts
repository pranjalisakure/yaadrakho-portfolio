import type { Client } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { ensureBillingTables, getClient } from ".";

export type BillingUser = { id: number; storageKey: string; displayName?: string };

type ProductInput = { name: unknown; price: unknown; gstRate?: unknown; unit?: unknown };
type InvoiceLineInput = { productId: unknown; quantity: unknown; discount?: unknown };
type InvoiceInput = {
  customerId: unknown;
  idempotencyKey?: unknown;
  issueDate?: unknown;
  dueDate: unknown;
  billingMode?: unknown;
  remainingPayment?: unknown;
  initialPaymentAmount?: unknown;
  notes?: unknown;
  lines: InvoiceLineInput[];
};

const gstRates = new Set([0, 5, 12, 18, 28]);

function positiveInteger(value: unknown, label: string, allowZero = false) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be ${allowZero ? "zero or a positive" : "a positive"} whole number`);
  }
  return number;
}

function productNameKey(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function cleanProduct(input: ProductInput) {
  const name = String(input.name || "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 120) throw new Error("Product name must be between 2 and 120 characters");
  const price = positiveInteger(input.price, `${name} price`, true);
  const gstRate = Number(input.gstRate || 0);
  if (!gstRates.has(gstRate)) throw new Error(`${name} GST must be 0, 5, 12, 18, or 28 percent`);
  const unit = String(input.unit || "item").trim().slice(0, 24) || "item";
  return { name, nameKey: productNameKey(name), price, gstRate, unit };
}

function validDate(value: unknown, label: string) {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${label} is required`);
  return date;
}

async function syncInvoiceStatuses(database: Client, userId: number) {
  await database.execute({
    sql: `UPDATE invoices SET
      amount_paid = COALESCE((SELECT amount_paid FROM payment_dues WHERE payment_dues.id = invoices.due_id), amount_paid),
      status = CASE
        WHEN status = 'cancelled' THEN 'cancelled'
        WHEN COALESCE((SELECT status FROM payment_dues WHERE payment_dues.id = invoices.due_id), status) = 'paid' THEN 'paid'
        WHEN COALESCE((SELECT amount_paid FROM payment_dues WHERE payment_dues.id = invoices.due_id), amount_paid) > 0 THEN 'partial'
        ELSE 'issued' END
      WHERE owner_user_id = ?`,
    args: [userId],
  });
}

export async function saveCatalogProducts(user: BillingUser, inputs: ProductInput[], database: Client = getClient()) {
  await ensureBillingTables();
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("Add at least one product");
  if (inputs.length > 500) throw new Error("Import up to 500 products at a time");
  const uniqueProducts = new Map<string, ReturnType<typeof cleanProduct>>();
  for (const input of inputs) {
    const product = cleanProduct(input);
    uniqueProducts.set(product.nameKey, product);
  }
  const now = Date.now();
  const transaction = await database.transaction("write");
  try {
    for (const product of uniqueProducts.values()) {
      await transaction.execute({
        sql: `INSERT INTO product_catalog
          (owner_user_id, owner_key, name, name_key, price, gst_rate, unit, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner_user_id, name_key) DO UPDATE SET
            name = excluded.name, price = excluded.price, gst_rate = excluded.gst_rate,
            unit = excluded.unit, updated_at = excluded.updated_at`,
        args: [user.id, user.storageKey, product.name, product.nameKey, product.price, product.gstRate, product.unit, now, now],
      });
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
  return { saved: uniqueProducts.size };
}

export async function getBillingOverview(user: BillingUser, database: Client = getClient(), options: { page?: number; pendingOnly?: boolean } = {}) {
  const page = options.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000) throw new Error("Invalid bill history page");
  const pageSize = 50;
  const pendingFilter = options.pendingOnly ? " AND i.status IN ('issued','partial') AND i.amount_paid < i.total_amount" : "";
  await ensureBillingTables();
  await syncInvoiceStatuses(database, user.id);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [products, invoices, summary] = await Promise.all([
    database.execute({
      sql: `SELECT id, name, price, gst_rate AS gstRate, unit, created_at AS createdAt, updated_at AS updatedAt
        FROM product_catalog WHERE owner_user_id = ? AND owner_key = ? ORDER BY name COLLATE NOCASE, id`,
      args: [user.id, user.storageKey],
    }),
    database.execute({
      sql: `SELECT i.id, i.customer_id AS customerId, c.name AS customerName, c.phone AS customerPhone,
        i.due_id AS dueId, i.invoice_number AS invoiceNumber, i.billing_mode AS billingMode, i.remaining_payment AS remainingPayment,
        i.issue_date AS issueDate, i.due_date AS dueDate, i.subtotal, i.discount_amount AS discountAmount,
        i.tax_amount AS taxAmount, i.public_token AS publicToken,
        i.total_amount AS totalAmount, i.amount_paid AS amountPaid, i.status, i.notes,
        i.created_at AS createdAt, i.updated_at AS updatedAt,
        (SELECT pt.id FROM payment_transactions pt WHERE pt.due_id = i.due_id AND pt.owner_user_id = i.owner_user_id
          ORDER BY pt.id DESC LIMIT 1) AS latestReceiptId,
        (SELECT COUNT(*) FROM invoice_items item WHERE item.invoice_id = i.id) AS itemCount,
        (SELECT GROUP_CONCAT(item.description, ', ') FROM invoice_items item WHERE item.invoice_id = i.id) AS productSummary,
        COALESCE((SELECT status FROM invoice_deliveries delivery WHERE delivery.invoice_id = i.id AND delivery.channel = 'whatsapp' LIMIT 1), 'prepared') AS deliveryStatus,
        (SELECT automatic_attempted_at FROM invoice_deliveries d WHERE d.invoice_id = i.id AND d.owner_user_id = i.owner_user_id) AS deliveryAttemptedAt,
        (SELECT review_note FROM invoice_deliveries d WHERE d.invoice_id = i.id AND d.owner_user_id = i.owner_user_id) AS deliveryReviewNote,
        (SELECT reviewed_at FROM invoice_deliveries d WHERE d.invoice_id = i.id AND d.owner_user_id = i.owner_user_id) AS deliveryReviewedAt
        FROM invoices i JOIN customers c ON c.id = i.customer_id AND c.owner_user_id = i.owner_user_id
        WHERE i.owner_user_id = ? AND i.owner_key = ? ${pendingFilter} ORDER BY i.issue_date DESC, i.id DESC LIMIT ? OFFSET ?`,
      args: [user.id, user.storageKey, pageSize + 1, (page - 1) * pageSize],
    }),
    database.execute({
      sql: `SELECT
        COUNT(*) AS totalBills,
        SUM(CASE WHEN i.status IN ('issued','partial') AND i.amount_paid < i.total_amount THEN 1 ELSE 0 END) AS pendingBills,
        SUM(CASE WHEN i.status IN ('issued','partial') AND i.amount_paid < i.total_amount AND i.due_date = ? THEN 1 ELSE 0 END) AS dueToday,
        SUM(CASE WHEN i.status IN ('issued','partial') AND i.amount_paid < i.total_amount AND i.due_date < ? THEN 1 ELSE 0 END) AS overdueBills,
        COALESCE(SUM(i.amount_paid), 0) AS collectedAmount,
        SUM(CASE WHEN i.status IN ('issued','partial') AND i.amount_paid < i.total_amount AND i.due_date > ? THEN 1 ELSE 0 END) AS upcomingReminders
        FROM invoices i WHERE i.owner_user_id = ? AND i.owner_key = ? AND i.status != 'cancelled'`,
      args: [today, today, today, user.id, user.storageKey],
    }),
  ]);
  const row = summary.rows[0];
  return { products: products.rows, invoices: invoices.rows.slice(0, pageSize), pagination: { page, pageSize, hasMore: invoices.rows.length > pageSize }, stats: {
    totalBills: Number(row?.totalBills || 0), pendingBills: Number(row?.pendingBills || 0), dueToday: Number(row?.dueToday || 0),
    overdueBills: Number(row?.overdueBills || 0), collectedAmount: Number(row?.collectedAmount || 0),
    upcomingReminders: Number(row?.upcomingReminders || 0),
  } };
}

export async function createInvoice(user: BillingUser, input: InvoiceInput, database: Client = getClient()) {
  await ensureBillingTables();
  const customerId = positiveInteger(input.customerId, "Customer");
  const dueDate = validDate(input.dueDate, "Due date");
  const issueDate = validDate(input.issueDate || new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()), "Bill date");
  if (dueDate < issueDate) throw new Error("Due date cannot be before the bill date");
  const billingMode = input.billingMode === "monthly_statement" ? "monthly_statement" : "separate";
  const remainingPayment = input.remainingPayment ?? "online";
  if (remainingPayment !== "online" && remainingPayment !== "cash") throw new Error("Choose Online or Cash for the remaining payment");
  const notes = String(input.notes || "").trim().slice(0, 500);
  const idempotencyKey = String(input.idempotencyKey || "").trim() || null;
  if (idempotencyKey && !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new Error("Bill request key is invalid");
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new Error("Add at least one product to the bill");
  if (input.lines.length > 50) throw new Error("A bill can contain up to 50 product lines");

  const transaction = await database.transaction("write");
  try {
    if (idempotencyKey) {
      const existingResult = await transaction.execute({
        sql: `SELECT id, customer_id AS customerId, invoice_number AS invoiceNumber, due_id AS dueId, total_amount AS totalAmount, public_token AS publicToken
          FROM invoices WHERE owner_user_id = ? AND owner_key = ? AND idempotency_key = ? LIMIT 1`,
        args: [user.id, user.storageKey, idempotencyKey],
      });
      const existing = existingResult.rows[0];
      if (existing) {
        if (Number(existing.customerId) !== customerId) throw new Error("This bill request belongs to another customer");
        await transaction.commit();
        return { id: Number(existing.id), customerId, invoiceNumber: String(existing.invoiceNumber), dueId: Number(existing.dueId), totalAmount: Number(existing.totalAmount), publicToken: String(existing.publicToken), duplicate: true };
      }
    }
    const customerResult = await transaction.execute({
      sql: "SELECT id, current_due_id FROM customers WHERE id = ? AND owner_user_id = ? AND owner_email = ? LIMIT 1",
      args: [customerId, user.id, user.storageKey],
    });
    const customer = customerResult.rows[0];
    if (!customer) throw new Error("Customer not found");

    const lines: Array<{ productId: number; description: string; quantityMilli: number; unit: string; unitPrice: number; gstRate: number; lineSubtotal: number; lineDiscount: number; lineTax: number; lineTotal: number }> = [];
    for (const inputLine of input.lines) {
      const productId = positiveInteger(inputLine.productId, "Product");
      const quantity = Number(inputLine.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) throw new Error("Product quantity must be greater than zero");
      const quantityMilli = Math.round(quantity * 1000);
      const productResult = await transaction.execute({
        sql: "SELECT id, name, price, gst_rate, unit FROM product_catalog WHERE id = ? AND owner_user_id = ? AND owner_key = ? LIMIT 1",
        args: [productId, user.id, user.storageKey],
      });
      const product = productResult.rows[0];
      if (!product) throw new Error("A selected product is no longer available");
      const unitPrice = Number(product.price);
      const gstRate = Number(product.gst_rate);
      const lineSubtotal = Math.round((unitPrice * quantityMilli) / 1000);
      const lineDiscount = positiveInteger(inputLine.discount || 0, `${String(product.name)} discount`, true);
      if (lineDiscount > lineSubtotal) throw new Error(`${String(product.name)} discount cannot be more than its base amount`);
      const discountedAmount = lineSubtotal - lineDiscount;
      const lineTax = Math.round((discountedAmount * gstRate) / 100);
      lines.push({
        productId, description: String(product.name), quantityMilli, unit: String(product.unit), unitPrice, gstRate,
        lineSubtotal, lineDiscount, lineTax, lineTotal: discountedAmount + lineTax,
      });
    }
    const subtotal = lines.reduce((sum, line) => sum + line.lineSubtotal, 0);
    const discountAmount = lines.reduce((sum, line) => sum + line.lineDiscount, 0);
    const taxAmount = lines.reduce((sum, line) => sum + line.lineTax, 0);
    const totalAmount = subtotal - discountAmount + taxAmount;
    if (totalAmount <= 0) throw new Error("Bill total must be greater than zero");
    if (input.initialPaymentAmount !== undefined && (!Number.isSafeInteger(Number(input.initialPaymentAmount)) || Number(input.initialPaymentAmount) <= 0 || Number(input.initialPaymentAmount) >= totalAmount)) throw new Error("Part payment must be greater than zero and less than the bill total");

    await transaction.execute({
      sql: "INSERT OR IGNORE INTO invoice_sequences (owner_user_id, next_value) VALUES (?, 1)",
      args: [user.id],
    });
    const sequenceResult = await transaction.execute({
      sql: "SELECT next_value FROM invoice_sequences WHERE owner_user_id = ? LIMIT 1",
      args: [user.id],
    });
    const sequence = Number(sequenceResult.rows[0]?.next_value || 1);
    await transaction.execute({ sql: "UPDATE invoice_sequences SET next_value = ? WHERE owner_user_id = ?", args: [sequence + 1, user.id] });
    const invoiceNumber = `YR-${issueDate.slice(0, 4)}-${String(sequence).padStart(6, "0")}`;
    const publicToken = randomUUID().replaceAll("-", "");
    const now = Date.now();
    const insertedInvoice = await transaction.execute({
      sql: `INSERT INTO invoices
        (owner_user_id, owner_key, customer_id, due_id, invoice_number, idempotency_key, billing_mode, issue_date, due_date,
          subtotal, discount_amount, tax_amount, total_amount, amount_paid, status, notes, public_token, created_at, updated_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'issued', ?, ?, ?, ?)`,
      args: [user.id, user.storageKey, customerId, invoiceNumber, idempotencyKey, billingMode, issueDate, dueDate, subtotal, discountAmount, taxAmount, totalAmount, notes, publicToken, now, now],
    });
    const invoiceId = Number(insertedInvoice.lastInsertRowid || 0);
    await transaction.execute({ sql: "UPDATE invoices SET remaining_payment = ? WHERE id = ?", args: [remainingPayment, invoiceId] });
    if (!invoiceId) throw new Error("Bill could not be created");

    let dueId = 0;
    if (customer.current_due_id) {
      const reusableDue = await transaction.execute({
        sql: `SELECT pd.id FROM payment_dues pd
          WHERE pd.id = ? AND pd.owner_user_id = ? AND pd.customer_id = ? AND pd.amount_paid = 0 AND pd.status != 'paid'
          AND NOT EXISTS (SELECT 1 FROM invoices existing WHERE existing.due_id = pd.id) LIMIT 1`,
        args: [Number(customer.current_due_id), user.id, customerId],
      });
      dueId = Number(reusableDue.rows[0]?.id || 0);
    }
    if (dueId) {
      await transaction.execute({
        sql: "UPDATE payment_dues SET due_date = ?, amount_due = ?, amount_paid = 0, status = 'pending', paid_at = NULL, updated_at = ? WHERE id = ? AND owner_user_id = ?",
        args: [dueDate, totalAmount, now, dueId, user.id],
      });
    } else {
      const insertedDue = await transaction.execute({
        sql: `INSERT INTO payment_dues
          (owner_user_id, owner_key, customer_id, period_key, due_date, amount_due, amount_paid, status, paid_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', NULL, ?, ?)`,
        args: [user.id, user.storageKey, customerId, `invoice:${invoiceNumber}`, dueDate, totalAmount, now, now],
      });
      dueId = Number(insertedDue.lastInsertRowid || 0);
    }
    if (!dueId) throw new Error("Bill payment reminder could not be created");
    await transaction.execute({ sql: "UPDATE invoices SET due_id = ? WHERE id = ? AND owner_user_id = ?", args: [dueId, invoiceId, user.id] });
    for (const line of lines) {
      await transaction.execute({
        sql: `INSERT INTO invoice_items
          (invoice_id, product_id, description, quantity_milli, unit, unit_price, gst_rate, line_subtotal, line_discount, line_tax, line_total, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [invoiceId, line.productId, line.description, line.quantityMilli, line.unit, line.unitPrice, line.gstRate, line.lineSubtotal, line.lineDiscount, line.lineTax, line.lineTotal, now],
      });
    }
    await transaction.execute({
      sql: `UPDATE customers SET current_due_id = ?, amount = ?, follow_up_date = ?, requirement = ?, payment_status = 'pending',
        status = CASE WHEN status = 'lost' THEN status ELSE 'follow_up' END, updated_at = ?
        WHERE id = ? AND owner_user_id = ? AND owner_email = ?`,
      args: [dueId, totalAmount, dueDate, lines.map((line) => line.description).join(", ").slice(0, 500), now, customerId, user.id, user.storageKey],
    });
    await transaction.commit();
    return { id: invoiceId, customerId, invoiceNumber, dueId, totalAmount, publicToken };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export async function getInvoice(user: BillingUser, invoiceId: number, database: Client = getClient()) {
  await ensureBillingTables();
  await syncInvoiceStatuses(database, user.id);
  const invoiceResult = await database.execute({
    sql: `SELECT i.id, i.customer_id AS customerId, c.name AS customerName, c.phone AS customerPhone,
      c.contact_consent AS contactConsent,
      i.due_id AS dueId, i.invoice_number AS invoiceNumber, i.billing_mode AS billingMode, i.remaining_payment AS remainingPayment,
      i.issue_date AS issueDate, i.due_date AS dueDate, i.subtotal, i.discount_amount AS discountAmount,
      i.tax_amount AS taxAmount, i.public_token AS publicToken,
      i.total_amount AS totalAmount, i.amount_paid AS amountPaid, i.status, i.notes,
      COALESCE(NULLIF(TRIM(s.business_name),''), NULLIF(TRIM(u.display_name),''), 'Business') AS businessName,
      COALESCE(s.phone, '') AS businessPhone
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id AND c.owner_user_id = i.owner_user_id
      JOIN users u ON u.id = i.owner_user_id
      LEFT JOIN app_settings s ON s.user_email = i.owner_key
      WHERE i.id = ? AND i.owner_user_id = ? AND i.owner_key = ? LIMIT 1`,
    args: [invoiceId, user.id, user.storageKey],
  });
  if (!invoiceResult.rows[0]) return null;
  const items = await database.execute({
    sql: `SELECT id, product_id AS productId, description, quantity_milli AS quantityMilli, unit,
      unit_price AS unitPrice, gst_rate AS gstRate, line_subtotal AS lineSubtotal,
      line_discount AS lineDiscount, line_tax AS lineTax, line_total AS lineTotal FROM invoice_items WHERE invoice_id = ? ORDER BY id`,
    args: [invoiceId],
  });
  const transactions = await database.execute({
    sql: `SELECT pt.id, pt.amount, pt.method, pt.reference, pt.received_at AS receivedAt
      FROM payment_transactions pt JOIN invoices i ON i.due_id = pt.due_id
      WHERE i.id = ? AND i.owner_user_id = ? AND pt.owner_user_id = ? ORDER BY pt.received_at, pt.id`,
    args: [invoiceId, user.id, user.id],
  });
  return { invoice: invoiceResult.rows[0], items: items.rows, transactions: transactions.rows };
}

export async function getPublicInvoice(publicToken: string, database: Client = getClient()) {
  await ensureBillingTables();
  if (!/^[a-f0-9]{32}$/i.test(publicToken)) return null;
  const invoiceResult = await database.execute({
    sql: `SELECT i.id, i.owner_user_id AS ownerUserId, i.customer_id AS customerId, c.name AS customerName, c.phone AS customerPhone,
      i.invoice_number AS invoiceNumber, i.billing_mode AS billingMode, i.remaining_payment AS remainingPayment, i.issue_date AS issueDate,
      i.due_date AS dueDate, i.subtotal, i.discount_amount AS discountAmount, i.tax_amount AS taxAmount,
      i.total_amount AS totalAmount, i.amount_paid AS amountPaid, i.status, i.notes,
      COALESCE(NULLIF(TRIM(s.business_name),''), NULLIF(TRIM(u.display_name),''), 'Business') AS businessName,
      COALESCE(s.phone, '') AS businessPhone
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id AND c.owner_user_id = i.owner_user_id
      JOIN users u ON u.id = i.owner_user_id
      LEFT JOIN app_settings s ON s.user_email = i.owner_key
      WHERE i.public_token = ? AND i.status != 'cancelled' LIMIT 1`,
    args: [publicToken],
  });
  const invoice = invoiceResult.rows[0];
  if (!invoice) return null;
  const items = await database.execute({
    sql: `SELECT id, description, quantity_milli AS quantityMilli, unit, unit_price AS unitPrice,
      gst_rate AS gstRate, line_subtotal AS lineSubtotal, line_discount AS lineDiscount,
      line_tax AS lineTax, line_total AS lineTotal FROM invoice_items WHERE invoice_id = ? ORDER BY id`,
    args: [Number(invoice.id)],
  });
  const transactions = await database.execute({
    sql: `SELECT id, amount, method, reference, receipt_number AS receiptNumber,
      receipt_token AS receiptToken, balance_after AS balanceAfter, received_at AS receivedAt
      FROM payment_transactions
      WHERE due_id = (SELECT due_id FROM invoices WHERE id = ?) ORDER BY received_at, id`,
    args: [Number(invoice.id)],
  });
  return { invoice, items: items.rows, transactions: transactions.rows };
}

function normalizedWhatsappNumber(value: unknown) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return "";
}

function amountLabel(value: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00`));
}

export async function prepareInvoiceDelivery(user: BillingUser, invoiceId: number, appOrigin: string, database: Client = getClient()) {
  const data = await getInvoice(user, invoiceId, database);
  if (!data) throw new Error("Bill was generated but its message could not be prepared");
  const invoice = data.invoice;
  const destination = normalizedWhatsappNumber(invoice.customerPhone);
  if (!destination) throw new Error("Bill was generated, but the customer phone number is not valid for WhatsApp");
  const productSummary = data.items.map((item) => String(item.description)).join(", ").slice(0, 300);
  const remaining = Math.max(0, Number(invoice.totalAmount) - Number(invoice.amountPaid));
  const billUrl = `${appOrigin.replace(/\/$/, "")}/bill/${String(invoice.publicToken)}`;
  const message = [
    `Hello ${String(invoice.customerName)},`,
    `Your bill ${String(invoice.invoiceNumber)} from ${String(invoice.businessName || user.displayName || "Business")} is ready.`,
    `Items: ${productSummary}`,
    `Bill date: ${dateLabel(String(invoice.issueDate))}`,
    `Total: ${amountLabel(Number(invoice.totalAmount))}`,
    `Paid: ${amountLabel(Number(invoice.amountPaid))}`,
    remaining > 0 ? `Pending: ${amountLabel(remaining)}` : "Payment received. Thank you!",
    `Payment due date: ${dateLabel(String(invoice.dueDate))}`,
    `View bill: ${billUrl}`,
  ].join("\n");
  const now = Date.now();
  await database.execute({
    sql: `INSERT INTO invoice_deliveries
      (owner_user_id, invoice_id, channel, destination, message, status, provider_reference, error_message, created_at, sent_at, updated_at)
      VALUES (?, ?, 'whatsapp', ?, ?, 'prepared', '', '', ?, NULL, ?)
      ON CONFLICT(invoice_id, channel) DO UPDATE SET destination = excluded.destination,
        message = excluded.message, updated_at = excluded.updated_at`,
    args: [user.id, invoiceId, destination, message, now, now],
  });
  return { destination, message, billUrl, whatsappUrl: `https://wa.me/${destination}?text=${encodeURIComponent(message)}`, status: "prepared" as const };
}

export async function sendPreparedInvoiceDelivery(user: BillingUser, invoiceId: number, appOrigin: string, database: Client = getClient()) {
  const prepared = await prepareInvoiceDelivery(user, invoiceId, appOrigin, database);
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const templateName = process.env.WHATSAPP_BILL_TEMPLATE_NAME;
  const graphVersion = process.env.WHATSAPP_GRAPH_API_VERSION || "v22.0";
  const invoice = (await getInvoice(user, invoiceId, database))?.invoice;
  if (!invoice) throw new Error("Bill message could not be sent");
  if (Number(invoice.contactConsent || 0) !== 1 || !token || !phoneNumberId || !templateName) return { ...prepared, status: "prepared" as const, automatic: false };
  // A durable claim prevents simultaneous sends and unsafe retries after a lost response.
  const claim = await database.execute({
    sql: "UPDATE invoice_deliveries SET automatic_attempted_at = ?, updated_at = ? WHERE invoice_id = ? AND owner_user_id = ? AND channel = 'whatsapp' AND automatic_attempted_at IS NULL AND status = 'prepared'",
    args: [Date.now(), Date.now(), invoiceId, user.id],
  });
  if (claim.rowsAffected !== 1) {
    const saved = await database.execute({ sql: "SELECT status FROM invoice_deliveries WHERE invoice_id = ? AND owner_user_id = ? AND channel = 'whatsapp'", args: [invoiceId, user.id] });
    if (saved.rows[0]?.status === "sent") return { ...prepared, status: "sent" as const, automatic: true };
    return { ...prepared, status: "failed" as const, automatic: true, error: "An automatic send was already attempted. Check WhatsApp delivery before sharing manually; it may already have arrived." };
  }
  const languageCode = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en";
  const body = {
    messaging_product: "whatsapp",
    to: prepared.destination,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      components: [{ type: "body", parameters: [
        String(invoice.customerName), String(invoice.invoiceNumber), dateLabel(String(invoice.issueDate)),
        amountLabel(Number(invoice.totalAmount)), amountLabel(Number(invoice.totalAmount) - Number(invoice.amountPaid)),
        dateLabel(String(invoice.dueDate)), prepared.billUrl,
      ].map((text) => ({ type: "text", text })) }],
    },
  };
  try {
    const response = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
      signal: AbortSignal.timeout(15_000),
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({})) as { messages?: Array<{ id?: string }>; error?: { message?: string } };
    if (!response.ok) throw new Error(result.error?.message || `WhatsApp API returned ${response.status}`);
    if (!result.messages?.[0]?.id) throw new Error("WhatsApp returned no message confirmation. Check delivery before sharing manually.");
    const now = Date.now();
    await database.execute({ sql: `UPDATE invoice_deliveries SET status = 'sent', provider_reference = ?, error_message = '', sent_at = ?, updated_at = ?
      WHERE invoice_id = ? AND owner_user_id = ? AND channel = 'whatsapp'`, args: [String(result.messages?.[0]?.id || ""), now, now, invoiceId, user.id] });
    return { ...prepared, status: "sent" as const, automatic: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "WhatsApp message could not be sent";
    await database.execute({ sql: `UPDATE invoice_deliveries SET status = 'failed', error_message = ?, updated_at = ?
      WHERE invoice_id = ? AND owner_user_id = ? AND channel = 'whatsapp'`, args: [message.slice(0, 500), Date.now(), invoiceId, user.id] });
    return { ...prepared, status: "failed" as const, automatic: true, error: message };
  }
}

export async function reviewInvoiceDelivery(user: BillingUser, invoiceId: number, note: unknown, database: Client = getClient()) {
  const text = String(note || "").trim();
  if (text.length < 10 || text.length > 500) throw new Error("Describe the delivery check in 10–500 characters.");
  const invoice = await getInvoice(user, invoiceId, database);
  if (!invoice) throw new Error("Bill not found");
  const updated = await database.execute({
    sql: "UPDATE invoice_deliveries SET review_note = ?, reviewed_at = ?, updated_at = ? WHERE invoice_id = ? AND owner_user_id = ? AND automatic_attempted_at IS NOT NULL AND status != 'sent'",
    args: [text, Date.now(), Date.now(), invoiceId, user.id],
  });
  if (updated.rowsAffected !== 1) throw new Error("This bill has no uncertain automatic delivery to review.");
  return { reviewed: true };
}
