import webpush from "web-push";
import { ensurePaymentLedgerTables, ensurePushTables, getSqlDatabase } from "../db";

type PushRow = {
  subscription_id: number;
  owner_key: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  extra_reminder_times: string;
};

type DueCustomerRow = {
  due_id: number;
  id: number;
  name: string;
  phone: string;
  amount: number;
  amount_paid: number;
  follow_up_date: string;
  requirement: string;
};

type PushSender = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: { TTL: number; urgency: "high" },
) => Promise<unknown>;

export function indiaDateKey(timestamp = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

export function indiaHour(timestamp = Date.now()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

const compulsoryReminderHours = new Set(["09", "11", "13", "15", "17", "19", "21"]);
const staleClaimMs = 15 * 60 * 1000;

function dueDateLabel(value: string) {
  const parsed = new Date(`${value}T00:00:00+05:30`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(parsed);
}

function pushStatusCode(error: unknown) {
  if (error instanceof webpush.WebPushError) return error.statusCode;
  if (typeof error === "object" && error && "statusCode" in error) return Number(error.statusCode) || 0;
  return 0;
}

export async function runDueReminderJob(
  timestamp: number,
  deliverySlot: string,
  scheduledHour: string,
  sendNotification: PushSender,
) {
  await Promise.all([ensurePaymentLedgerTables(), ensurePushTables()]);
  const db = getSqlDatabase();
  const dateKey = indiaDateKey(timestamp);
  const currentHour = scheduledHour;
  const startedAt = Date.now();
  const job = await db.prepare(`INSERT INTO reminder_job_runs
    (date_key, delivery_slot, started_at, status) VALUES (?, ?, ?, 'running')`)
    .bind(dateKey, deliverySlot, startedAt).run();
  const jobId = job.meta.last_row_id;
  let checked = 0;
  let sent = 0;
  let failed = 0;
  let removedSubscriptions = 0;

  try {
    await db.prepare("DELETE FROM push_delivery_claims WHERE claimed_at < ?")
      .bind(startedAt - staleClaimMs).run();
    const { results } = await db.prepare(`SELECT
        ps.id AS subscription_id, ps.owner_key, ps.endpoint, ps.p256dh, ps.auth, ps.extra_reminder_times
      FROM push_subscriptions ps
      LEFT JOIN push_delivery_slots pds ON pds.subscription_id = ps.id
        AND pds.date_key = ? AND pds.delivery_slot = ?
      WHERE pds.id IS NULL AND EXISTS (SELECT 1 FROM customers due
        JOIN payment_dues pd ON pd.customer_id = due.id AND pd.owner_user_id = due.owner_user_id
        WHERE due.owner_email = ps.owner_key AND pd.due_date <= ?
          AND pd.status != 'paid' AND pd.amount_paid < pd.amount_due)`)
      .bind(dateKey, deliverySlot, dateKey).all<PushRow>();

    const eligibleResults = results.filter((row) => compulsoryReminderHours.has(currentHour)
      || String(row.extra_reminder_times || "").split(",").includes(currentHour));
    checked = eligibleResults.length;

    for (const row of eligibleResults) {
      const claim = await db.prepare(`INSERT OR IGNORE INTO push_delivery_claims
        (subscription_id, date_key, delivery_slot, claimed_at) VALUES (?, ?, ?, ?)`)
        .bind(row.subscription_id, dateKey, deliverySlot, Date.now()).run();
      if (claim.meta.changes !== 1) continue;

      const { results: dueCustomers } = await db.prepare(`SELECT pd.id AS due_id, c.id, c.name, c.phone,
        pd.amount_due AS amount, pd.amount_paid, pd.due_date AS follow_up_date, c.requirement
        FROM customers c JOIN payment_dues pd ON pd.customer_id = c.id AND pd.owner_user_id = c.owner_user_id
        WHERE c.owner_email = ? AND pd.due_date <= ? AND pd.status != 'paid'
          AND pd.amount_paid < pd.amount_due
          AND NOT EXISTS (SELECT 1 FROM push_delivery_items pdi
            WHERE pdi.subscription_id = ? AND pdi.due_id = pd.id
              AND pdi.date_key = ? AND pdi.delivery_slot = ?)
        ORDER BY pd.due_date, c.id`)
        .bind(row.owner_key, dateKey, row.subscription_id, dateKey, deliverySlot).all<DueCustomerRow>();
      let subscriptionFailed = false;

      for (const customer of dueCustomers) {
        const digits = String(customer.phone || "").replace(/\D/g, "");
        const whatsappPhone = digits.length === 10 ? `91${digits}` : digits;
        const amount = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 })
          .format(Math.max(0, Number(customer.amount || 0) - Number(customer.amount_paid || 0)));
        const dueDate = dueDateLabel(customer.follow_up_date);
        const reason = String(customer.requirement || "").trim();
        const notification = {
          title: "YaadRakho Payment Reminder",
          body: `${customer.name}'s ${amount} payment is pending. Due date: ${dueDate}.${reason ? ` For: ${reason}.` : ""}`,
          tag: `yaadrakho-due-${customer.due_id}`,
          customerId: customer.id,
          url: `/?customer=${customer.id}`,
          callUrl: digits ? `tel:${customer.phone}` : "",
          whatsappUrl: whatsappPhone ? `https://wa.me/${whatsappPhone}` : "",
        };

        try {
          await sendNotification({
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth },
          }, JSON.stringify(notification), { TTL: 60 * 60, urgency: "high" });
          await db.prepare(`INSERT OR IGNORE INTO push_delivery_items
            (subscription_id, due_id, date_key, delivery_slot, sent_at) VALUES (?, ?, ?, ?, ?)`)
            .bind(row.subscription_id, customer.due_id, dateKey, deliverySlot, Date.now()).run();
          sent += 1;
        } catch (error) {
          failed += 1;
          const statusCode = pushStatusCode(error);
          if (statusCode === 404 || statusCode === 410) {
            await db.batch([
              db.prepare("DELETE FROM push_delivery_items WHERE subscription_id = ?").bind(row.subscription_id),
              db.prepare("DELETE FROM push_delivery_claims WHERE subscription_id = ?").bind(row.subscription_id),
              db.prepare("DELETE FROM push_delivery_slots WHERE subscription_id = ?").bind(row.subscription_id),
              db.prepare("DELETE FROM push_deliveries WHERE subscription_id = ?").bind(row.subscription_id),
              db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(row.subscription_id),
            ]);
            removedSubscriptions += 1;
          } else {
            await db.prepare(`DELETE FROM push_delivery_claims
              WHERE subscription_id = ? AND date_key = ? AND delivery_slot = ?`)
              .bind(row.subscription_id, dateKey, deliverySlot).run();
            console.error("YaadRakho push delivery failed", statusCode, error);
          }
          subscriptionFailed = true;
          break;
        }
      }

      if (!subscriptionFailed) {
        await db.batch([
          db.prepare(`INSERT OR IGNORE INTO push_delivery_slots
            (subscription_id, date_key, delivery_slot, sent_at) VALUES (?, ?, ?, ?)`)
            .bind(row.subscription_id, dateKey, deliverySlot, Date.now()),
          db.prepare(`DELETE FROM push_delivery_claims
            WHERE subscription_id = ? AND date_key = ? AND delivery_slot = ?`)
            .bind(row.subscription_id, dateKey, deliverySlot),
        ]);
      }
    }

    const cutoff = indiaDateKey(timestamp - 45 * 24 * 60 * 60 * 1000);
    await db.batch([
      db.prepare("DELETE FROM push_deliveries WHERE date_key < ?").bind(cutoff),
      db.prepare("DELETE FROM push_delivery_slots WHERE date_key < ?").bind(cutoff),
      db.prepare("DELETE FROM push_delivery_claims WHERE date_key < ?").bind(cutoff),
      db.prepare("DELETE FROM push_delivery_items WHERE date_key < ?").bind(cutoff),
      db.prepare("DELETE FROM reminder_job_runs WHERE started_at < ?").bind(timestamp - 90 * 24 * 60 * 60 * 1000),
    ]);
    await db.prepare(`UPDATE reminder_job_runs SET finished_at = ?, checked_subscriptions = ?,
      sent_notifications = ?, failed_notifications = ?, removed_subscriptions = ?, status = ?, error_message = ?
      WHERE id = ?`).bind(Date.now(), checked, sent, failed, removedSubscriptions, failed > removedSubscriptions ? 'failed' : 'completed', failed > removedSubscriptions ? 'Some deliveries failed; retry this delivery slot.' : '', jobId).run();
    return { checked, sent, failed, removedSubscriptions, dateKey, deliverySlot };
  } catch (error) {
    await db.prepare(`UPDATE reminder_job_runs SET finished_at = ?, checked_subscriptions = ?,
      sent_notifications = ?, failed_notifications = ?, removed_subscriptions = ?, status = 'failed', error_message = ?
      WHERE id = ?`).bind(Date.now(), checked, sent, failed, removedSubscriptions,
      error instanceof Error ? error.message.slice(0, 500) : "Reminder job failed", jobId).run();
    throw error;
  }
}

export async function sendDueReminders(timestamp: number, deliverySlot: string, scheduledHour = indiaHour(timestamp)) {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) throw new Error("VAPID notification keys are not configured");
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return runDueReminderJob(timestamp, deliverySlot, scheduledHour,
    (subscription, payload, options) => webpush.sendNotification(subscription, payload, options));
}
