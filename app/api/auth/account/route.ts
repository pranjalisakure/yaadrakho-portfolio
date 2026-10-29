import { ensureAppSettingsTable, ensureBillingTables, ensureCustomersTable, ensurePushTables, ensureRazorpayTables, ensureSubscriptionsTable } from "../../../../db";
import { deleteAccount, destroySession, getCurrentUser } from "../../../auth";

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Your session has ended. Sign in again." }, { status: 401 });
  const payload = await request.json() as Record<string, unknown>;
  const password = String(payload.password || "");
  if (!password) return Response.json({ error: "Enter your password to delete this account." }, { status: 400 });
  await Promise.all([ensureCustomersTable(), ensureSubscriptionsTable(), ensureAppSettingsTable(), ensurePushTables(), ensureBillingTables(), ensureRazorpayTables()]);
  try {
    if (!(await deleteAccount(user, password))) return Response.json({ error: "Password is incorrect. Account was not deleted." }, { status: 401 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Account could not be deleted" }, { status: 409 });
  }
  const cookie = await destroySession(request);
  return Response.json({ deleted: true }, { headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" } });
}
