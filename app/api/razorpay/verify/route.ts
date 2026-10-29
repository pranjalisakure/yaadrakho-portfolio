import { verifyAndFinalizeCheckout } from "../../../../db/razorpay";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>;
    const orderId = String(payload.razorpay_order_id || "");
    const paymentId = String(payload.razorpay_payment_id || "");
    const signature = String(payload.razorpay_signature || "");
    if (!orderId || !paymentId || !signature) {
      return Response.json({ error: "Razorpay payment confirmation is incomplete." }, { status: 400 });
    }
    const result = await verifyAndFinalizeCheckout(orderId, paymentId, signature);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Razorpay checkout verification failed", error);
    return Response.json({
      error: error instanceof Error ? error.message : "Payment could not be verified.",
    }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
