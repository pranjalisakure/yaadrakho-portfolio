import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve("backups/yaadrakho-admin-analytics-test.db");
await rm(target, { force: true });
process.env.TURSO_DATABASE_URL = `file:${target.replaceAll("\\", "/")}`;
delete process.env.TURSO_AUTH_TOKEN;

const { ensurePaymentLedgerTables, ensurePushTables, ensureSubscriptionsTable, getClient } = await import("../db/index");
const { getAdminOverview } = await import("../db/admin-analytics");
await Promise.all([ensurePaymentLedgerTables(), ensurePushTables(), ensureSubscriptionsTable()]);

const client = getClient();
const now = Date.now();

async function addUser(displayName: string, email: string, storageKey: string, options: { owner?: boolean; verified?: boolean; active?: boolean } = {}) {
  const result = await client.execute({
    sql: `INSERT INTO users
      (email, display_name, storage_key, password_salt, password_hash, recovery_salt, recovery_hash, is_owner,
        email_verified_at, last_login_at, last_activity_at, created_at, updated_at)
      VALUES (?, ?, ?, 's', 'h', 's', 'h', ?, ?, ?, ?, ?, ?)`,
    args: [email, displayName, storageKey, options.owner ? 1 : 0, options.verified ? now : null, options.active ? now : null, options.active ? now : null, now, now],
  });
  return Number(result.lastInsertRowid);
}

const ownerId = await addUser("YaadRakho Owner", "owner@example.test", "account:owner", { owner: true, verified: true, active: true });
const activeId = await addUser("Active Mess", "active@example.test", "account:active", { verified: true, active: true });
const inactiveId = await addUser("New Store", "new@example.test", "account:new");

await client.batch([
  { sql: "INSERT INTO subscriptions (user_email, plan, status, price, trial_ends_at, activated_at, updated_at) VALUES (?, 'starter', 'active', 299, ?, ?, ?)", args: ["account:active", now, now, now] },
  { sql: "INSERT INTO customers (owner_email, owner_user_id, name, phone, requirement, amount, follow_up_date, status, payment_status, billing_cycle, recurring_day, notes, contact_consent, created_at, updated_at) VALUES (?, ?, 'Student A', '9999999999', 'Mess fee', 1000, '2026-07-19', 'follow_up', 'partial', 'monthly', 19, '', 1, ?, ?)", args: ["account:active", activeId, now, now] },
  { sql: "INSERT INTO customers (owner_email, owner_user_id, name, phone, requirement, amount, follow_up_date, status, payment_status, billing_cycle, recurring_day, notes, contact_consent, created_at, updated_at) VALUES (?, ?, 'Buyer B', '8888888888', 'Goods', 300, '2026-07-19', 'new', 'pending', 'one_time', 19, '', 1, ?, ?)", args: ["account:new", inactiveId, now, now] },
]);

const customer = await client.execute({ sql: "SELECT id FROM customers WHERE owner_user_id = ? LIMIT 1", args: [activeId] });
const customerId = Number(customer.rows[0]?.id);
const due = await client.execute({
  sql: "INSERT INTO payment_dues (owner_user_id, owner_key, customer_id, period_key, due_date, amount_due, amount_paid, status, paid_at, created_at, updated_at) VALUES (?, ?, ?, '2026-07', '2026-07-19', 1000, 400, 'partial', NULL, ?, ?)",
  args: [activeId, "account:active", customerId, now, now],
});
await client.batch([
  { sql: "INSERT INTO payment_transactions (owner_user_id, owner_key, customer_id, due_id, idempotency_key, amount, method, reference, note, received_at, created_at) VALUES (?, ?, ?, ?, 'admin-test-payment', 400, 'upi', '', '', ?, ?)", args: [activeId, "account:active", customerId, Number(due.lastInsertRowid), now, now] },
  { sql: "INSERT INTO push_subscriptions (owner_key, endpoint, p256dh, auth, extra_reminder_times, created_at, updated_at) VALUES (?, 'https://push.example.test/active', 'key', 'auth', '', ?, ?)", args: ["account:active", now, now] },
  { sql: "INSERT INTO reminder_job_runs (date_key, delivery_slot, started_at, finished_at, checked_subscriptions, sent_notifications, failed_notifications, removed_subscriptions, status, error_message) VALUES ('2026-07-19', 'hour-09', ?, ?, 1, 2, 0, 0, 'completed', '')", args: [now - 1000, now] },
]);

const all = await getAdminOverview({ pageSize: 20 });
assert.equal(all.metrics.totalBusinesses, 2, "owner account must not be counted as a business");
assert.equal(all.metrics.verifiedBusinesses, 1);
assert.equal(all.metrics.activeBusinesses, 1);
assert.equal(all.metrics.totalCustomers, 2);
assert.equal(all.metrics.monthlyCustomers, 1);
assert.equal(all.metrics.outstandingAmount, 600);
assert.equal(all.metrics.collectedAmount, 400);
assert.equal(all.metrics.reminderBusinesses, 1);
assert.equal(all.metrics.paidAccounts, 1);
assert.equal(all.reminderAutomation?.status, "completed");
assert.equal(all.reminderAutomation?.sentNotifications, 2);
assert.equal(all.businesses.some((business) => business.id === ownerId), false, "owner must not appear in business results");

const search = await getAdminOverview({ query: "active mess", pageSize: 20 });
assert.equal(search.pagination.total, 1);
assert.equal(search.businesses[0]?.email, "active@example.test");
assert.equal(search.businesses[0]?.outstandingAmount, 600);
assert.equal(search.businesses[0]?.reminderDevices, 1);

const unverified = await getAdminOverview({ filter: "unverified", pageSize: 20 });
assert.equal(unverified.pagination.total, 1);
assert.equal(unverified.businesses[0]?.email, "new@example.test");

const paid = await getAdminOverview({ filter: "paid", pageSize: 20 });
assert.equal(paid.pagination.total, 1);
assert.equal(paid.businesses[0]?.plan, "starter");

console.log(JSON.stringify({ result: "ok", metrics: all.metrics, businesses: all.pagination.total }));
await client.close();
