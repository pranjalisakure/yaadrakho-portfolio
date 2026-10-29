import { eq } from "drizzle-orm";
import { PLAN_DETAILS } from "../app/billing-config";
import { ensureSubscriptionsTable, getDb } from ".";
import { subscriptions } from "./schema";

const TRIAL_LENGTH_MS = 15 * 24 * 60 * 60 * 1000;

export async function getOrCreateSubscription(storageKey: string, isOwner = false) {
  await ensureSubscriptionsTable();
  const db = getDb();
  const [existing] = await db.select().from(subscriptions).where(eq(subscriptions.userEmail, storageKey)).limit(1);
  if (existing) {
    const upgradedTrialEnd = existing.updatedAt + TRIAL_LENGTH_MS;
    if (existing.status === "trial" && existing.trialEndsAt < upgradedTrialEnd) {
      const [updated] = await db.update(subscriptions).set({ trialEndsAt: upgradedTrialEnd }).where(eq(subscriptions.id, existing.id)).returning();
      return updated;
    }
    return existing;
  }

  const now = Date.now();
  const [created] = await db.insert(subscriptions).values({
    userEmail: storageKey,
    plan: isOwner ? "pro" : "trial",
    status: isOwner ? "active" : "trial",
    price: isOwner ? PLAN_DETAILS.pro.price : 0,
    trialEndsAt: now + TRIAL_LENGTH_MS,
    activatedAt: isOwner ? now : null,
    updatedAt: now,
  }).returning();
  return created;
}
