import { createClient, type Client, type InValue } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { randomBytes } from "node:crypto";
import * as schema from "./schema";
import { backfillCustomerPhoneKeys } from "./customer-identity";

type SqlStatement = { sql: string; args: InValue[] };

export type PreparedStatement = SqlStatement & {
  bind: (...args: unknown[]) => PreparedStatement;
  run: () => Promise<{ meta: { last_row_id: number; changes: number } }>;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
};

let client: Client | null = null;

function databaseUrl() {
  if (process.env.VERCEL_ENV === "preview") {
    const previewUrl = process.env.YAADRAKHO_TEST_TURSO_DATABASE_URL || process.env.PREVIEW_TURSO_DATABASE_URL;
    if (!previewUrl || previewUrl === process.env.TURSO_DATABASE_URL || previewUrl === process.env.DATABASE_URL) {
      throw new Error("Configure a separate PREVIEW_TURSO_DATABASE_URL before testing this deployment.");
    }
    return previewUrl;
  }
  const url = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL;
  if (url) return url;
  if (process.env.VERCEL) {
    throw new Error("TURSO_DATABASE_URL is not configured in Vercel");
  }
  return "file:yaadrakho-local.db";
}

export function getClient() {
  client ??= createClient({
    url: databaseUrl(),
    authToken: (process.env.VERCEL_ENV === "preview" ? (process.env.YAADRAKHO_TEST_TURSO_DATABASE_URL ? process.env.YAADRAKHO_TEST_TURSO_AUTH_TOKEN : process.env.PREVIEW_TURSO_AUTH_TOKEN) : process.env.TURSO_AUTH_TOKEN) || undefined,
  });
  return client;
}

export function getDb() {
  return drizzle(getClient(), { schema });
}

function prepared(sql: string, args: InValue[] = []): PreparedStatement {
  return {
    sql,
    args,
    bind: (...values: unknown[]) => prepared(sql, values as InValue[]),
    run: async () => {
      const result = await getClient().execute({ sql, args });
      return {
        meta: {
          last_row_id: Number(result.lastInsertRowid || 0),
          changes: result.rowsAffected,
        },
      };
    },
    first: async <T>() => {
      const result = await getClient().execute({ sql, args });
      return (result.rows[0] as T | undefined) ?? null;
    },
    all: async <T>() => {
      const result = await getClient().execute({ sql, args });
      return { results: result.rows as unknown as T[] };
    },
  };
}

export function getSqlDatabase() {
  return {
    prepare: (sql: string) => prepared(sql),
    batch: async (statements: PreparedStatement[]) => {
      return getClient().batch(statements.map(({ sql, args }) => ({ sql, args })));
    },
  };
}

let customersTableReady: Promise<void> | null = null;
let subscriptionsTableReady: Promise<void> | null = null;
let appSettingsTableReady: Promise<void> | null = null;
let authTablesReady: Promise<void> | null = null;
let pushTablesReady: Promise<void> | null = null;
let paymentLedgerReady: Promise<void> | null = null;
let billingTablesReady: Promise<void> | null = null;
let razorpayTablesReady: Promise<void> | null = null;

function rememberSetup(current: Promise<void> | null, setup: () => Promise<void>, reset: () => void) {
  if (current) return current;
  return setup().catch((error) => {
    reset();
    throw error;
  });
}

