import { ensurePushTables, getSqlDatabase } from "../../../db";
import { getCurrentUser } from "../../auth";
import webpush from "web-push";

type PushPayload = {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
  extraReminderTimes?: unknown;
};

const allowedExtraTimes = new Set(["09", "12", "15", "18", "21"]);

function validExtraTimes(value: unknown) {
  if (!Array.isArray(value)) return "";
  return [...new Set(value.map(String).filter((time) => allowedExtraTimes.has(time)))].sort().join(",");
}

function runtime() {
  return {
    DB: getSqlDatabase(),
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT,
    CRON_SECRET: process.env.CRON_SECRET,
  };
}

function validSubscription(value: PushPayload) {
  const endpoint = String(value.endpoint || "").trim();
  const p256dh = String(value.keys?.p256dh || "").trim();
  const auth = String(value.keys?.auth || "").trim();
  if (!endpoint.startsWith("https://") || !p256dh || !auth || endpoint.length > 2048) {
    throw new Error("This notification subscription is invalid");
  }
  return { endpoint, p256dh, auth };
}

function pushStatusCode(error: unknown) {
  if (error instanceof webpush.WebPushError) return error.statusCode;
  if (typeof error === "object" && error && "statusCode" in error) return Number(error.statusCode) || 0;
  return 0;
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
  const keys = runtime();
  if (!keys.VAPID_PUBLIC_KEY || !keys.VAPID_PRIVATE_KEY || !keys.VAPID_SUBJECT) {
    return Response.json({ error: "Background notification keys are not configured yet" }, { status: 503 });
  }
  if (!keys.CRON_SECRET) {
    return Response.json({ error: "The automatic reminder scheduler is not configured yet" }, { status: 503 });
  }
  return Response.json({ publicKey: keys.VAPID_PUBLIC_KEY, schedulerConfigured: true });
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
    const keys = runtime();
    if (!keys.VAPID_PUBLIC_KEY || !keys.VAPID_PRIVATE_KEY || !keys.VAPID_SUBJECT || !keys.CRON_SECRET) {
      return Response.json({ error: "Automatic reminders are not configured on this server yet. You can still test notifications on this device." }, { status: 503 });
    }
    await ensurePushTables();
    const payload = await request.json() as PushPayload;
    const subscription = validSubscription(payload);
    const extraReminderTimes = validExtraTimes(payload.extraReminderTimes);
    const now = Date.now();
    const existing = await keys.DB.prepare("SELECT id, owner_key FROM push_subscriptions WHERE endpoint = ?")
      .bind(subscription.endpoint).first<{ id: number; owner_key: string }>();
    if (existing && existing.owner_key !== user.storageKey) {
      await keys.DB.batch([
        keys.DB.prepare("DELETE FROM push_delivery_items WHERE subscription_id = ?").bind(existing.id),
        keys.DB.prepare("DELETE FROM push_delivery_claims WHERE subscription_id = ?").bind(existing.id),
        keys.DB.prepare("DELETE FROM push_delivery_slots WHERE subscription_id = ?").bind(existing.id),
        keys.DB.prepare("DELETE FROM push_deliveries WHERE subscription_id = ?").bind(existing.id),
      ]);
    }
    await keys.DB.prepare(`INSERT INTO push_subscriptions
      (owner_key, endpoint, p256dh, auth, extra_reminder_times, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET owner_key = excluded.owner_key,
      p256dh = excluded.p256dh, auth = excluded.auth,
      extra_reminder_times = excluded.extra_reminder_times, updated_at = excluded.updated_at`)
      .bind(user.storageKey, subscription.endpoint, subscription.p256dh, subscription.auth, extraReminderTimes, now, now).run();
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Notifications could not be enabled" }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
  await ensurePushTables();
  const { endpoint } = await request.json().catch(() => ({ endpoint: "" })) as { endpoint?: string };
  if (endpoint) {
    const keys = runtime();
    await keys.DB.batch([
      keys.DB.prepare("DELETE FROM push_delivery_items WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE owner_key = ? AND endpoint = ?)").bind(user.storageKey, endpoint),
      keys.DB.prepare("DELETE FROM push_delivery_claims WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE owner_key = ? AND endpoint = ?)").bind(user.storageKey, endpoint),
      keys.DB.prepare("DELETE FROM push_delivery_slots WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE owner_key = ? AND endpoint = ?)").bind(user.storageKey, endpoint),
      keys.DB.prepare("DELETE FROM push_deliveries WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE owner_key = ? AND endpoint = ?)").bind(user.storageKey, endpoint),
      keys.DB.prepare("DELETE FROM push_subscriptions WHERE owner_key = ? AND endpoint = ?").bind(user.storageKey, endpoint),
    ]);
  }
  return new Response(null, { status: 204 });
}

export async function PUT() {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
    await ensurePushTables();
    const keys = runtime();
    if (!keys.VAPID_PUBLIC_KEY || !keys.VAPID_PRIVATE_KEY || !keys.VAPID_SUBJECT) {
      return Response.json({ error: "Background reminders are not configured yet" }, { status: 503 });
    }
    const { results } = await keys.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE owner_key = ?")
      .bind(user.storageKey).all<{ endpoint: string; p256dh: string; auth: string }>();
    if (!results.length) return Response.json({ error: "Turn on automatic reminders first" }, { status: 400 });
    webpush.setVapidDetails(keys.VAPID_SUBJECT, keys.VAPID_PUBLIC_KEY, keys.VAPID_PRIVATE_KEY);
    let delivered = 0;
    let removed = 0;
    let lastError: unknown = null;
    for (const subscription of results) {
      try {
        await webpush.sendNotification({
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        }, JSON.stringify({
          title: "YaadRakho Test Reminder",
          body: "Background payment reminders are working on this phone.",
          tag: `yaadrakho-test-${Date.now()}`,
          url: "/",
        }), { TTL: 60, urgency: "high" });
        delivered += 1;
      } catch (error) {
        const statusCode = pushStatusCode(error);
        if (statusCode === 404 || statusCode === 410) {
          await keys.DB.batch([
            keys.DB.prepare("DELETE FROM push_delivery_items WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE owner_key = ? AND endpoint = ?)").bind(user.storageKey, subscription.endpoint),
            keys.DB.prepare("DELETE FROM push_delivery_claims WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE owner_key = ? AND endpoint = ?)").bind(user.storageKey, subscription.endpoint),
            keys.DB.prepare("DELETE FROM push_delivery_slots WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE owner_key = ? AND endpoint = ?)").bind(user.storageKey, subscription.endpoint),
            keys.DB.prepare("DELETE FROM push_deliveries WHERE subscription_id IN (SELECT id FROM push_subscriptions WHERE owner_key = ? AND endpoint = ?)").bind(user.storageKey, subscription.endpoint),
            keys.DB.prepare("DELETE FROM push_subscriptions WHERE owner_key = ? AND endpoint = ?").bind(user.storageKey, subscription.endpoint),
          ]);
          removed += 1;
        } else {
          lastError = error;
          console.error("YaadRakho test push failed", statusCode, error);
        }
      }
    }
    if (delivered === 0 && lastError) throw lastError;
    return Response.json({ ok: delivered > 0, delivered, removed });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Test notification could not be sent" }, { status: 500 });
  }
}
