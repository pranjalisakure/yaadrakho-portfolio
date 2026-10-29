import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const target = resolve("backups/yaadrakho-reminders-test.db");
await rm(target, { force: true });
process.env.TURSO_DATABASE_URL = `file:${target.replaceAll("\\", "/")}`;
delete process.env.TURSO_AUTH_TOKEN;

const { ensurePaymentLedgerTables, ensurePushTables, getClient } = await import("../db/index");
const { runDueReminderJob } = await import("../app/push-reminders");
await Promise.all([ensurePaymentLedgerTables(), ensurePushTables()]);

const client = getClient();
const now = Date.now();
const user = await client.execute({
  sql: `INSERT INTO users
    (email, display_name, storage_key, password_salt, password_hash, recovery_salt, recovery_hash,
      is_owner, email_verified_at, created_at, updated_at)
    VALUES ('mess@example.test', 'Mess Owner', 'account:mess', 's', 'h', 's', 'h', 0, ?, ?, ?)`,
  args: [now, now, now],
});
const ownerUserId = Number(user.lastInsertRowid);

async function addCustomer(name: string, phone: string, amount: number) {
  const customer = await client.execute({
    sql: `INSERT INTO customers
      (owner_email, owner_user_id, current_due_id, name, phone, requirement, amount, follow_up_date,
        status, payment_status, billing_cycle, recurring_day, notes, contact_consent, created_at, updated_at)
      VALUES ('account:mess', ?, NULL, ?, ?, 'Monthly mess fee', ?, '2026-07-19',
        'follow_up', 'pending', 'monthly', 19, '', 1, ?, ?)`,
    args: [ownerUserId, name, phone, amount, now, now],
  });
  const customerId = Number(customer.lastInsertRowid);
  const due = await client.execute({
    sql: `INSERT INTO payment_dues
      (owner_user_id, owner_key, customer_id, period_key, due_date, amount_due, amount_paid,
        status, paid_at, created_at, updated_at)
      VALUES (?, 'account:mess', ?, ?, '2026-07-19', ?, 0, 'pending', NULL, ?, ?)`,
    args: [ownerUserId, customerId, `2026-07:${customerId}`, amount, now, now],
  });
  const dueId = Number(due.lastInsertRowid);
  await client.execute({ sql: "UPDATE customers SET current_due_id = ? WHERE id = ?", args: [dueId, customerId] });
  return { customerId, dueId };
}

const first = await addCustomer("Student One", "9999999991", 1000);
const second = await addCustomer("Student Two", "9999999992", 500);
const subscription = await client.execute({
  sql: `INSERT INTO push_subscriptions
    (owner_key, endpoint, p256dh, auth, extra_reminder_times, created_at, updated_at)
    VALUES ('account:mess', 'https://push.example.test/device', 'key', 'auth', '12', ?, ?)`,
  args: [now, now],
});
const subscriptionId = Number(subscription.lastInsertRowid);

const timestamp = Date.parse("2026-07-19T03:30:00Z");
const deliveredNames: string[] = [];
let failSecondOnce = true;
const sender = async (_subscription: unknown, payload: string) => {
  const notification = JSON.parse(payload) as { body: string };
  if (notification.body.includes("Student Two") && failSecondOnce) {
    failSecondOnce = false;
    throw new Error("Temporary push provider failure");
  }
  deliveredNames.push(notification.body.includes("Student One") ? "Student One" : "Student Two");
};

const originalConsoleError = console.error;
console.error = () => {};
const partialRun = await runDueReminderJob(timestamp, "hour-09", "09", sender);
console.error = originalConsoleError;
assert.equal(partialRun.checked, 1);
assert.equal(partialRun.sent, 1);
assert.equal(partialRun.failed, 1);
assert.deepEqual(deliveredNames, ["Student One"]);

const retryRun = await runDueReminderJob(timestamp, "hour-09", "09", sender);
assert.equal(retryRun.checked, 1);
assert.equal(retryRun.sent, 1, "retry must send only the customer that previously failed");
assert.equal(retryRun.failed, 0);
assert.deepEqual(deliveredNames, ["Student One", "Student Two"], "already delivered customer must not be duplicated");

const duplicateRun = await runDueReminderJob(timestamp, "hour-09", "09", sender);
assert.equal(duplicateRun.checked, 0);
assert.equal(duplicateRun.sent, 0);
const deliveryItems = await client.execute({
  sql: "SELECT COUNT(*) AS count FROM push_delivery_items WHERE subscription_id = ? AND delivery_slot = 'hour-09'",
  args: [subscriptionId],
});
assert.equal(Number(deliveryItems.rows[0]?.count), 2);

await client.execute({
  sql: "UPDATE payment_dues SET amount_paid = amount_due, status = 'paid', paid_at = ? WHERE id IN (?, ?)",
  args: [now, first.dueId, second.dueId],
});
const paidRun = await runDueReminderJob(timestamp, "hour-11", "11", sender);
assert.equal(paidRun.checked, 0, "paid dues must never create reminders");
assert.equal(paidRun.sent, 0);

await client.execute({
  sql: "UPDATE payment_dues SET amount_paid = 0, status = 'pending', paid_at = NULL WHERE id = ?",
  args: [second.dueId],
});
const selectedTimeRun = await runDueReminderJob(timestamp, "hour-12", "12", sender);
assert.equal(selectedTimeRun.checked, 1, "selected extra reminder time must be eligible");
assert.equal(selectedTimeRun.sent, 1);
const unselectedTimeRun = await runDueReminderJob(timestamp, "hour-18", "18", sender);
assert.equal(unselectedTimeRun.checked, 0, "unselected optional reminder time must not send");

const completedRuns = await client.execute({ sql: "SELECT COUNT(*) AS count FROM reminder_job_runs WHERE status = 'completed'", args: [] });
assert.equal(Number(completedRuns.rows[0]?.count), 5);
const failedRuns = await client.execute("SELECT COUNT(*) AS count FROM reminder_job_runs WHERE status = 'failed'");
assert.equal(Number(failedRuns.rows[0]?.count), 1);

console.log(JSON.stringify({
  result: "ok",
  firstRun: partialRun,
  retryRun,
  duplicateRun,
  paidRun,
  selectedTimeRun,
  unselectedTimeRun,
}));
await client.close();
