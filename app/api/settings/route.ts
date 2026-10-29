import { eq } from "drizzle-orm";
import { ensureAppSettingsTable, getDb } from "../../../db";
import { appSettings } from "../../../db/schema";
import { getCurrentUser } from "../../auth";

import { getBusinessPaymentAccountStatus } from "../../../db/razorpay";
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
  await ensureAppSettingsTable();
  const [settings] = await getDb().select().from(appSettings).where(eq(appSettings.userEmail, user.storageKey)).limit(1);
  const paymentAccount = await getBusinessPaymentAccountStatus(user.id);
  return Response.json({ settings: settings ? { ...settings, userEmail: user.email } : { userEmail: user.email, businessName: user.displayName, phone: "", updatedAt: Date.now() }, paymentAccount });
}

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
  await ensureAppSettingsTable();
  const payload = await request.json() as { businessName?: unknown; phone?: unknown };
  const businessName = String(payload.businessName || "").trim().slice(0, 100);
  const phone = String(payload.phone || "").trim().slice(0, 30);
  if (!businessName) return Response.json({ error: "Business or owner name is required" }, { status: 400 });
  const now = Date.now();
  const db = getDb();
  const [existing] = await db.select().from(appSettings).where(eq(appSettings.userEmail, user.storageKey)).limit(1);
  const [settings] = existing
    ? await db.update(appSettings).set({ businessName, phone, updatedAt: now }).where(eq(appSettings.id, existing.id)).returning()
    : await db.insert(appSettings).values({ userEmail: user.storageKey, businessName, phone, updatedAt: now }).returning();
  return Response.json({ settings: { ...settings, userEmail: user.email } });
}