export async function ensureCustomersTable() {
  customersTableReady = rememberSetup(customersTableReady, async () => {
    const db = getSqlDatabase();
    await db.prepare(`CREATE TABLE IF NOT EXISTS customers (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      owner_email text NOT NULL,
      name text NOT NULL,
      phone text NOT NULL,
      requirement text DEFAULT '' NOT NULL,
      amount integer DEFAULT 0 NOT NULL,
      follow_up_date text NOT NULL,
      status text DEFAULT 'new' NOT NULL,
      payment_status text DEFAULT 'pending' NOT NULL,
      billing_cycle text DEFAULT 'one_time' NOT NULL,
      recurring_day integer DEFAULT 1 NOT NULL,
      notes text DEFAULT '' NOT NULL,
      contact_consent integer DEFAULT 0 NOT NULL,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    )`).run();
    const columns = await db.prepare("PRAGMA table_info(customers)").all<{ name: string }>();
    if (!columns.results.some((column) => column.name === "owner_email")) await db.prepare("ALTER TABLE customers ADD COLUMN owner_email text NOT NULL DEFAULT 'legacy-owner'").run();
    if (!columns.results.some((column) => column.name === "amount")) await db.prepare("ALTER TABLE customers ADD COLUMN amount integer NOT NULL DEFAULT 0").run();
    if (!columns.results.some((column) => column.name === "contact_consent")) await db.prepare("ALTER TABLE customers ADD COLUMN contact_consent integer NOT NULL DEFAULT 0").run();
    if (!columns.results.some((column) => column.name === "billing_cycle")) await db.prepare("ALTER TABLE customers ADD COLUMN billing_cycle text NOT NULL DEFAULT 'one_time'").run();
    if (!columns.results.some((column) => column.name === "recurring_day")) await db.prepare("ALTER TABLE customers ADD COLUMN recurring_day integer NOT NULL DEFAULT 1").run();
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS customer_payments (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        customer_id integer NOT NULL,
        owner_email text NOT NULL,
        period_key text NOT NULL,
        amount integer DEFAULT 0 NOT NULL,
        due_date text NOT NULL,
        status text DEFAULT 'paid' NOT NULL,
        paid_at integer NOT NULL,
        created_at integer NOT NULL,
        UNIQUE(customer_id, period_key)
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS customer_payments_owner_idx ON customer_payments (owner_email)"),
      db.prepare("CREATE INDEX IF NOT EXISTS customer_payments_customer_idx ON customer_payments (customer_id)"),
    ]);
  }, () => { customersTableReady = null; });
  await customersTableReady;
}

export async function ensureSubscriptionsTable() {
  subscriptionsTableReady = rememberSetup(subscriptionsTableReady, async () => {
    await getSqlDatabase().prepare(`CREATE TABLE IF NOT EXISTS subscriptions (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      user_email text NOT NULL UNIQUE,
      plan text DEFAULT 'trial' NOT NULL,
      status text DEFAULT 'trial' NOT NULL,
      price integer DEFAULT 0 NOT NULL,
      trial_ends_at integer NOT NULL,
      requested_at integer,
      activated_at integer,
      updated_at integer NOT NULL
    )`).run();
  }, () => { subscriptionsTableReady = null; });
  await subscriptionsTableReady;
}

export async function ensureAppSettingsTable() {
  appSettingsTableReady = rememberSetup(appSettingsTableReady, async () => {
    await getSqlDatabase().prepare(`CREATE TABLE IF NOT EXISTS app_settings (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      user_email text NOT NULL UNIQUE,
      business_name text DEFAULT '' NOT NULL,
      phone text DEFAULT '' NOT NULL,
      updated_at integer NOT NULL
    )`).run();
  }, () => { appSettingsTableReady = null; });
  await appSettingsTableReady;
}

