/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import webpush from "web-push";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

type PushRow = {
  subscription_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  due_count: number;
  first_name: string;
  first_phone: string;
  first_amount: number;
  first_id: number;
};

function indiaDateKey(timestamp = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

async function sendDueReminders(env: Env, timestamp: number, deliverySlot: string) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return;

  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL, owner_key text NOT NULL,
      endpoint text NOT NULL UNIQUE, p256dh text NOT NULL, auth text NOT NULL,
      created_at integer NOT NULL, updated_at integer NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_deliveries (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL, subscription_id integer NOT NULL,
      date_key text NOT NULL, sent_at integer NOT NULL, UNIQUE(subscription_id, date_key))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS push_delivery_slots (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL, subscription_id integer NOT NULL,
      date_key text NOT NULL, delivery_slot text NOT NULL, sent_at integer NOT NULL,
      UNIQUE(subscription_id, date_key, delivery_slot))`),
  ]);

  const dateKey = indiaDateKey(timestamp);
  const { results } = await env.DB.prepare(`SELECT
      ps.id AS subscription_id, ps.endpoint, ps.p256dh, ps.auth,
      (SELECT COUNT(*) FROM customers due WHERE due.owner_email = ps.owner_key
        AND due.follow_up_date <= ? AND due.payment_status != 'paid'
        AND due.status NOT IN ('won', 'lost')) AS due_count,
      c.id AS first_id, c.name AS first_name, c.phone AS first_phone, c.amount AS first_amount
    FROM push_subscriptions ps
    INNER JOIN customers c ON c.id = (SELECT first_due.id FROM customers first_due
      WHERE first_due.owner_email = ps.owner_key AND first_due.follow_up_date <= ?
      AND first_due.payment_status != 'paid' AND first_due.status NOT IN ('won', 'lost')
      ORDER BY first_due.follow_up_date, first_due.id LIMIT 1)
    LEFT JOIN push_delivery_slots pds ON pds.subscription_id = ps.id
      AND pds.date_key = ? AND pds.delivery_slot = ?
    WHERE pds.id IS NULL`).bind(dateKey, dateKey, dateKey, deliverySlot).all<PushRow>();

  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  await Promise.all(results.map(async (row) => {
    const count = Number(row.due_count || 0);
    const more = count > 1 ? ` ${count - 1} aur payment pending hai.` : "";
    const digits = String(row.first_phone || "").replace(/\D/g, "");
    const whatsappPhone = digits.length === 10 ? `91${digits}` : digits;
    const amount = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Number(row.first_amount || 0));
    try {
      await webpush.sendNotification({
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      }, JSON.stringify({
        title: "YaadRakho Payment Reminder",
        body: `${row.first_name} ki ${amount} payment aaj due hai.${more}`,
        tag: `yaadrakho-${dateKey}-${deliverySlot}`,
        url: `/?customer=${row.first_id}`,
        callUrl: digits ? `tel:${row.first_phone}` : "",
        whatsappUrl: whatsappPhone ? `https://wa.me/${whatsappPhone}` : "",
      }), { TTL: 24 * 60 * 60, urgency: "high" });
      await env.DB.prepare(`INSERT OR IGNORE INTO push_delivery_slots
        (subscription_id, date_key, delivery_slot, sent_at) VALUES (?, ?, ?, ?)`)
        .bind(row.subscription_id, dateKey, deliverySlot, Date.now()).run();
    } catch (error) {
      const statusCode = error instanceof webpush.WebPushError ? error.statusCode : 0;
      if (statusCode === 404 || statusCode === 410) {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(row.subscription_id).run();
      } else {
        console.error("YaadRakho push delivery failed", statusCode, error);
      }
    }
  }));

  const cutoff = new Date(timestamp - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await env.DB.prepare("DELETE FROM push_deliveries WHERE date_key < ?").bind(cutoff).run();
  await env.DB.prepare("DELETE FROM push_delivery_slots WHERE date_key < ?").bind(cutoff).run();
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const indiaHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(new Date(controller.scheduledTime));
    const deliverySlot = `hour-${indiaHour}`;
    ctx.waitUntil(sendDueReminders(env, controller.scheduledTime, deliverySlot));
  },
};

export default worker;
