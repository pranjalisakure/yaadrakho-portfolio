import { getCurrentUser } from "../../../auth";
import { recheckCapturedPayment, recoverPaymentOrder, reconcileRefundedCapture } from "../../../../db/razorpay";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in first" }, { status: 401 });
  if (!user.isOwner) return Response.json({ error: "Owner access required" }, { status: 403 });
  try {
    const payload = await request.json() as { paymentId?: unknown; action?: unknown; localOrderId?: unknown; refundId?: unknown; note?: unknown };
    const result = payload.action === "reconcile_refund"
      ? await reconcileRefundedCapture(user, String(payload.paymentId || ""), String(payload.refundId || ""), String(payload.note || ""))
      : payload.action === "recover_order"
      ? await recoverPaymentOrder(user, Number(payload.localOrderId))
      : await recheckCapturedPayment(user, String(payload.paymentId || ""));
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Payment could not be rechecked" }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }
}