export async function ensureAuthTables() {
  authTablesReady = rememberSetup(authTablesReady, async () => {
    const db = getSqlDatabase();
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS users (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        email text NOT NULL UNIQUE,
        display_name text NOT NULL,
        storage_key text NOT NULL UNIQUE,
        password_salt text NOT NULL,
        password_hash text NOT NULL,
        recovery_salt text NOT NULL,
        recovery_hash text NOT NULL,
        is_owner integer DEFAULT 0 NOT NULL,
        email_verified_at integer,
        last_login_at integer,
        last_activity_at integer,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        user_id integer NOT NULL,
        token_hash text NOT NULL UNIQUE,
        expires_at integer NOT NULL,
        created_at integer NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS login_attempts (
        email text PRIMARY KEY NOT NULL,
        attempt_count integer DEFAULT 0 NOT NULL,
        window_started_at integer NOT NULL,
        locked_until integer
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS email_reset_challenges (
  challenge_hash TEXT PRIMARY KEY NOT NULL, user_id INTEGER NOT NULL UNIQUE,
  otp_hash TEXT NOT NULL, password_version TEXT NOT NULL,
  expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0
)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS account_tokens (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        user_id integer NOT NULL,
        purpose text NOT NULL,
        token_hash text NOT NULL UNIQUE,
        expires_at integer NOT NULL,
        used_at integer,
        created_at integer NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS auth_requests (
        request_key text PRIMARY KEY NOT NULL,
        request_count integer DEFAULT 0 NOT NULL,
        window_started_at integer NOT NULL,
        blocked_until integer
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS account_phones (
 user_id integer PRIMARY KEY NOT NULL, phone text NOT NULL UNIQUE, verified_at integer NOT NULL
)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS sms_challenges (
 token_hash text PRIMARY KEY NOT NULL, user_id integer, phone text NOT NULL,
 purpose text NOT NULL CHECK(purpose IN ('enroll','login','reset')),
 password_version text NOT NULL DEFAULT '', provider_sid text,
 status text NOT NULL DEFAULT 'sending', attempts integer NOT NULL DEFAULT 0,
 expires_at integer NOT NULL, created_at integer NOT NULL
)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS sms_challenges_phone_idx ON sms_challenges(phone, created_at)`),
      db.prepare("CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS account_tokens_user_purpose_idx ON account_tokens (user_id, purpose)"),
      db.prepare("CREATE INDEX IF NOT EXISTS account_tokens_expires_at_idx ON account_tokens (expires_at)"),
    ]);
    const columns = await db.prepare("PRAGMA table_info(users)").all<{ name: string }>();
    const existingAccountCutoff = Date.now();
    if (!columns.results.some((column) => column.name === "email_verified_at")) {
      await db.prepare("ALTER TABLE users ADD COLUMN email_verified_at integer").run();
      await db.prepare("UPDATE users SET email_verified_at = ? WHERE created_at <= ? AND email_verified_at IS NULL")
        .bind(existingAccountCutoff, existingAccountCutoff).run();
    }
    if (!columns.results.some((column) => column.name === "last_login_at")) await db.prepare("ALTER TABLE users ADD COLUMN last_login_at integer").run();
    if (!columns.results.some((column) => column.name === "last_activity_at")) await db.prepare("ALTER TABLE users ADD COLUMN last_activity_at integer").run();
  }, () => { authTablesReady = null; });
  await authTablesReady;
}

export async function ensurePushTables() {
  pushTablesReady = rememberSetup(pushTablesReady, async () => {
    const db = getSqlDatabase();
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS push_subscriptions (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        owner_key text NOT NULL,
        endpoint text NOT NULL UNIQUE,
        p256dh text NOT NULL,
        auth text NOT NULL,
        extra_reminder_times text DEFAULT '' NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS push_deliveries (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        subscription_id integer NOT NULL,
        date_key text NOT NULL,
        sent_at integer NOT NULL,
        UNIQUE(subscription_id, date_key)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS push_delivery_slots (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        subscription_id integer NOT NULL,
        date_key text NOT NULL,
        delivery_slot text NOT NULL,
        sent_at integer NOT NULL,
        UNIQUE(subscription_id, date_key, delivery_slot)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS push_delivery_claims (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        subscription_id integer NOT NULL,
        date_key text NOT NULL,
        delivery_slot text NOT NULL,
        claimed_at integer NOT NULL,
        UNIQUE(subscription_id, date_key, delivery_slot)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS push_delivery_items (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        subscription_id integer NOT NULL,
        due_id integer NOT NULL,
        date_key text NOT NULL,
        delivery_slot text NOT NULL,
        sent_at integer NOT NULL,
        UNIQUE(subscription_id, due_id, date_key, delivery_slot)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS reminder_job_runs (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        date_key text NOT NULL,
        delivery_slot text NOT NULL,
        started_at integer NOT NULL,
        finished_at integer,
        checked_subscriptions integer DEFAULT 0 NOT NULL,
        sent_notifications integer DEFAULT 0 NOT NULL,
        failed_notifications integer DEFAULT 0 NOT NULL,
        removed_subscriptions integer DEFAULT 0 NOT NULL,
        status text DEFAULT 'running' NOT NULL,
        error_message text DEFAULT '' NOT NULL
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS push_subscriptions_owner_idx ON push_subscriptions (owner_key)"),
      db.prepare("CREATE INDEX IF NOT EXISTS push_deliveries_date_idx ON push_deliveries (date_key)"),
      db.prepare("CREATE INDEX IF NOT EXISTS push_delivery_slots_date_idx ON push_delivery_slots (date_key)"),
      db.prepare("CREATE INDEX IF NOT EXISTS push_delivery_claims_claimed_idx ON push_delivery_claims (claimed_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS push_delivery_items_date_idx ON push_delivery_items (date_key)"),
      db.prepare("CREATE INDEX IF NOT EXISTS reminder_job_runs_started_idx ON reminder_job_runs (started_at)"),
    ]);
    const columns = await db.prepare("PRAGMA table_info(push_subscriptions)").all<{ name: string }>();
    if (!columns.results.some((column) => column.name === "extra_reminder_times")) {
      await db.prepare("ALTER TABLE push_subscriptions ADD COLUMN extra_reminder_times text NOT NULL DEFAULT ''").run();
    }
  }, () => { pushTablesReady = null; });
  await pushTablesReady;
}

export async function ensurePaymentLedgerTables() {
  paymentLedgerReady = rememberSetup(paymentLedgerReady, async () => {
    await Promise.all([ensureAuthTables(), ensureCustomersTable()]);
    const db = getSqlDatabase();
    const customerColumns = await db.prepare("PRAGMA table_info(customers)").all<{ name: string }>();
    if (!customerColumns.results.some((column) => column.name === "owner_user_id")) await db.prepare("ALTER TABLE customers ADD COLUMN owner_user_id integer").run();
    if (!customerColumns.results.some((column) => column.name === "current_due_id")) await db.prepare("ALTER TABLE customers ADD COLUMN current_due_id integer").run();
    if (!customerColumns.results.some((column) => column.name === "phone_key")) await db.prepare("ALTER TABLE customers ADD COLUMN phone_key text").run();
    await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS customers_owner_phone_key_unique ON customers (owner_user_id, phone_key) WHERE owner_user_id IS NOT NULL AND phone_key IS NOT NULL AND phone_key != ''").run();
    const legacyColumns = await db.prepare("PRAGMA table_info(customer_payments)").all<{ name: string }>();
    if (!legacyColumns.results.some((column) => column.name === "owner_user_id")) await db.prepare("ALTER TABLE customer_payments ADD COLUMN owner_user_id integer").run();
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS payment_dues (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        owner_user_id integer NOT NULL,
        owner_key text NOT NULL,
        customer_id integer NOT NULL,
        period_key text NOT NULL,
        due_date text NOT NULL,
        amount_due integer NOT NULL CHECK(amount_due >= 0),
        amount_paid integer DEFAULT 0 NOT NULL CHECK(amount_paid >= 0 AND amount_paid <= amount_due),
        status text DEFAULT 'pending' NOT NULL CHECK(status IN ('pending','partial','paid')),
        paid_at integer,
        created_at integer NOT NULL,
        updated_at integer NOT NULL,
        UNIQUE(owner_user_id, customer_id, period_key)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS payment_transactions (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        owner_user_id integer NOT NULL,
        owner_key text NOT NULL,
        customer_id integer NOT NULL,
        due_id integer NOT NULL,
        idempotency_key text NOT NULL,
        amount integer NOT NULL CHECK(amount > 0),
        method text DEFAULT 'other' NOT NULL CHECK(method IN ('cash','upi','paytm','bank','other')),
        reference text DEFAULT '' NOT NULL,
        note text DEFAULT '' NOT NULL,
        received_at integer NOT NULL,
        created_at integer NOT NULL,
        UNIQUE(owner_user_id, idempotency_key)
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS payment_dues_owner_status_idx ON payment_dues (owner_user_id, status, due_date)"),
      db.prepare("CREATE INDEX IF NOT EXISTS payment_dues_customer_idx ON payment_dues (customer_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS payment_transactions_due_idx ON payment_transactions (due_id, received_at)"),
    ]);
    const transactionColumns = await db.prepare("PRAGMA table_info(payment_transactions)").all<{ name: string }>();
    if (!transactionColumns.results.some((column) => column.name === "receipt_number")) await db.prepare("ALTER TABLE payment_transactions ADD COLUMN receipt_number text").run();
    if (!transactionColumns.results.some((column) => column.name === "receipt_token")) await db.prepare("ALTER TABLE payment_transactions ADD COLUMN receipt_token text").run();
    if (!transactionColumns.results.some((column) => column.name === "balance_after")) await db.prepare("ALTER TABLE payment_transactions ADD COLUMN balance_after integer").run();
    const now = Date.now();
    await db.batch([
      db.prepare("UPDATE customers SET owner_user_id = (SELECT id FROM users WHERE users.storage_key = customers.owner_email) WHERE owner_user_id IS NULL"),
      db.prepare("UPDATE customer_payments SET owner_user_id = (SELECT id FROM users WHERE users.storage_key = customer_payments.owner_email) WHERE owner_user_id IS NULL"),
      db.prepare(`INSERT OR IGNORE INTO payment_dues
        (owner_user_id, owner_key, customer_id, period_key, due_date, amount_due, amount_paid, status, paid_at, created_at, updated_at)
        SELECT cp.owner_user_id, cp.owner_email, cp.customer_id, cp.period_key, cp.due_date, cp.amount, cp.amount,
          'paid', cp.paid_at, cp.created_at, ? FROM customer_payments cp WHERE cp.owner_user_id IS NOT NULL`).bind(now),
      db.prepare(`INSERT OR IGNORE INTO payment_transactions
        (owner_user_id, owner_key, customer_id, due_id, idempotency_key, amount, method, reference, note, received_at, created_at)
        SELECT cp.owner_user_id, cp.owner_email, cp.customer_id, pd.id, 'legacy-customer-payment:' || cp.id,
          cp.amount, 'other', '', 'Backfilled from customer_payments', cp.paid_at, cp.created_at
        FROM customer_payments cp JOIN payment_dues pd ON pd.owner_user_id = cp.owner_user_id
          AND pd.customer_id = cp.customer_id AND pd.period_key = cp.period_key
        WHERE cp.owner_user_id IS NOT NULL AND cp.amount > 0
          AND NOT EXISTS (SELECT 1 FROM payment_transactions pt
            WHERE pt.owner_user_id = cp.owner_user_id AND pt.due_id = pd.id)`),
      db.prepare(`INSERT OR IGNORE INTO payment_dues
        (owner_user_id, owner_key, customer_id, period_key, due_date, amount_due, amount_paid, status, paid_at, created_at, updated_at)
        SELECT c.owner_user_id, c.owner_email, c.id,
          CASE WHEN c.billing_cycle = 'monthly' THEN substr(c.follow_up_date, 1, 7) ELSE 'one-time:' || c.id END,
          c.follow_up_date, c.amount,
          CASE WHEN c.billing_cycle = 'one_time' AND (c.payment_status = 'paid' OR c.status = 'won') THEN c.amount ELSE 0 END,
          CASE WHEN c.billing_cycle = 'one_time' AND (c.payment_status = 'paid' OR c.status = 'won') THEN 'paid' ELSE 'pending' END,
          CASE WHEN c.billing_cycle = 'one_time' AND (c.payment_status = 'paid' OR c.status = 'won') THEN c.updated_at ELSE NULL END,
          c.created_at, ? FROM customers c WHERE c.owner_user_id IS NOT NULL
          AND c.current_due_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM payment_dues existing
            WHERE existing.owner_user_id = c.owner_user_id AND existing.customer_id = c.id
              AND existing.period_key LIKE 'invoice:%')`).bind(now),
      db.prepare(`UPDATE customers SET current_due_id = (
        SELECT pd.id FROM payment_dues pd WHERE pd.owner_user_id = customers.owner_user_id
          AND pd.customer_id = customers.id
          AND pd.period_key = CASE WHEN customers.billing_cycle = 'monthly' THEN substr(customers.follow_up_date,1,7) ELSE 'one-time:' || customers.id END
        LIMIT 1) WHERE owner_user_id IS NOT NULL AND current_due_id IS NULL`),
    ]);
    const receiptBackfill = await db.prepare(`SELECT id, received_at AS receivedAt FROM payment_transactions
      WHERE receipt_number IS NULL OR receipt_number = '' OR receipt_token IS NULL OR receipt_token = '' OR balance_after IS NULL
      ORDER BY id`).all<{ id: number; receivedAt: number }>();
    for (const row of receiptBackfill.results) {
      const balance = await db.prepare(`SELECT pd.amount_due AS amountDue,
        COALESCE(SUM(previous.amount), 0) AS paidToDate
        FROM payment_transactions current_payment
        JOIN payment_dues pd ON pd.id = current_payment.due_id AND pd.owner_user_id = current_payment.owner_user_id
        LEFT JOIN payment_transactions previous ON previous.due_id = current_payment.due_id
          AND previous.owner_user_id = current_payment.owner_user_id
          AND (previous.received_at < current_payment.received_at
            OR (previous.received_at = current_payment.received_at AND previous.id <= current_payment.id))
        WHERE current_payment.id = ? GROUP BY pd.amount_due`).bind(row.id).first<{ amountDue: number; paidToDate: number }>();
      const year = new Date(Number(row.receivedAt || Date.now())).getUTCFullYear();
      await db.prepare(`UPDATE payment_transactions SET
        receipt_number = COALESCE(NULLIF(receipt_number, ''), ?),
        receipt_token = COALESCE(NULLIF(receipt_token, ''), ?),
        balance_after = COALESCE(balance_after, ?)
        WHERE id = ?`).bind(
        `YR-R-${year}-${String(row.id).padStart(6, "0")}`,
        randomBytes(16).toString("hex"),
        Math.max(0, Number(balance?.amountDue || 0) - Number(balance?.paidToDate || 0)),
        row.id,
      ).run();
    }
    await db.batch([
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_receipt_number_unique ON payment_transactions (receipt_number) WHERE receipt_number IS NOT NULL"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_receipt_token_unique ON payment_transactions (receipt_token) WHERE receipt_token IS NOT NULL"),
    ]);
    await backfillCustomerPhoneKeys(getClient());
  }, () => { paymentLedgerReady = null; });
  await paymentLedgerReady;
}

export async function ensureBillingTables() {
  billingTablesReady = rememberSetup(billingTablesReady, async () => {
    await Promise.all([ensurePaymentLedgerTables(), ensureAppSettingsTable()]);
    const db = getSqlDatabase();
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS product_catalog (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        owner_user_id integer NOT NULL,
        owner_key text NOT NULL,
        name text NOT NULL,
        name_key text NOT NULL,
        price integer NOT NULL CHECK(price >= 0),
        gst_rate integer DEFAULT 0 NOT NULL CHECK(gst_rate IN (0,5,12,18,28)),
        unit text DEFAULT 'item' NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL,
        UNIQUE(owner_user_id, name_key)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS invoice_sequences (
        owner_user_id integer PRIMARY KEY NOT NULL,
        next_value integer DEFAULT 1 NOT NULL CHECK(next_value > 0)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS invoices (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        owner_user_id integer NOT NULL,
        owner_key text NOT NULL,
        customer_id integer NOT NULL,
        due_id integer,
        invoice_number text NOT NULL,
        idempotency_key text,
        billing_mode text DEFAULT 'separate' NOT NULL CHECK(billing_mode IN ('separate','monthly_statement')),
        issue_date text NOT NULL,
        due_date text NOT NULL,
        subtotal integer NOT NULL CHECK(subtotal >= 0),
        discount_amount integer DEFAULT 0 NOT NULL CHECK(discount_amount >= 0 AND discount_amount <= subtotal),
        tax_amount integer DEFAULT 0 NOT NULL CHECK(tax_amount >= 0),
        total_amount integer NOT NULL CHECK(total_amount > 0),
        amount_paid integer DEFAULT 0 NOT NULL CHECK(amount_paid >= 0 AND amount_paid <= total_amount),
        status text DEFAULT 'issued' NOT NULL CHECK(status IN ('issued','partial','paid','cancelled')),
        notes text DEFAULT '' NOT NULL,
        public_token text,
        created_at integer NOT NULL,
        updated_at integer NOT NULL,
        UNIQUE(owner_user_id, invoice_number)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS invoice_items (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        invoice_id integer NOT NULL,
        product_id integer,
        description text NOT NULL,
        quantity_milli integer NOT NULL CHECK(quantity_milli > 0),
        unit text DEFAULT 'item' NOT NULL,
        unit_price integer NOT NULL CHECK(unit_price >= 0),
        gst_rate integer DEFAULT 0 NOT NULL CHECK(gst_rate IN (0,5,12,18,28)),
        line_subtotal integer NOT NULL CHECK(line_subtotal >= 0),
        line_discount integer DEFAULT 0 NOT NULL CHECK(line_discount >= 0 AND line_discount <= line_subtotal),
        line_tax integer DEFAULT 0 NOT NULL CHECK(line_tax >= 0),
        line_total integer NOT NULL CHECK(line_total >= 0),
        created_at integer NOT NULL
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS invoice_deliveries (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        owner_user_id integer NOT NULL,
        invoice_id integer NOT NULL,
        channel text DEFAULT 'whatsapp' NOT NULL CHECK(channel IN ('whatsapp')),
        destination text NOT NULL,
        message text NOT NULL,
        status text DEFAULT 'prepared' NOT NULL CHECK(status IN ('prepared','sent','failed')),
        provider_reference text DEFAULT '' NOT NULL,
        error_message text DEFAULT '' NOT NULL,
        created_at integer NOT NULL,
        sent_at integer,
        updated_at integer NOT NULL,
        UNIQUE(invoice_id, channel)
      )`),
      db.prepare("CREATE INDEX IF NOT EXISTS product_catalog_owner_idx ON product_catalog (owner_user_id, name)"),
      db.prepare("CREATE INDEX IF NOT EXISTS invoices_owner_date_idx ON invoices (owner_user_id, issue_date, id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS invoices_customer_idx ON invoices (owner_user_id, customer_id, created_at)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS invoices_due_unique ON invoices (due_id) WHERE due_id IS NOT NULL"),
      db.prepare("CREATE INDEX IF NOT EXISTS invoice_items_invoice_idx ON invoice_items (invoice_id, id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS invoice_deliveries_owner_idx ON invoice_deliveries (owner_user_id, status, created_at)"),
    ]);
    const deliveryColumns = await db.prepare("PRAGMA table_info(invoice_deliveries)").all<{ name: string }>();
    if (!deliveryColumns.results.some(column => column.name === "automatic_attempted_at")) await db.prepare("ALTER TABLE invoice_deliveries ADD COLUMN automatic_attempted_at integer").run();
    if (!deliveryColumns.results.some(column => column.name === "review_note")) await db.prepare("ALTER TABLE invoice_deliveries ADD COLUMN review_note text NOT NULL DEFAULT ''").run();
    if (!deliveryColumns.results.some(column => column.name === "reviewed_at")) await db.prepare("ALTER TABLE invoice_deliveries ADD COLUMN reviewed_at integer").run();
    const invoiceColumns = await db.prepare("PRAGMA table_info(invoices)").all<{ name: string }>();
    if (!invoiceColumns.results.some((column) => column.name === "discount_amount")) await db.prepare("ALTER TABLE invoices ADD COLUMN discount_amount integer NOT NULL DEFAULT 0").run();
    if (!invoiceColumns.results.some((column) => column.name === "public_token")) await db.prepare("ALTER TABLE invoices ADD COLUMN public_token text").run();
    if (!invoiceColumns.results.some((column) => column.name === "idempotency_key")) await db.prepare("ALTER TABLE invoices ADD COLUMN idempotency_key text").run();
    if (!invoiceColumns.results.some((column) => column.name === "remaining_payment")) await db.prepare("ALTER TABLE invoices ADD COLUMN remaining_payment text NOT NULL DEFAULT 'online' CHECK(remaining_payment IN ('online','cash'))").run();
    const itemColumns = await db.prepare("PRAGMA table_info(invoice_items)").all<{ name: string }>();
    if (!itemColumns.results.some((column) => column.name === "line_discount")) await db.prepare("ALTER TABLE invoice_items ADD COLUMN line_discount integer NOT NULL DEFAULT 0").run();
    await db.batch([
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS invoices_public_token_unique ON invoices (public_token) WHERE public_token IS NOT NULL"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS invoices_idempotency_unique ON invoices (owner_user_id, idempotency_key) WHERE idempotency_key IS NOT NULL"),
      db.prepare("CREATE INDEX IF NOT EXISTS invoices_due_status_idx ON invoices (owner_user_id, status, due_date)"),
    ]);
  }, () => { billingTablesReady = null; });
  await billingTablesReady;
}

