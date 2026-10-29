import { desc, eq } from "drizzle-orm";
import { getCurrentUser } from "../../auth";
import { PAYMENTS_ENABLED, PLAN_DETAILS } from "../../billing-config";
import { getOrCreateSubscription } from "../../../db/billing";
import { ensureSubscriptionsTable, getDb } from "../../../db";
import { subscriptions } from "../../../db/schema";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
  const subscription = await getOrCreateSubscription(user.storageKey, user.isOwner);
  const requests = user.isOwner
    ? await getDb().select().from(subscriptions).where(eq(subscriptions.status, "pending")).orderBy(desc(subscriptions.requestedAt))
    : [];
  return Response.json({ subscription, requests, isAdmin: user.isOwner });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
  if (!PAYMENTS_ENABLED) return Response.json({ error: "Paid upgrades are not open yet. Please continue using YaadRakho free during development." }, { status: 503 });
  const payload = await request.json() as { plan?: string };
  if (payload.plan !== "starter" && payload.plan !== "pro") return Response.json({ error: "Choose a valid plan" }, { status: 400 });
  const current = await getOrCreateSubscription(user.storageKey, user.isOwner);
  const now = Date.now();
  const [subscription] = await getDb().update(subscriptions).set({
    plan: payload.plan,
    status: "pending",
    price: PLAN_DETAILS[payload.plan].price,
    requestedAt: now,
    activatedAt: null,
    updatedAt: now,
  }).where(eq(subscriptions.id, current.id)).returning();
  return Response.json({ subscription });
}

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user?.isOwner) return Response.json({ error: "Administrator access required" }, { status: 403 });
  await ensureSubscriptionsTable();
  const payload = await request.json() as { id?: number };
  if (!Number.isInteger(payload.id)) return Response.json({ error: "Invalid request" }, { status: 400 });
  const now = Date.now();
  const [subscription] = await getDb().update(subscriptions).set({ status: "active", activatedAt: now, updatedAt: now }).where(eq(subscriptions.id, payload.id!)).returning();
  if (!subscription) return Response.json({ error: "Subscription request not found" }, { status: 404 });
  return Response.json({ subscription });
}
