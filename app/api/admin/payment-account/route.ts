import { configureBusinessPaymentAccount, type PaymentAccountStatus } from "../../../../db/razorpay";
import { getCurrentUser } from "../../../auth";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
    if (!user.isOwner) return Response.json({ error: "Owner access required" }, { status: 403 });
    if (process.env.VERCEL_ENV === "production") {
      return Response.json({ error: "Payment account mapping is disabled in Production during Phase 8." }, { status: 403 });
    }
    const keyId = String(process.env.RAZORPAY_KEY_ID || "");
    if (!keyId.startsWith("rzp_test_")) {
      return Response.json({ error: "Only Razorpay Test Mode accounts can be mapped in this Preview." }, { status: 400 });
    }
    const payload = await request.json() as { ownerUserId?: unknown; providerAccountId?: unknown; status?: unknown };
    const ownerUserId = Number(payload.ownerUserId);
    if (!Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) {
      return Response.json({ error: "Select a valid business account." }, { status: 400 });
    }
    const status = String(payload.status || "pending") as PaymentAccountStatus;
    const paymentAccount = await configureBusinessPaymentAccount(ownerUserId, {
      providerAccountId: payload.providerAccountId,
      status,
    });
    return Response.json({ paymentAccount }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payment account could not be saved.";
    console.error("Preview payment account mapping failed", { message });
    return Response.json({ error: message }, { status: 400 });
  }
}
