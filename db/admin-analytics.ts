import {
  ensureAuthTables,
  ensurePaymentLedgerTables,
  ensurePushTables,
  ensureRazorpayTables,
  ensureSubscriptionsTable,
  getSqlDatabase,
} from ".";

export type AdminBusinessFilter = "all" | "active" | "inactive" | "unverified" | "paid" | "trial";

export type AdminOverviewInput = {
  query?: string;
  filter?: AdminBusinessFilter;
  page?: number;
  pageSize?: number;
};

type MetricRow = {
  total_businesses: number;
  verified_businesses: number;
  active_businesses: number;
  total_customers: number;
  monthly_customers: number;
  outstanding_amount: number;
  collected_amount: number;
  reminder_businesses: number;
  paid_accounts: number;
};

type BusinessRow = {
  id: number;
  display_name: string;
  email: string;
  email_verified_at: number | null;
  created_at: number;
  last_login_at: number | null;
  last_activity_at: number | null;
  plan: "trial" | "starter" | "pro";
  plan_status: "trial" | "pending" | "active" | "cancelled";
  customer_count: number;
  monthly_customers: number;
  outstanding_amount: number;
  collected_amount: number;
  reminder_devices: number;
  payment_account_status: "pending" | "active" | "restricted" | "suspended" | null;
  provider_account_id: string | null;
};

type ReminderRunRow = {
  date_key: string;
  delivery_slot: string;
  started_at: number;
  finished_at: number | null;
  checked_subscriptions: number;
  sent_notifications: number;
  failed_notifications: number;
  removed_subscriptions: number;
  status: "running" | "completed" | "failed";
  error_message: string;
};

const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const allowedFilters = new Set<AdminBusinessFilter>(["all", "active", "inactive", "unverified", "paid", "trial"]);
let analyticsIndexesReady: Promise<void> | null = null;

async function ensureAdminAnalyticsIndexes() {
  analyticsIndexesReady ??= (async () => {
    const db = getSqlDatabase();
    await db.batch([
      db.prepare("CREATE INDEX IF NOT EXISTS users_owner_activity_idx ON users (is_owner, last_activity_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS customers_owner_user_idx ON customers (owner_user_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS payment_transactions_owner_user_idx ON payment_transactions (owner_user_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS subscriptions_plan_status_idx ON subscriptions (plan, status)"),
    ]);
  })().catch((error) => {
    analyticsIndexesReady = null;
    throw error;
  });
  await analyticsIndexesReady;
}

function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function normalizeAdminOverviewInput(input: AdminOverviewInput = {}) {
  const query = String(input.query || "").trim().slice(0, 120);
  const filter = allowedFilters.has(input.filter || "all") ? input.filter || "all" : "all";
  const page = Math.max(1, Math.floor(Number(input.page) || 1));
  const pageSize = Math.min(50, Math.max(10, Math.floor(Number(input.pageSize) || 20)));
  return { query, filter, page, pageSize };
}