export async function ensureRazorpayTables() {
  razorpayTablesReady = rememberSetup(razorpayTablesReady, async () => {
    await ensureBillingTables();
    const db = getSqlDatabase();
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS business_payment_accounts (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        owner_user_id integer NOT NULL,
        owner_key text NOT NULL,
        provider text DEFAULT 'razorpay_route' NOT NULL CHECK(provider = 'razorpay_route'),
        mode text DEFAULT 'test' NOT NULL CHECK(mode IN ('test','live')),
        provider_account_id text,
        status text DEFAULT 'pending' NOT NULL CHECK(status IN ('pending','active','restricted','suspended')),
        created_at integer NOT NULL,
        updated_at integer NOT NULL,
        activated_at integer,
        UNIQUE(owner_user_id, provider, mode)
      )`),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS business_payment_accounts_provider_unique ON business_payment_accounts (provider, mode, provider_account_id) WHERE provider_account_id IS NOT NULL"),
      db.prepare("CREATE INDEX IF NOT EXISTS business_payment_accounts_owner_status_idx ON business_payment_accounts (owner_user_id, mode, status)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS razorpay_orders (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        owner_user_id integer NOT NULL,
        owner_key text NOT NULL,
        customer_id integer NOT NULL,
        invoice_id integer NOT NULL,
        due_id integer NOT NULL,
        request_key text NOT NULL,
        razorpay_order_id text,
        amount integer NOT NULL CHECK(amount > 0),
        currency text DEFAULT 'INR' NOT NULL CHECK(currency = 'INR'),
        status text DEFAULT 'creating' NOT NULL CHECK(status IN ('creating','created','paid','failed','cancelled')),
        payment_id text,
        error_message text DEFAULT '' NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL,
        paid_at integer,
        UNIQUE(owner_user_id, request_key)
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS razorpay_captures (
 payment_id text PRIMARY KEY NOT NULL, razorpay_order_id text NOT NULL,
 owner_user_id integer NOT NULL, invoice_id integer NOT NULL, due_id integer NOT NULL,
 amount integer NOT NULL, currency text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','needs_review')),
 error_message text NOT NULL DEFAULT '', created_at integer NOT NULL, updated_at integer NOT NULL
)`),
      db.prepare("CREATE INDEX IF NOT EXISTS razorpay_captures_review_idx ON razorpay_captures (status, owner_user_id)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS payment_review_attempts (
 id integer PRIMARY KEY AUTOINCREMENT NOT NULL, payment_id text NOT NULL, actor_user_id integer NOT NULL,
 status text NOT NULL DEFAULT 'started' CHECK(status IN ('started','applied','review_required','failed')),
 error_message text NOT NULL DEFAULT '', created_at integer NOT NULL, finished_at integer
)`),
      db.prepare("CREATE INDEX IF NOT EXISTS payment_review_attempts_payment_idx ON payment_review_attempts (payment_id, created_at)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS order_recovery_attempts (
 id integer PRIMARY KEY AUTOINCREMENT NOT NULL, local_order_id integer NOT NULL,
 actor_user_id integer, source text NOT NULL, status text NOT NULL DEFAULT 'started',
 provider_order_id text, message text NOT NULL DEFAULT '', created_at integer NOT NULL, finished_at integer
)`),
      db.prepare("CREATE INDEX IF NOT EXISTS order_recovery_local_idx ON order_recovery_attempts(local_order_id, created_at)"),
      db.prepare(`CREATE TABLE IF NOT EXISTS payment_reconciliations (
 payment_id text PRIMARY KEY NOT NULL, refund_id text NOT NULL UNIQUE,
 actor_user_id integer NOT NULL, note text NOT NULL, created_at integer NOT NULL
)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS razorpay_webhook_events (
        event_id text PRIMARY KEY NOT NULL,
        event_type text NOT NULL,
        status text DEFAULT 'received' NOT NULL CHECK(status IN ('received','processed','ignored','failed')),
        error_message text DEFAULT '' NOT NULL,
        created_at integer NOT NULL,
        processed_at integer
      )`),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS razorpay_orders_order_unique ON razorpay_orders (razorpay_order_id) WHERE razorpay_order_id IS NOT NULL"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS razorpay_orders_payment_unique ON razorpay_orders (payment_id) WHERE payment_id IS NOT NULL"),
      db.prepare("CREATE INDEX IF NOT EXISTS razorpay_orders_invoice_idx ON razorpay_orders (invoice_id, status, created_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS razorpay_orders_owner_idx ON razorpay_orders (owner_user_id, status, created_at)"),
    ]);
    const orderColumns = await db.prepare("PRAGMA table_info(razorpay_orders)").all<{ name: string }>();
    if (!orderColumns.results.some((column) => column.name === "payment_account_id")) await db.prepare("ALTER TABLE razorpay_orders ADD COLUMN payment_account_id integer").run();
    if (!orderColumns.results.some((column) => column.name === "provider_account_id")) await db.prepare("ALTER TABLE razorpay_orders ADD COLUMN provider_account_id text").run();
    if (!orderColumns.results.some((column) => column.name === "transfer_id")) await db.prepare("ALTER TABLE razorpay_orders ADD COLUMN transfer_id text").run();
    if (!orderColumns.results.some((column) => column.name === "transfer_status")) await db.prepare("ALTER TABLE razorpay_orders ADD COLUMN transfer_status text NOT NULL DEFAULT 'not_requested'").run();
    if (!orderColumns.results.some((column) => column.name === "transfer_error")) await db.prepare("ALTER TABLE razorpay_orders ADD COLUMN transfer_error text NOT NULL DEFAULT ''").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS razorpay_orders_provider_account_idx ON razorpay_orders (provider_account_id, transfer_status, created_at)").run();
  }, () => { razorpayTablesReady = null; });
  await razorpayTablesReady;
}