export async function getAdminOverview(input: AdminOverviewInput = {}) {
  await Promise.all([
    ensureAuthTables(),
    ensurePaymentLedgerTables(),
    ensurePushTables(),
    ensureSubscriptionsTable(),
    ensureRazorpayTables(),
  ]);
  await ensureAdminAnalyticsIndexes();

  const db = getSqlDatabase();
  const { query, filter, page, pageSize } = normalizeAdminOverviewInput(input);
  const activeSince = Date.now() - ACTIVE_WINDOW_MS;

  const metrics = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM users WHERE is_owner = 0) AS total_businesses,
    (SELECT COUNT(*) FROM users WHERE is_owner = 0 AND email_verified_at IS NOT NULL) AS verified_businesses,
    (SELECT COUNT(*) FROM users WHERE is_owner = 0 AND last_activity_at >= ?) AS active_businesses,
    (SELECT COUNT(*) FROM customers c JOIN users u ON u.id = c.owner_user_id WHERE u.is_owner = 0) AS total_customers,
    (SELECT COUNT(*) FROM customers c JOIN users u ON u.id = c.owner_user_id WHERE u.is_owner = 0 AND c.billing_cycle = 'monthly') AS monthly_customers,
    (SELECT COALESCE(SUM(pd.amount_due - pd.amount_paid), 0) FROM payment_dues pd JOIN users u ON u.id = pd.owner_user_id WHERE u.is_owner = 0 AND pd.status != 'paid') AS outstanding_amount,
    (SELECT COALESCE(SUM(pt.amount), 0) FROM payment_transactions pt JOIN users u ON u.id = pt.owner_user_id WHERE u.is_owner = 0) AS collected_amount,
    (SELECT COUNT(DISTINCT ps.owner_key) FROM push_subscriptions ps JOIN users u ON u.storage_key = ps.owner_key WHERE u.is_owner = 0) AS reminder_businesses,
    (SELECT COUNT(*) FROM subscriptions s JOIN users u ON u.storage_key = s.user_email WHERE u.is_owner = 0 AND s.status = 'active' AND s.plan IN ('starter', 'pro')) AS paid_accounts
  `).bind(activeSince).first<MetricRow>();
  const latestReminderRun = await db.prepare(`SELECT date_key, delivery_slot, started_at, finished_at,
    checked_subscriptions, sent_notifications, failed_notifications, removed_subscriptions, status, error_message
    FROM reminder_job_runs ORDER BY started_at DESC, id DESC LIMIT 1`).first<ReminderRunRow>();

  const where: string[] = ["u.is_owner = 0"];
  const values: unknown[] = [];
  if (query) {
    where.push("(LOWER(u.display_name) LIKE ? OR LOWER(u.email) LIKE ?)");
    const search = `%${query.toLowerCase()}%`;
    values.push(search, search);
  }
  if (filter === "active") {
    where.push("u.last_activity_at >= ?");
    values.push(activeSince);
  } else if (filter === "inactive") {
    where.push("(u.last_activity_at IS NULL OR u.last_activity_at < ?)");
    values.push(activeSince);
  } else if (filter === "unverified") {
    where.push("u.email_verified_at IS NULL");
  } else if (filter === "paid") {
    where.push("s.status = 'active' AND s.plan IN ('starter', 'pro')");
  } else if (filter === "trial") {
    where.push("COALESCE(s.plan, 'trial') = 'trial'");
  }

  const whereSql = where.join(" AND ");
  const countRow = await db.prepare(`SELECT COUNT(*) AS count
    FROM users u LEFT JOIN subscriptions s ON s.user_email = u.storage_key
    WHERE ${whereSql}`).bind(...values).first<{ count: number }>();
  const total = numberValue(countRow?.count);
  const offset = (page - 1) * pageSize;

  const businessRows = await db.prepare(`SELECT
      u.id, u.display_name, u.email, u.email_verified_at, u.created_at, u.last_login_at, u.last_activity_at,
      COALESCE(s.plan, 'trial') AS plan,
      COALESCE(s.status, 'trial') AS plan_status,
      (SELECT COUNT(*) FROM customers c WHERE c.owner_user_id = u.id) AS customer_count,
      (SELECT COUNT(*) FROM customers c WHERE c.owner_user_id = u.id AND c.billing_cycle = 'monthly') AS monthly_customers,
      (SELECT COALESCE(SUM(pd.amount_due - pd.amount_paid), 0) FROM payment_dues pd WHERE pd.owner_user_id = u.id AND pd.status != 'paid') AS outstanding_amount,
      (SELECT COALESCE(SUM(pt.amount), 0) FROM payment_transactions pt WHERE pt.owner_user_id = u.id) AS collected_amount,
      (SELECT COUNT(*) FROM push_subscriptions ps WHERE ps.owner_key = u.storage_key) AS reminder_devices,
      (SELECT bpa.status FROM business_payment_accounts bpa WHERE bpa.owner_user_id = u.id AND bpa.provider = 'razorpay_route' AND bpa.mode = 'test' LIMIT 1) AS payment_account_status,
      (SELECT bpa.provider_account_id FROM business_payment_accounts bpa WHERE bpa.owner_user_id = u.id AND bpa.provider = 'razorpay_route' AND bpa.mode = 'test' LIMIT 1) AS provider_account_id
    FROM users u
    LEFT JOIN subscriptions s ON s.user_email = u.storage_key
    WHERE ${whereSql}
    ORDER BY COALESCE(u.last_activity_at, u.last_login_at, u.created_at) DESC, u.id DESC
    LIMIT ? OFFSET ?`).bind(...values, pageSize, offset).all<BusinessRow>();

  const paymentReviews = await db.prepare("SELECT payment_id, razorpay_order_id, owner_user_id, invoice_id, amount, status, error_message FROM razorpay_captures WHERE status != 'applied' AND NOT EXISTS (SELECT 1 FROM payment_reconciliations r WHERE r.payment_id = razorpay_captures.payment_id) ORDER BY created_at DESC LIMIT 50").all<{ payment_id: string; razorpay_order_id: string; owner_user_id: number; invoice_id: number; amount: number; status: string; error_message: string }>();
  return {
    paymentReviews: paymentReviews.results,
    paymentReconciliations: (await db.prepare("SELECT payment_id, refund_id, actor_user_id, note, created_at FROM payment_reconciliations ORDER BY created_at DESC LIMIT 50").all<{ payment_id: string; refund_id: string; actor_user_id: number; note: string; created_at: number }>()).results,
    recoveryOrders: (await db.prepare("SELECT id, owner_user_id, invoice_id, amount, status, error_message FROM razorpay_orders WHERE status IN ('creating','created') ORDER BY created_at ASC LIMIT 50").all<{ id: number; owner_user_id: number; invoice_id: number; amount: number; status: string; error_message: string }>()).results,
    metrics: {
      totalBusinesses: numberValue(metrics?.total_businesses),
      verifiedBusinesses: numberValue(metrics?.verified_businesses),
      activeBusinesses: numberValue(metrics?.active_businesses),
      totalCustomers: numberValue(metrics?.total_customers),
      monthlyCustomers: numberValue(metrics?.monthly_customers),
      outstandingAmount: numberValue(metrics?.outstanding_amount),
      collectedAmount: numberValue(metrics?.collected_amount),
      reminderBusinesses: numberValue(metrics?.reminder_businesses),
      paidAccounts: numberValue(metrics?.paid_accounts),
    },
    businesses: businessRows.results.map((row) => ({
      id: numberValue(row.id),
      displayName: String(row.display_name),
      email: String(row.email),
      verified: row.email_verified_at !== null,
      createdAt: numberValue(row.created_at),
      lastLoginAt: row.last_login_at === null ? null : numberValue(row.last_login_at),
      lastActivityAt: row.last_activity_at === null ? null : numberValue(row.last_activity_at),
      plan: row.plan,
      planStatus: row.plan_status,
      customerCount: numberValue(row.customer_count),
      monthlyCustomers: numberValue(row.monthly_customers),
      outstandingAmount: numberValue(row.outstanding_amount),
      collectedAmount: numberValue(row.collected_amount),
      reminderDevices: numberValue(row.reminder_devices),
      paymentAccountStatus: row.payment_account_status || "pending",
      paymentAccountId: String(row.provider_account_id || ""),
    })),
    pagination: {
      page,
      pageSize,
      total,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    },
    filters: { query, filter },
    reminderAutomation: latestReminderRun ? {
      dateKey: String(latestReminderRun.date_key),
      deliverySlot: String(latestReminderRun.delivery_slot),
      startedAt: numberValue(latestReminderRun.started_at),
      finishedAt: latestReminderRun.finished_at === null ? null : numberValue(latestReminderRun.finished_at),
      checkedSubscriptions: numberValue(latestReminderRun.checked_subscriptions),
      sentNotifications: numberValue(latestReminderRun.sent_notifications),
      failedNotifications: numberValue(latestReminderRun.failed_notifications),
      removedSubscriptions: numberValue(latestReminderRun.removed_subscriptions),
      status: latestReminderRun.status,
      errorMessage: String(latestReminderRun.error_message || ""),
    } : null,
    generatedAt: Date.now(),
  };
}
